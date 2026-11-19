-- 0004-claim-once
-- base: 90c2e8a
-- Each claim tests the columns of the rows it locks, through may_try, so two runs never take one row:
-- a view in a subquery is read as the statement began. claim_chunks locks its chunk's version too, so
-- a version retired during the claim is read as retired. The claimable views test rows with may_try.
-- Safe to run twice. Run as postgres.

create or replace function file_search.may_try(p_attempts integer, p_last_attempt_at timestamptz) returns boolean
language sql volatile set search_path=pg_catalog as $$
 select p_attempts<5 and (p_last_attempt_at is null or p_last_attempt_at<clock_timestamp()-interval '5 minutes')
$$;
revoke all on function file_search.may_try(integer,timestamptz) from public, anon, authenticated;

create or replace view file_search.claimable_entity with (security_invoker=true) as
 select w.* from file_search.entity w
 where w.state='waiting' and file_search.may_try(w.attempts, w.last_attempt_at);
revoke all on file_search.claimable_entity from public, anon, authenticated;

create or replace function file_search.claim_entities(p_limit integer)
returns table(entity_id uuid, body text)
language sql volatile set search_path=pg_catalog as $$
 with picked as materialized (
  select w.entity_id from file_search.entity w
  where w.state='waiting' and file_search.may_try(w.attempts, w.last_attempt_at)
  order by w.created_at, w.entity_id limit greatest(1, least(p_limit, 50)) for update of w skip locked),
 claimed as (
  update file_search.entity e set attempts=e.attempts+1, last_attempt_at=clock_timestamp()
  from picked p where e.entity_id=p.entity_id
  returning e.entity_id, e.name, e.entity_type)
 select c.entity_id, c.name||' ('||c.entity_type||')' from claimed c
$$;

create or replace view file_search.claimable_file with (security_invoker=true) as
 select w.* from file_search.file_version w
 where w.state='waiting' and file_search.may_try(w.attempts, w.last_attempt_at);
create or replace view file_search.claimable_chunk with (security_invoker=true) as
 select w.* from file_search.chunk w join file_search.file_version v on v.version_id=w.version_id
 where w.state='waiting' and v.state not in ('retired','purged') and file_search.may_try(w.attempts, w.last_attempt_at);
revoke all on file_search.claimable_file, file_search.claimable_chunk from public, anon, authenticated;

create or replace function file_search.claim_files(p_limit integer, p_call bigint default null)
returns table(version_id uuid, bucket_id text, name text, record_text text)
language plpgsql volatile set search_path=pg_catalog as $$
#variable_conflict use_column
begin
 -- A version whose file is gone, or which a newer content has replaced, is retired unread.
 update file_search.file_version v set state='retired', finished_at=clock_timestamp(), error='The file is no longer in storage'
 where v.state='waiting' and v.object_id is not null and not exists(select 1 from storage.objects o where o.id=v.object_id);
 update file_search.file_version v set state='retired', finished_at=clock_timestamp(), error='A newer content replaced it'
 where v.state='waiting' and exists(select 1 from file_search.file_version n
  where n.object_id=v.object_id and n.queued_at>v.queued_at and n.state not in ('retired','purged'));
 -- The rows are picked once, in a materialized step, then updated: a LIMIT ... SKIP LOCKED subquery inside the
 -- UPDATE can be planned to run again for each row, each run skipping the rows already locked and taking more.
 -- Each claim tests the columns of the rows it locks: once another run commits its claim of a row, the lock's
 -- recheck reads them as that run left them, and passes the row by. A view in a subquery is read as the
 -- statement began, and would let two runs take one row. claim_chunks locks its chunk's version too, so a
 -- version retired during the claim is read as retired.
 return query
 with picked as materialized (
  select w.version_id from file_search.file_version w
  where w.state='waiting' and file_search.may_try(w.attempts, w.last_attempt_at)
  order by w.queued_at limit greatest(1, least(p_limit, 20)) for update skip locked),
 claimed as (
  update file_search.file_version f set attempts=f.attempts+1, last_attempt_at=clock_timestamp()
  from picked p
  where f.version_id=p.version_id and (f.object_id is null or exists(select 1 from storage.objects o where o.id=f.object_id))
  returning f.version_id, f.object_id, f.record_id, f.bucket_id, f.name, f.body),
 noted as (
  insert into file_search.worker_claim(call_id, version_id, object_id, record_id)
  select p_call, c.version_id, c.object_id, c.record_id from claimed c where p_call is not null)
 select c.version_id, coalesce(o.bucket_id, c.bucket_id), coalesce(o.name, c.name), case when c.record_id is not null then coalesce(c.body, '') end
 from claimed c left join storage.objects o on o.id=c.object_id;
end $$;

create or replace function file_search.claim_chunks(p_limit integer, p_call bigint default null)
returns table(chunk_id uuid, body text)
language sql volatile set search_path=pg_catalog as $$
 with picked as materialized (
  select w.chunk_id from file_search.chunk w join file_search.file_version v on v.version_id=w.version_id
  where w.state='waiting' and file_search.may_try(w.attempts, w.last_attempt_at) and v.state not in ('retired','purged')
  order by w.chunk_id limit greatest(1, least(p_limit, 50)) for update of w skip locked for share of v skip locked),
 claimed as (
  update file_search.chunk c set attempts=c.attempts+1, last_attempt_at=clock_timestamp()
  from picked p where c.chunk_id=p.chunk_id
  returning c.chunk_id, c.version_id, c.object_id, c.body),
 noted as (
  insert into file_search.worker_claim(call_id, version_id, chunk_id, object_id)
  select p_call, c.version_id, c.chunk_id, c.object_id from claimed c where p_call is not null)
 select c.chunk_id, c.body from claimed c
$$;

create or replace view file_search.claimable_sentence with (security_invoker=true) as
 select w.* from file_search.chunk_sentence w join file_search.chunk c on c.chunk_id=w.chunk_id
 join file_search.file_version v on v.version_id=c.version_id
 where w.state='waiting' and c.state='embedded' and v.state not in ('retired','purged') and file_search.may_try(w.attempts, w.last_attempt_at);
revoke all on file_search.claimable_sentence from public, anon, authenticated;

create or replace function file_search.claim_sentences(p_limit integer)
returns table(sentence_id uuid, body text)
language sql volatile set search_path=pg_catalog as $$
 with picked as materialized (
  select w.sentence_id from file_search.chunk_sentence w join file_search.chunk c on c.chunk_id=w.chunk_id
  where w.state='waiting' and c.state='embedded' and file_search.may_try(w.attempts, w.last_attempt_at)
  order by w.last_attempt_at nulls first, w.chunk_id, w.ordinal limit greatest(1, least(p_limit, 50)) for update of w skip locked)
 update file_search.chunk_sentence s set attempts=s.attempts+1, last_attempt_at=clock_timestamp()
 from picked p where s.sentence_id=p.sentence_id
 returning s.sentence_id, s.body
$$;

insert into file_search.schema_upgrade(id) values ('0004-claim-once') on conflict (id) do nothing;
