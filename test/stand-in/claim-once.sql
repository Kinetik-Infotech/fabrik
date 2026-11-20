-- A claim takes at most the rows it asks for, even under the plan that once took more, and two claims never
-- take one row. run.sh runs it as supabase_admin, in a copy of a new build, outside one transaction. It ends
-- in a PASS notice, and a failure is an error.
--
-- Once saves leave dead rows in a table, autovacuum's statistics can lead PostgreSQL to run a claim's
-- LIMIT ... SKIP LOCKED subquery again for each row it updates. Each run skips the rows already locked and
-- takes the next, so claim_files(1) took two or three rows. The worker reads only the first, and the
-- others sat claimed, untried, for five minutes. This file makes that plan: dead rows, then tables their
-- statistics say hold one row, with autovacuum off for them, each row's id and place on disk in the order
-- its claim takes rows. A copy of each claim's old shape must take more than one row there. Then each claim
-- takes one row at a time until nothing waits.
--
-- Then two claims race for one row. Run B's claim stops in a gate, a row-level security policy that waits on
-- an advisory lock, after its statement began. Run A claims the first row and commits, and B goes on. A claim
-- that tested a view in a subquery read that row as B's statement began, and took it again. claim_files,
-- claim_chunks and claim_entities must each take the next row. claim_sentences tests its own row's columns
-- and is unchanged. Last, A retires the version of the first waiting chunk while B's claim_chunks waits in
-- the gate: B must take the other version's chunk, as claim_chunks locks the version and reads its state
-- again. The race's role is dropped at the end, since a role belongs to the whole cluster.
\set ON_ERROR_STOP on
alter table file_search.file_version set (autovacuum_enabled=false);
alter table file_search.chunk set (autovacuum_enabled=false);
alter table file_search.chunk_sentence set (autovacuum_enabled=false);
alter table file_search.entity set (autovacuum_enabled=false);
insert into storage.buckets(id, name) values ('claim_once', 'claim_once');
insert into file_search.indexed_bucket(bucket_id) values ('claim_once');

-- Dead rows: 1,100 queued versions whose files' upload was rolled back, with as many chunks, sentences and entities.
begin;
insert into storage.objects(bucket_id, name, metadata)
 select 'claim_once', 'dead/'||k, jsonb_build_object('eTag', 'd'||k) from generate_series(1, 1100) k;
insert into file_search.chunk(version_id, object_id, ordinal, body)
 select v.version_id, v.object_id, 0, 'Dead text.' from file_search.file_version v where v.bucket_id='claim_once';
insert into file_search.chunk_sentence(chunk_id, object_id, ordinal, body)
 select c.chunk_id, c.object_id, 0, 'Dead text.' from file_search.chunk c join file_search.file_version v using (version_id)
 where v.bucket_id='claim_once';
insert into file_search.entity(name, name_key, entity_type, type_key)
 select 'Dead '||k, 'dead '||k, 'thing', 'thing' from generate_series(1, 1100) k;
rollback;

-- Eight files, four record versions and twelve entities wait.
insert into storage.objects(bucket_id, name, metadata)
 select 'claim_once', 'file-'||k||'.md', jsonb_build_object('eTag', 'f'||k) from generate_series(1, 8) k;
insert into file_search.file_version(content_tag, bucket_id, name, record_id, record_version_id, version_number, body)
 select 'record', 'claim_once', 'Record '||k, gen_random_uuid(), gen_random_uuid(), 1, 'Record '||k||' text'
 from generate_series(1, 4) k;
insert into file_search.entity(name, name_key, entity_type, type_key)
 select 'Entity '||k, 'entity '||k, 'thing', 'thing' from generate_series(1, 12) k;

-- Ids in the order the claims take the rows, so the rows a rerun takes lie ahead of the update's scan.
update file_search.file_version v set version_id=('00000000-0000-4000-8000-'||lpad(o.k::text, 12, '0'))::uuid
 from (select version_id, row_number() over (order by queued_at) k from file_search.file_version where bucket_id='claim_once') o
 where v.version_id=o.version_id;
update file_search.entity e set entity_id=('00000000-0000-4000-8000-'||lpad(o.k::text, 12, '0'))::uuid
 from (select entity_id, row_number() over (order by created_at, entity_id) k from file_search.entity) o
 where e.entity_id=o.entity_id;

vacuum file_search.file_version;
vacuum file_search.chunk;
vacuum file_search.chunk_sentence;
vacuum file_search.entity;
-- The statistics autovacuum can leave: each table seen as holding one row.
update pg_class set reltuples=1 where oid in ('file_search.file_version'::regclass, 'file_search.entity'::regclass);

-- Each claim's old shape: the rows picked by a subquery inside the update.
create function pg_temp.old_claim_files(p_limit integer) returns setof uuid language sql as $$
 update file_search.file_version f set attempts=f.attempts+1, last_attempt_at=clock_timestamp()
 where (f.object_id is null or exists(select 1 from storage.objects o where o.id=f.object_id)) and f.version_id in (
  select w.version_id from file_search.file_version w
  where w.version_id in (select c.version_id from file_search.claimable_file c)
  order by w.queued_at limit p_limit for update skip locked)
 returning f.version_id
$$;
create function pg_temp.old_claim_chunks(p_limit integer) returns setof uuid language sql as $$
 update file_search.chunk c set attempts=c.attempts+1, last_attempt_at=clock_timestamp()
 where c.chunk_id in (
  select w.chunk_id from file_search.chunk w
  where w.chunk_id in (select c.chunk_id from file_search.claimable_chunk c)
  order by w.chunk_id limit p_limit for update of w skip locked)
 returning c.chunk_id
$$;
create function pg_temp.old_claim_sentences(p_limit integer) returns setof uuid language sql as $$
 update file_search.chunk_sentence s set attempts=s.attempts+1, last_attempt_at=clock_timestamp()
 where s.sentence_id in (
  select w.sentence_id from file_search.chunk_sentence w join file_search.chunk c on c.chunk_id=w.chunk_id
  where w.state='waiting' and c.state='embedded' and w.attempts<5
   and (w.last_attempt_at is null or w.last_attempt_at<clock_timestamp()-interval '5 minutes')
  order by w.last_attempt_at nulls first, w.chunk_id, w.ordinal limit p_limit for update of w skip locked)
 returning s.sentence_id
$$;
create function pg_temp.old_claim_entities(p_limit integer) returns setof uuid language sql as $$
 update file_search.entity e set attempts=e.attempts+1, last_attempt_at=clock_timestamp()
 where e.entity_id in (
  select w.entity_id from file_search.entity w
  where w.entity_id in (select c.entity_id from file_search.claimable_entity c)
  order by w.created_at, w.entity_id limit p_limit for update of w skip locked)
 returning e.entity_id
$$;

-- The old shape of a claim, run and undone: it must take more than one row, or this file no longer makes
-- the plan that took more.
create function pg_temp.old_takes_more(p_claim text) returns void language plpgsql as $$
declare n integer;
begin
 begin
  execute format('select count(*) from pg_temp.old_claim_%s(1)', p_claim) into n;
  raise exception using errcode='U0001', message='undo';
 exception when sqlstate 'U0001' then null;
 end;
 if n<2 then
  raise exception 'FAIL: the old claim_%(1) took % row(s) here, so this check no longer makes the plan that took more', p_claim, n;
 end if;
 raise notice 'ok - the old claim_%(1) took % rows here', p_claim, n;
end $$;

-- Claims one row at a time until none is left. Each claim must take one row and leave one row claimed;
-- the row is then finished as the worker would finish it.
create function pg_temp.claims_one(p_claim text, p_rows integer) returns void language plpgsql as $$
declare n integer; took integer; claims integer:=0; v uuid;
begin
 loop
  if p_claim='files' then
   select count(*), min(c.version_id::text)::uuid into n, v from file_search.claim_files(1) c;
   select count(*) into took from file_search.file_version where bucket_id='claim_once' and state='waiting' and attempts>0;
  elsif p_claim='chunks' then
   select count(*) into n from file_search.claim_chunks(1);
   select count(*) into took from file_search.chunk where state='waiting' and attempts>0;
  elsif p_claim='sentences' then
   select count(*) into n from file_search.claim_sentences(1);
   select count(*) into took from file_search.chunk_sentence where state='waiting' and attempts>0;
  else
   select count(*) into n from file_search.claim_entities(1);
   select count(*) into took from file_search.entity where state='waiting' and attempts>0;
  end if;
  exit when n=0;
  claims:=claims+1;
  if n<>1 or took<>1 then
   raise exception 'FAIL: claim_%(1) claim % returned % row(s) and left % claimed row(s) waiting', p_claim, claims, n, took;
  end if;
  if p_claim='files' then
   perform file_search.record_file_text(v, 'extracted',
    '[{"ordinal":0,"place":null,"body":"Its first part.","section":0},{"ordinal":1,"place":null,"body":"Its second part.","section":0}]'::jsonb,
    null, '[{"ordinal":0,"place":null,"body":"Its first part. Its second part."}]'::jsonb);
  elsif p_claim='chunks' then
   update file_search.chunk set state='embedded' where state='waiting' and attempts>0;
  elsif p_claim='sentences' then
   update file_search.chunk_sentence set state='embedded' where state='waiting' and attempts>0;
  else
   update file_search.entity set state='embedded' where state='waiting' and attempts>0;
  end if;
  if claims>p_rows then raise exception 'FAIL: more than % claims of claim_%(1) for % rows', p_rows, p_claim, p_rows; end if;
 end loop;
 if claims<>p_rows then raise exception 'FAIL: % claims of claim_%(1) for % rows', claims, p_claim, p_rows; end if;
 raise notice 'ok - claim_%(1) took exactly one row each time, % rows in % claims', p_claim, p_rows, claims;
end $$;

select pg_temp.old_takes_more('files');
select pg_temp.claims_one('files', 12);
-- The 12 versions' 24 chunks, kept on disk in the order the claim takes them, and seen as one row.
cluster file_search.chunk using chunk_pkey;
update pg_class set reltuples=1 where oid='file_search.chunk'::regclass;
select pg_temp.old_takes_more('chunks');
select pg_temp.claims_one('chunks', 24);
-- The 8 files' 16 sentences, once each chunk has its vector, kept on disk in the order the claim takes them,
-- and seen as one row. A record's chunks have no sentences.
cluster file_search.chunk_sentence using chunk_sentence_chunk_id_ordinal_key;
update pg_class set reltuples=1 where oid='file_search.chunk_sentence'::regclass;
select pg_temp.old_takes_more('sentences');
select pg_temp.claims_one('sentences', 16);
select pg_temp.old_takes_more('entities');
select pg_temp.claims_one('entities', 12);

-- The race. Run A connects as postgres, which file-search-worker uses. Run B connects as claim_racer, a member
-- of postgres that row-level security still holds, so the gate can stop it. The gate is a restrictive policy
-- on the tables the claims lock, and stops B only once armed. claim_files' two updates that retire versions
-- run first, each read as it begins, so a trigger arms the gate once they have run.
create schema claim_race;
create extension dblink schema claim_race;
create role claim_racer login;
grant postgres to claim_racer;
grant usage on schema claim_race to claim_racer;
create function claim_race.gate() returns boolean language plpgsql volatile as $$
begin
 if current_setting('claim_race.armed', true)='on' then
  perform pg_advisory_lock_shared(4242);
  perform pg_advisory_unlock_shared(4242);
 end if;
 return true;
end $$;
-- Counts claim_racer's updates of file versions, and arms the gate after claim_race.arm_after of them.
create function claim_race.arm() returns trigger language plpgsql as $$
declare n integer;
begin
 if current_user='claim_racer' and coalesce(current_setting('claim_race.arm_after', true), '')<>'' then
  n:=coalesce(nullif(current_setting('claim_race.updates', true), ''), '0')::integer+1;
  perform set_config('claim_race.updates', n::text, false);
  if n=current_setting('claim_race.arm_after')::integer then perform set_config('claim_race.armed', 'on', false); end if;
 end if;
 return null;
end $$;
create trigger claim_race_arm after update on file_search.file_version for each statement execute function claim_race.arm();
grant execute on all functions in schema claim_race to claim_racer;
alter table file_search.file_version force row level security;
alter table file_search.chunk force row level security;
alter table file_search.entity force row level security;
create policy claim_racer_reads on file_search.file_version for all to claim_racer using (true) with check (true);
create policy claim_racer_reads on file_search.chunk for all to claim_racer using (true) with check (true);
create policy claim_racer_reads on file_search.entity for all to claim_racer using (true) with check (true);
create policy claim_racer_gate on file_search.file_version as restrictive for all to claim_racer using (claim_race.gate()) with check (true);
create policy claim_racer_gate on file_search.chunk as restrictive for all to claim_racer using (claim_race.gate()) with check (true);
create policy claim_racer_gate on file_search.entity as restrictive for all to claim_racer using (claim_race.gate()) with check (true);

-- The claims' shape before this check: the claimable test a view, in a subquery.
create function claim_race.view_claim_files(p_limit integer) returns table(version_id uuid) language plpgsql as $$
#variable_conflict use_column
begin
 update file_search.file_version v set state='retired', finished_at=clock_timestamp(), error='The file is no longer in storage'
 where v.state='waiting' and v.object_id is not null and not exists(select 1 from storage.objects o where o.id=v.object_id);
 update file_search.file_version v set state='retired', finished_at=clock_timestamp(), error='A newer content replaced it'
 where v.state='waiting' and exists(select 1 from file_search.file_version n
  where n.object_id=v.object_id and n.queued_at>v.queued_at and n.state not in ('retired','purged'));
 return query
 with picked as materialized (
  select w.version_id from file_search.file_version w
  where w.version_id in (select c.version_id from file_search.claimable_file c)
  order by w.queued_at limit p_limit for update skip locked)
 update file_search.file_version f set attempts=f.attempts+1, last_attempt_at=clock_timestamp()
 from picked p where f.version_id=p.version_id returning f.version_id;
end $$;
create function claim_race.view_claim_chunks(p_limit integer) returns table(chunk_id uuid) language sql as $$
 with picked as materialized (
  select w.chunk_id from file_search.chunk w
  where w.chunk_id in (select c.chunk_id from file_search.claimable_chunk c)
  order by w.chunk_id limit p_limit for update of w skip locked)
 update file_search.chunk c set attempts=c.attempts+1, last_attempt_at=clock_timestamp()
 from picked p where c.chunk_id=p.chunk_id returning c.chunk_id
$$;
create function claim_race.view_claim_entities(p_limit integer) returns table(entity_id uuid) language sql as $$
 with picked as materialized (
  select w.entity_id from file_search.entity w
  where w.entity_id in (select c.entity_id from file_search.claimable_entity c)
  order by w.created_at, w.entity_id limit p_limit for update of w skip locked)
 update file_search.entity e set attempts=e.attempts+1, last_attempt_at=clock_timestamp()
 from picked p where e.entity_id=p.entity_id returning e.entity_id
$$;
grant execute on all functions in schema claim_race to claim_racer;

-- Two rows wait: the first two file versions or entities, or the first chunks of two versions.
create function pg_temp.two_wait(p_table text) returns void language plpgsql as $$
begin
 if p_table='file_version' then
  update file_search.file_version set state='extracted', attempts=0, last_attempt_at=null where bucket_id='claim_once';
  update file_search.file_version set state='waiting' where version_id in
   (select version_id from file_search.file_version where bucket_id='claim_once' order by queued_at limit 2);
 elsif p_table='chunk' then
  update file_search.chunk set state='embedded', attempts=0, last_attempt_at=null;
  update file_search.chunk set state='waiting' where chunk_id in (select chunk_id from
   (select distinct on (version_id) chunk_id from file_search.chunk order by version_id, chunk_id) f order by chunk_id limit 2);
 else
  update file_search.entity set state='embedded', attempts=0, last_attempt_at=null;
  update file_search.entity set state='waiting' where entity_id in (select entity_id from file_search.entity order by created_at, entity_id limit 2);
 end if;
end $$;

-- B runs p_b(1) and stops in the gate, armed at once or after p_arm_after updates; A runs p_a(1) and
-- commits; B goes on. Returns whether B took A's row.
create function pg_temp.race(p_a text, p_b text, p_id text, p_arm_after integer) returns boolean language plpgsql as $$
declare conn text; a_took uuid; b_took uuid; polls integer:=0;
begin
 conn:=format('dbname=%s host=%s port=%s', current_database(),
  split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'));
 perform claim_race.dblink_connect('a', conn||' user=postgres');
 perform claim_race.dblink_connect('b', conn||' user=claim_racer');
 if p_arm_after=0 then
  perform claim_race.dblink_exec('b', 'set claim_race.armed=on');
 else
  perform claim_race.dblink_exec('b', format('set claim_race.arm_after=%s', p_arm_after));
 end if;
 perform pg_advisory_lock(4242);
 perform claim_race.dblink_send_query('b', format('select %I from %s(1)', p_id, p_b));
 -- B either waits in the gate or has ended, in which case its own result, or error, is read now.
 while not exists(select 1 from pg_locks where locktype='advisory' and objid=4242 and not granted
  and database=(select oid from pg_database where datname=current_database())) loop
  if claim_race.dblink_is_busy('b')=0 then
   select t.id into b_took from claim_race.dblink_get_result('b') as t(id uuid);
   raise exception 'FAIL: % ended before the gate, having taken %', p_b, b_took;
  end if;
  polls:=polls+1;
  if polls>500 then raise exception 'FAIL: % never reached the gate', p_b; end if;
  perform pg_sleep(0.01);
 end loop;
 select t.id into a_took from claim_race.dblink('a', format('select %I from %s(1)', p_id, p_a)) as t(id uuid);
 perform pg_advisory_unlock(4242);
 select t.id into b_took from claim_race.dblink_get_result('b') as t(id uuid);
 perform claim_race.dblink_disconnect('a');
 perform claim_race.dblink_disconnect('b');
 if a_took is null or b_took is null then
  raise exception 'FAIL: in the race of % and %, A took % and B took %', p_a, p_b, a_took, b_took;
 end if;
 return a_took=b_took;
end $$;

-- One race, whose answer must be p_same: whether B took the row A had just taken.
create function pg_temp.race_takes(p_a text, p_b text, p_id text, p_arm_after integer, p_same boolean) returns void language plpgsql as $$
begin
 if pg_temp.race(p_a, p_b, p_id, p_arm_after)<>p_same then
  if p_same then
   raise exception 'FAIL: % did not take the row % had just taken, so this check no longer makes the race', p_b, p_a;
  end if;
  raise exception 'FAIL: % took the row % had just taken', p_b, p_a;
 end if;
 if p_same then raise notice 'ok - %, the shape with a view, took the row % had just taken', p_b, p_a;
 else raise notice 'ok - % passed by the row % had just taken, and took the next', p_b, p_a;
 end if;
end $$;

-- Each race's two rows wait, committed, before it starts.
select pg_temp.two_wait('file_version');
select pg_temp.race_takes('file_search.claim_files', 'claim_race.view_claim_files', 'version_id', 2, true);
select pg_temp.two_wait('file_version');
select pg_temp.race_takes('file_search.claim_files', 'file_search.claim_files', 'version_id', 2, false);
select pg_temp.two_wait('chunk');
select pg_temp.race_takes('file_search.claim_chunks', 'claim_race.view_claim_chunks', 'chunk_id', 0, true);
select pg_temp.two_wait('chunk');
select pg_temp.race_takes('file_search.claim_chunks', 'file_search.claim_chunks', 'chunk_id', 0, false);
select pg_temp.two_wait('entity');
select pg_temp.race_takes('file_search.claim_entities', 'claim_race.view_claim_entities', 'entity_id', 0, true);
select pg_temp.two_wait('entity');
select pg_temp.race_takes('file_search.claim_entities', 'file_search.claim_entities', 'entity_id', 0, false);

-- A retires the version of the first waiting chunk, and returns that chunk; p_limit is there for race's call.
create function claim_race.retire_first_chunk(p_limit integer) returns table(chunk_id uuid) language sql as $$
 with c as (select w.chunk_id, w.version_id from file_search.chunk w where w.state='waiting' order by w.chunk_id limit 1),
 r as (update file_search.file_version v set state='retired', finished_at=clock_timestamp(), error='Retired by the race'
  from c where v.version_id=c.version_id returning c.chunk_id)
 select r.chunk_id from r
$$;
grant usage on schema claim_race to postgres;
-- Each race's two chunks wait again, their versions extracted, before it starts.
create function pg_temp.two_chunks_wait() returns void language plpgsql as $$
begin
 update file_search.file_version set state='extracted', finished_at=clock_timestamp(), error=null
 where state='retired' and error='Retired by the race';
 perform pg_temp.two_wait('chunk');
end $$;
select pg_temp.two_chunks_wait();
select pg_temp.race_takes('claim_race.retire_first_chunk', 'claim_race.view_claim_chunks', 'chunk_id', 0, true);
select pg_temp.two_chunks_wait();
select pg_temp.race_takes('claim_race.retire_first_chunk', 'file_search.claim_chunks', 'chunk_id', 0, false);

-- The race's role, which the whole cluster sees, is dropped with its policies and grants.
drop policy claim_racer_reads on file_search.file_version;
drop policy claim_racer_reads on file_search.chunk;
drop policy claim_racer_reads on file_search.entity;
drop policy claim_racer_gate on file_search.file_version;
drop policy claim_racer_gate on file_search.chunk;
drop policy claim_racer_gate on file_search.entity;
drop owned by claim_racer;
drop role claim_racer;
-- The cases below begin with no sentence waiting and one file's chunk embedded, so a claim takes only their own rows.
update file_search.chunk_sentence set state='embedded' where state='waiting';
update file_search.chunk set state='embedded' where chunk_id=(select min(chunk_id::text)::uuid from file_search.chunk where object_id is not null);

-- The worker's own claim, claim_sentences(2, 900), over sentences of mixed lengths: each claim's lengths
-- add up to no more than 900, or it holds one sentence. The sentences of 1,200 and 1,500 characters are
-- each claimed alone, and every sentence is claimed once.
create function pg_temp.claims_within(p_limit integer, p_chars integer) returns void language plpgsql as $$
declare lengths integer[]:=array[100, 300, 900, 1500, 50, 50, 700, 400, 1200, 20, 30, 40]; n integer; total integer;
 claims integer:=0; claimed integer:=0; longest integer; c uuid;
begin
 select min(chunk_id::text)::uuid into c from file_search.chunk where state='embedded' and object_id is not null;
 insert into file_search.chunk_sentence(chunk_id, object_id, ordinal, body)
  select c, (select object_id from file_search.chunk where chunk_id=c), 100+k, repeat('a', lengths[k])
  from generate_subscripts(lengths, 1) k;
 loop
  select count(*), coalesce(sum(length(x.body)), 0), coalesce(max(length(x.body)), 0) into n, total, longest
   from file_search.claim_sentences(p_limit, p_chars) x;
  exit when n=0;
  claims:=claims+1;
  claimed:=claimed+n;
  if n>p_limit or (total>p_chars and n<>1) then
   raise exception 'FAIL: claim_sentences(%, %) took % sentences of % characters', p_limit, p_chars, n, total;
  end if;
  if longest>p_chars and n<>1 then raise exception 'FAIL: a sentence of % characters was claimed with % others', longest, n-1; end if;
  update file_search.chunk_sentence set state='embedded' where state='waiting' and attempts>0;
  if claims>12 then raise exception 'FAIL: more than 12 claims of claim_sentences(%, %) for 12 sentences', p_limit, p_chars; end if;
 end loop;
 if claimed<>12 or exists(select 1 from file_search.chunk_sentence where ordinal>=100 and ordinal<200 and attempts<>1) then
  raise exception 'FAIL: claim_sentences(%, %) claimed % of 12 sentences, or one twice', p_limit, p_chars, claimed;
 end if;
 raise notice 'ok - claim_sentences(%, %) took 12 sentences of mixed lengths in % claims, each within the budget or alone', p_limit, p_chars, claims;
end $$;
select pg_temp.claims_within(2, 900);
-- Two claims at once: a second connection claims claim_sentences(2, 900) and holds its transaction open, and this
-- one's claim passes by every sentence the other locked, and takes its own within the budget.
-- The sentences are committed first, so the other connection sees them.
insert into file_search.chunk_sentence(chunk_id, object_id, ordinal, body)
 select c.chunk_id, c.object_id, 400+k, repeat('b', (array[600, 600, 100, 100])[k])
 from (select chunk_id, object_id from file_search.chunk where state='embedded' and object_id is not null order by chunk_id::text limit 1) c,
  generate_series(1, 4) k;
create function pg_temp.sentence_race() returns void language plpgsql as $$
declare conn text; b_took uuid[]; a_took uuid[];
begin
 conn:=format('dbname=%s host=%s port=%s user=postgres', current_database(),
  split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'));
 perform claim_race.dblink_connect('b', conn);
 perform claim_race.dblink_exec('b', 'begin');
 select array_agg(t.id) into b_took from claim_race.dblink('b', 'select sentence_id from file_search.claim_sentences(2, 900)') as t(id uuid);
 select array_agg(x.sentence_id) into a_took from file_search.claim_sentences(2, 900) x;
 perform claim_race.dblink_exec('b', 'rollback');
 perform claim_race.dblink_disconnect('b');
 if cardinality(b_took)<>1 or cardinality(a_took)<>2 or b_took && a_took
  or exists(select 1 from file_search.chunk_sentence where sentence_id=any(a_took) and length(body)<>100) then
  raise exception 'FAIL: two claim_sentences(2, 900) at once took % and %', b_took, a_took;
 end if;
 update file_search.chunk_sentence set state='embedded' where ordinal between 401 and 404;
 raise notice 'ok - two claim_sentences(2, 900) at once took different sentences, the second passing by both the first had locked';
end $$;
select pg_temp.sentence_race();

-- 0005-worker-budget, as on a project whose claims wore rows out: a chunk and sentences that failed after five
-- attempts wait again, with no attempts, one that kept an earlier error among them, a sentence that failed on its
-- first attempt stays failed, and the claim of a count alone still takes a sentence. A second
-- run sets nothing waiting again.
do $$
declare c uuid:=(select min(chunk_id::text)::uuid from file_search.chunk where state='embedded' and object_id is not null);
begin
 update file_search.chunk set state='failed', attempts=5, error='No answer after five attempts'
 where chunk_id=(select max(chunk_id::text)::uuid from file_search.chunk);
 insert into file_search.chunk_sentence(chunk_id, object_id, ordinal, body, state, attempts, error)
  values (c, (select object_id from file_search.chunk where chunk_id=c), 300, 'A sentence that wore out.', 'failed', 5, 'No answer after five attempts'),
   (c, (select object_id from file_search.chunk where chunk_id=c), 301, 'A sentence that wore out after an error.', 'failed', 5, 'The model answered 503'),
   (c, (select object_id from file_search.chunk where chunk_id=c), 302, 'A sentence that failed on its first attempt.', 'failed', 1, 'The model refused it');
end $$;
delete from file_search.schema_upgrade where id='0005-worker-budget';
\i :budget_upgrade
do $$
begin
 if (select state||attempts from file_search.chunk where chunk_id=(select max(chunk_id::text)::uuid from file_search.chunk))<>'waiting0'
  or (select state||attempts from file_search.chunk_sentence where ordinal=300)<>'waiting0'
  or (select state||attempts from file_search.chunk_sentence where ordinal=301)<>'waiting0'
  or (select state||attempts from file_search.chunk_sentence where ordinal=302)<>'failed1' then
  raise exception 'FAIL: 0005-worker-budget did not set waiting the rows that failed after five attempts, or set waiting one that failed on its first';
 end if;
 if to_regprocedure('file_search.claim_sentences(integer)') is null or (select count(*) from file_search.claim_sentences(1))<>1 then
  raise exception 'FAIL: after 0005-worker-budget, claim_sentences(integer) does not take a sentence';
 end if;
 update file_search.chunk_sentence set state='failed', attempts=5, error='No answer after five attempts' where ordinal=300;
end $$;
\i :budget_upgrade
do $$
begin
 if (select state from file_search.chunk_sentence where ordinal=300)<>'failed' then
  raise exception 'FAIL: a second run of 0005-worker-budget set a row waiting again';
 end if;
 raise notice 'ok - 0005-worker-budget set each row that failed after five attempts waiting again, once';
end $$;

-- A retired version's waiting chunks are retired with it, and wait again when it comes back. A deleted file and a
-- record's replaced version are read into chunks, none embedded yet, beside a file that stays. claim_chunks then
-- takes only the staying file's chunks. Its bucket stops being indexed and is indexed again, and its chunks wait
-- again. Last, the gone versions' chunks are set waiting, as on a project built before 0008-retired-chunks, with a
-- purged version's chunk beside them, and the upgrade leaves none of them waiting.
insert into storage.buckets(id, name) values ('retired_chunks', 'retired_chunks');
insert into file_search.indexed_bucket(bucket_id) values ('retired_chunks');
update file_search.chunk set state='embedded' where state='waiting';
update file_search.chunk_sentence set state='embedded' where state='waiting';
insert into storage.objects(bucket_id, name, metadata)
 values ('retired_chunks', 'gone.md', '{"eTag":"g1"}'), ('retired_chunks', 'kept.md', '{"eTag":"k1"}');
select file_search.queue_record('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000011', 1,
 'retired_chunks', 'A record', '{"note":"Its first version."}');
create function pg_temp.read_text(p_version_id uuid) returns void language sql as $$
 select file_search.record_file_text(p_version_id, 'extracted',
  '[{"ordinal":0,"place":null,"body":"Its first part.","section":0},{"ordinal":1,"place":null,"body":"Its second part.","section":0}]'::jsonb,
  null, '[{"ordinal":0,"place":null,"body":"Its first part. Its second part."}]'::jsonb)
$$;
select pg_temp.read_text(version_id) from file_search.file_version where bucket_id='retired_chunks';
set storage.allow_delete_query='true';
delete from storage.objects where bucket_id='retired_chunks' and name='gone.md';
reset storage.allow_delete_query;
select file_search.queue_record('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000012', 2,
 'retired_chunks', 'A record', '{"note":"Its second version."}');
do $$
declare took text; kept text;
begin
 if exists(select 1 from file_search.chunk c join file_search.file_version v using (version_id)
   where v.bucket_id='retired_chunks' and v.state='retired' and c.state<>'retired')
  or exists(select 1 from file_search.chunk_sentence s join file_search.chunk c using (chunk_id) join file_search.file_version v using (version_id)
   where v.bucket_id='retired_chunks' and v.state='retired' and s.state<>'retired')
  or (select count(*) from file_search.chunk c join file_search.file_version v using (version_id)
   where v.bucket_id='retired_chunks' and v.state='retired')<>4 then
  raise exception 'FAIL: a deleted file''s or a replaced record version''s waiting chunks or sentences were not retired: %',
   (select string_agg(v.name||' '||v.state||' '||c.state, ', ') from file_search.chunk c join file_search.file_version v using (version_id)
    where v.bucket_id='retired_chunks');
 end if;
 select string_agg(c.chunk_id::text, ',' order by c.chunk_id) into kept from file_search.chunk c join file_search.file_version v using (version_id)
 where v.bucket_id='retired_chunks' and v.name='kept.md';
 begin
  select string_agg(x.chunk_id::text, ',' order by x.chunk_id) into took from file_search.claim_chunks(50) x;
  raise exception using errcode='U0001', message='undo';
 exception when sqlstate 'U0001' then null;
 end;
 if took is distinct from kept then raise exception 'FAIL: claim_chunks(50) took % where only kept.md''s chunks % wait', took, kept; end if;
 perform file_search.unindex_bucket('retired_chunks');
 if exists(select 1 from file_search.chunk c join file_search.file_version v using (version_id)
   where v.bucket_id='retired_chunks' and c.state<>'retired') then
  raise exception 'FAIL: a bucket no longer indexed kept a waiting chunk';
 end if;
 perform file_search.index_bucket('retired_chunks');
 if (select string_agg(v.state||' '||c.state, ',') from file_search.chunk c join file_search.file_version v using (version_id)
    where v.bucket_id='retired_chunks' and v.name='kept.md')<>'extracted waiting,extracted waiting'
  or exists(select 1 from file_search.chunk_sentence s join file_search.chunk c using (chunk_id) join file_search.file_version v using (version_id)
   where v.name='kept.md' and s.state<>'waiting') then
  raise exception 'FAIL: kept.md, indexed again, did not set its chunks and sentences waiting again';
 end if;
 raise notice 'ok - a deleted file''s and a replaced record version''s waiting chunks were retired, claim_chunks took only kept.md''s, and kept.md''s chunks waited again once its bucket was indexed again';
end $$;
do $$
declare gone uuid:=(select object_id from file_search.file_version where name='gone.md');
begin
 update file_search.chunk c set state='waiting' from file_search.file_version v
 where v.version_id=c.version_id and v.bucket_id='retired_chunks' and v.state='retired';
 update file_search.chunk_sentence s set state='waiting' from file_search.chunk c, file_search.file_version v
 where c.chunk_id=s.chunk_id and v.version_id=c.version_id and v.bucket_id='retired_chunks' and v.state='retired';
 perform file_search.purge(gone);
 insert into file_search.chunk(version_id, object_id, ordinal, body)
 select version_id, object_id, 9, 'A chunk purge left behind.' from file_search.file_version where object_id=gone;
end $$;
delete from file_search.schema_upgrade where id='0008-retired-chunks';
\i :retired_upgrade
do $$
begin
 if exists(select 1 from file_search.chunk c join file_search.file_version v using (version_id)
   where c.state='waiting' and v.state in ('retired','purged')) then
  raise exception 'FAIL: 0008-retired-chunks left waiting % chunk(s) of retired or purged versions',
   (select count(*) from file_search.chunk c join file_search.file_version v using (version_id) where c.state='waiting' and v.state in ('retired','purged'));
 end if;
 raise notice 'ok - 0008-retired-chunks retired every waiting chunk of a retired or purged version';
end $$;

do $$ begin
 raise notice 'PASS: claim-once (each claim''s old shape took more than one row, claim_files, claim_chunks, claim_sentences and claim_entities took exactly one each time, in a race claim_files, claim_chunks and claim_entities passed by the row another run had just taken, where the shape with a view took it, claim_chunks passed by a chunk whose version was retired during the claim, claim_sentences(2, 900) kept within its characters and passed by the sentences another claim held, 0005-worker-budget set the rows the old claims wore out waiting again, once, a retired version''s waiting chunks were retired with it and waited again when it came back, and 0008-retired-chunks retired those a project kept waiting)';
end $$;
