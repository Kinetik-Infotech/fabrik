-- 0003-graph-reader
-- base: new
-- From ACMEKB's file search upgrades 0014-graph-reader and 0015-graph-drops. The graph reader: the batches of waiting
-- chunks the graph-reader hosted function reads with Claude, each with its tokens and cost, the month's cap on that
-- cost, and each chunk's failed reads, marked failed after 3. close_graph_batch trims each read before its save and
-- keeps each dropped item, with its reason, in graph_drop, beside the items fabrik dropped for its glossary. The search
-- that counts these is file-search.sql's own. Safe to run twice. Run as postgres.

-- The graph reader. A hosted function the project deploys reads each waiting chunk with a language
-- model, through a batch API, and saves what it finds with save_extraction, under the name the
-- project gives it. One batch is open at a time. claim_unextracted takes the waiting chunks of the
-- buckets the project names into a new batch, and holds them until the batch closes. A chunk whose
-- read fails is left waiting, with its attempts counted, and is marked failed after 3 attempts.
-- Each batch keeps its tokens and cost, and no batch is sent once the month's cost reaches the cap.
create table if not exists file_search.graph_settings (
 id boolean primary key default true check (id),
 monthly_cap_usd numeric(10,2) not null default 100 check (monthly_cap_usd>=0),
 batch_size integer not null default 1000 check (batch_size between 1 and 10000)
);
insert into file_search.graph_settings(id) values (true) on conflict (id) do nothing;

create table if not exists file_search.graph_batch (
 batch_id uuid primary key default gen_random_uuid(),
 api_batch_id text unique,
 model text,
 chunks uuid[] not null,
 claimed_at timestamptz not null default clock_timestamp(),
 sent_at timestamptz,
 ended_at timestamptz,
 closed_at timestamptz,
 saved integer not null default 0 check (saved>=0),
 failed integer not null default 0 check (failed>=0),
 retried integer not null default 0 check (retried>=0),
 input_tokens bigint not null default 0 check (input_tokens>=0),
 cache_write_tokens bigint not null default 0 check (cache_write_tokens>=0),
 cache_read_tokens bigint not null default 0 check (cache_read_tokens>=0),
 output_tokens bigint not null default 0 check (output_tokens>=0),
 cost_usd numeric(12,6) not null default 0 check (cost_usd>=0),
 problem text
);
create unique index if not exists graph_batch_one_open on file_search.graph_batch((true)) where closed_at is null;
create index if not exists graph_batch_sent on file_search.graph_batch(sent_at);

-- Each chunk whose read failed: its attempts, its last reason, and whether it is waiting or failed.
-- A user sees it only for a file they can open.
create table if not exists file_search.chunk_extraction_attempt (
 chunk_id uuid primary key references file_search.chunk(chunk_id) on delete cascade,
 object_id uuid not null,
 attempts integer not null default 0 check (attempts>=0),
 state text not null default 'waiting' check (state in ('waiting','failed')),
 error text,
 last_attempt_at timestamptz
);

-- Columns an earlier text of this upgrade left out.
alter table file_search.graph_batch add column if not exists retried integer not null default 0 check (retried>=0);
alter table file_search.chunk_extraction_attempt add column if not exists object_id uuid;
update file_search.chunk_extraction_attempt t set object_id=c.object_id from file_search.chunk c where c.chunk_id=t.chunk_id and t.object_id is null;
alter table file_search.chunk_extraction_attempt alter column object_id set not null;

alter table file_search.graph_settings enable row level security;
alter table file_search.graph_batch enable row level security;
alter table file_search.chunk_extraction_attempt enable row level security;
revoke all on file_search.graph_settings, file_search.graph_batch, file_search.chunk_extraction_attempt from public, anon, authenticated;
drop policy if exists "File search: files the user can open" on file_search.chunk_extraction_attempt;
create policy "File search: files the user can open" on file_search.chunk_extraction_attempt for select to authenticated
 using (exists (select 1 from storage.objects o where o.id = object_id));
grant select on file_search.chunk_extraction_attempt to authenticated;

-- The chunks the open batch holds, by id alone, for a search's counts.
create or replace function file_search.graph_held_chunks() returns setof uuid
language sql stable security definer set search_path=pg_catalog as $$
 select unnest(b.chunks) from file_search.graph_batch b where b.closed_at is null
$$;

-- The month's cost of the batches sent, in dollars.
create or replace function file_search.graph_month_cost() returns numeric
language sql stable set search_path=pg_catalog as $$
 select coalesce(sum(b.cost_usd), 0) from file_search.graph_batch b
 where b.sent_at>=date_trunc('month', clock_timestamp() at time zone 'UTC') at time zone 'UTC'
$$;

-- The chunks of the named buckets waiting for their graph, of each file's latest extracted content:
-- none saved, none failed and none held by an open batch. Their keys alone: a claim reads the text of
-- the chunks it takes.
drop function if exists file_search.graph_waiting(text[]);
create or replace function file_search.graph_waiting(p_buckets text[]) returns table(chunk_id uuid, bucket_id text, name text, ordinal integer)
language sql stable set search_path=pg_catalog as $$
 with held as (select unnest(b.chunks) as chunk_id from file_search.graph_batch b where b.closed_at is null),
 latest as (
  select distinct on (f.object_id) f.version_id, f.object_id, f.state
  from file_search.file_version f where f.state not in ('retired','purged')
  order by f.object_id, f.queued_at desc)
 select c.chunk_id, o.bucket_id, o.name, c.ordinal
 from latest l join storage.objects o on o.id=l.object_id and o.bucket_id=any(p_buckets)
 join file_search.chunk c on c.version_id=l.version_id
 where l.state='extracted'
  and not exists (select 1 from file_search.chunk_extraction x where x.chunk_id=c.chunk_id)
  and not exists (select 1 from file_search.chunk_extraction_attempt t where t.chunk_id=c.chunk_id and t.state='failed')
  and not exists (select 1 from held h where h.chunk_id=c.chunk_id)
$$;

-- Whether the graph reader has work: an open batch, or a waiting chunk while the month's cost is
-- under the cap.
create or replace function file_search.graph_has_work(p_buckets text[]) returns boolean
language sql stable set search_path=pg_catalog as $$
 select exists (select 1 from file_search.graph_batch where closed_at is null)
  or (file_search.graph_month_cost()<(select monthly_cap_usd from file_search.graph_settings)
   and exists (select 1 from file_search.graph_waiting(p_buckets)))
$$;

-- The open batch, or null. A batch claimed and never sent for 10 minutes is closed first, and its
-- chunks wait again.
create or replace function file_search.open_graph_batch() returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare b file_search.graph_batch;
begin
 update file_search.graph_batch set closed_at=clock_timestamp(), problem='The batch was claimed and never sent'
 where closed_at is null and sent_at is null and claimed_at<clock_timestamp()-interval '10 minutes';
 select * into b from file_search.graph_batch where closed_at is null;
 if b.batch_id is null then return null; end if;
 return jsonb_build_object('batch_id', b.batch_id, 'api_batch_id', b.api_batch_id, 'parts', cardinality(b.chunks),
  'claimed_at', b.claimed_at, 'sent_at', b.sent_at);
end $$;

-- Claims up to p_limit waiting chunks of the named buckets into a new batch, in bucket, file and
-- chunk order, and gives each with its text. Claims nothing while a batch is open, or once the
-- month's cost reaches the cap.
create or replace function file_search.claim_unextracted(p_buckets text[], p_limit integer) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare s file_search.graph_settings; spent numeric; got jsonb; b uuid;
begin
 if p_limit is null or p_limit not between 1 and 10000 then raise exception 'Limit must be 1 through 10,000' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('file_search.graph_batch', 19483));
 if exists (select 1 from file_search.graph_batch where closed_at is null) then
  return jsonb_build_object('claimed', false, 'reason', 'A batch is open');
 end if;
 select * into s from file_search.graph_settings;
 spent:=file_search.graph_month_cost();
 if spent>=s.monthly_cap_usd then
  return jsonb_build_object('claimed', false, 'capped', true,
   'reason', format('This month''s cost, $%s, has reached the cap of $%s', round(spent, 2), s.monthly_cap_usd));
 end if;
 select jsonb_agg(jsonb_build_object('chunk_id', w.chunk_id, 'bucket', w.bucket_id, 'file', w.name, 'place', w.place, 'text', w.body)
  order by w.bucket_id, w.name, w.ordinal) into got
 from (select g.chunk_id, g.bucket_id, g.name, g.ordinal, c.place, c.body
  from (select * from file_search.graph_waiting(p_buckets) k order by k.bucket_id, k.name, k.ordinal limit p_limit) g
  join file_search.chunk c on c.chunk_id=g.chunk_id) w;
 if got is null then return jsonb_build_object('claimed', false, 'reason', 'No part is waiting'); end if;
 insert into file_search.graph_batch(chunks) select array_agg((x->>'chunk_id')::uuid) from jsonb_array_elements(got) x
 returning batch_id into b;
 return jsonb_build_object('claimed', true, 'batch_id', b, 'chunks', got);
end $$;

-- Records that a claimed batch was sent, with the batch API's id for it and the model.
create or replace function file_search.graph_batch_sent(p_batch uuid, p_api_batch_id text, p_model text) returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
begin
 if p_api_batch_id is null or length(p_api_batch_id) not between 1 and 200 then raise exception 'Give the batch API''s id' using errcode='22023'; end if;
 update file_search.graph_batch set api_batch_id=p_api_batch_id, model=p_model, sent_at=clock_timestamp()
 where batch_id=p_batch and sent_at is null and closed_at is null;
 return found;
end $$;

-- Closes a claimed batch that was not sent, with the reason. Its chunks wait again.
create or replace function file_search.graph_batch_unsent(p_batch uuid, p_problem text) returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
begin
 update file_search.graph_batch set closed_at=clock_timestamp(), problem=left(coalesce(p_problem, 'Not sent'), 2000)
 where batch_id=p_batch and sent_at is null and closed_at is null;
 return found;
end $$;

-- Counts one failed read of a chunk, with its reason. The third marks it failed. A chunk deleted
-- since it was claimed is left alone.
create or replace function file_search.fail_extraction(p_chunk uuid, p_reason text) returns text
language plpgsql volatile set search_path=pg_catalog as $$
declare s text;
begin
 insert into file_search.chunk_extraction_attempt as t (chunk_id, object_id, attempts, state, error, last_attempt_at)
 select c.chunk_id, c.object_id, 1, 'waiting', left(coalesce(p_reason, 'No reason given'), 2000), clock_timestamp()
 from file_search.chunk c where c.chunk_id=p_chunk
 on conflict (chunk_id) do update set attempts=t.attempts+1, error=excluded.error, last_attempt_at=excluded.last_attempt_at,
  state=case when t.attempts+1>=3 then 'failed' else 'waiting' end
 returning t.state into s;
 return s;
end $$;

-- Closes a sent batch with its results, once. p_results is [{chunk_id, entities, relations}] for a
-- read, [{chunk_id, error}] for an answer that failed, or [{chunk_id, retry}] for a request the batch
-- API did not answer, such as an error on its side, which leaves the chunk waiting with no attempt
-- counted. Each read is saved with save_extraction under
-- p_saved_by and p_saved_by_name, and a save it refuses counts as a failed read. A chunk of the batch
-- with no result counts as a failed read too. p_usage holds the batch's input_tokens,
-- cache_write_tokens, cache_read_tokens, output_tokens, cost_usd and ended_at, and any problem.
create or replace function file_search.close_graph_batch(p_batch uuid, p_results jsonb, p_usage jsonb,
 p_saved_by uuid, p_saved_by_name text) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare b file_search.graph_batch; r jsonb; ch uuid; res jsonb; t jsonb; n_saved integer:=0; n_failed integer:=0; n_skipped integer:=0; n_retried integer:=0; n_dropped integer:=0; seen uuid[]:='{}';
begin
 if p_saved_by is null then raise exception 'Name who saved the extraction' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_results, 'null'))<>'array' then raise exception 'The results are a list' using errcode='22023'; end if;
 select * into b from file_search.graph_batch where batch_id=p_batch for update;
 if b.batch_id is null or b.sent_at is null then raise exception 'No such sent batch' using errcode='22023'; end if;
 if b.closed_at is not null then return jsonb_build_object('batch_id', p_batch, 'closed', false, 'reason', 'The batch was closed before'); end if;
 for r in select x from jsonb_array_elements(p_results) x loop
  ch:=case when (r->>'chunk_id') ~ '^[0-9a-f-]{36}$' then (r->>'chunk_id')::uuid end;
  continue when ch is null or not ch=any(b.chunks) or ch=any(seen);
  seen:=seen||ch;
  if r ? 'retry' then
   n_retried:=n_retried+1;
   continue;
  end if;
  if r ? 'error' then
   perform file_search.fail_extraction(ch, r->>'error');
   n_failed:=n_failed+1;
   continue;
  end if;
  begin
   t:=file_search.trim_extraction(r->'entities', r->'relations');
   -- Items the project dropped before the batch was closed, such as one that fits none of its classes, are kept too.
   t:=jsonb_set(t, '{dropped}', coalesce(case when jsonb_typeof(r->'dropped')='array' then r->'dropped' end, '[]'::jsonb)||(t->'dropped'));
   res:=file_search.save_extraction(ch, t->'entities', t->'relations', p_saved_by, p_saved_by_name, false);
   if (res->>'saved')::boolean then
    n_saved:=n_saved+1;
    insert into file_search.graph_drop(batch_id, chunk_id, reason, item)
    select p_batch, ch, d->>'reason', d->'item' from jsonb_array_elements(t->'dropped') d;
    n_dropped:=n_dropped+jsonb_array_length(t->'dropped');
   else n_skipped:=n_skipped+1; end if;
  exception when others then
   perform file_search.fail_extraction(ch, sqlerrm);
   n_failed:=n_failed+1;
  end;
 end loop;
 for ch in select x from unnest(b.chunks) x where not x=any(seen) loop
  perform file_search.fail_extraction(ch, 'No result came back for this part');
  n_failed:=n_failed+1;
 end loop;
 update file_search.graph_batch set closed_at=clock_timestamp(), saved=n_saved, failed=n_failed, retried=n_retried, dropped=n_dropped,
  ended_at=coalesce((p_usage->>'ended_at')::timestamptz, clock_timestamp()),
  input_tokens=coalesce((p_usage->>'input_tokens')::bigint, 0), cache_write_tokens=coalesce((p_usage->>'cache_write_tokens')::bigint, 0),
  cache_read_tokens=coalesce((p_usage->>'cache_read_tokens')::bigint, 0), output_tokens=coalesce((p_usage->>'output_tokens')::bigint, 0),
  cost_usd=coalesce((p_usage->>'cost_usd')::numeric, 0), problem=coalesce(p_usage->>'problem', problem)
 where batch_id=p_batch;
 return jsonb_build_object('batch_id', p_batch, 'closed', true, 'saved', n_saved, 'failed', n_failed, 'retried', n_retried, 'dropped', n_dropped, 'saved_before', n_skipped);
end $$;

-- Each part of a file's latest extracted content, from p_from on, with its text and where its graph
-- stands: read, with who saved it and its counts; failed, with the reason; in a batch; or waiting.
-- Only the project's own functions call it, after checking the caller may read the bucket.
create or replace function file_search.file_parts(p_bucket text, p_name text, p_from integer, p_limit integer) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v file_search.file_version; result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Limit must be 1 through 50' using errcode='22023'; end if;
 select f.* into v from file_search.file_version f join storage.objects o on o.id=f.object_id
 where o.bucket_id=p_bucket and o.name=p_name and f.state not in ('retired','purged') order by f.queued_at desc limit 1;
 if v.version_id is null then raise exception 'No file "%" in this scope', p_name using errcode='22023'; end if;
 select jsonb_build_object('file', p_name, 'state', v.state,
  'parts', (select count(*) from file_search.chunk c where c.version_id=v.version_id),
  'chunks', coalesce(jsonb_agg(jsonb_build_object('chunk_id', c.chunk_id, 'ordinal', c.ordinal, 'place', c.place, 'text', c.body,
    'graph', case when x.chunk_id is not null then 'read' when t.state='failed' then 'failed'
     when c.chunk_id in (select file_search.graph_held_chunks()) then 'in batch' else 'waiting' end,
    'saved_by_name', x.saved_by_name, 'entities', x.entities, 'relations', x.relations,
    'error', case when x.chunk_id is null then t.error end) order by c.ordinal), '[]'::jsonb))
 into result
 from (select * from file_search.chunk k where k.version_id=v.version_id and k.ordinal>=coalesce(p_from, 0) order by k.ordinal limit p_limit) c
 left join file_search.chunk_extraction x on x.chunk_id=c.chunk_id
 left join file_search.chunk_extraction_attempt t on t.chunk_id=c.chunk_id;
 return result;
end $$;

revoke all on function file_search.graph_month_cost(), file_search.graph_waiting(text[]), file_search.graph_has_work(text[]),
 file_search.open_graph_batch(), file_search.claim_unextracted(text[],integer), file_search.graph_batch_sent(uuid,text,text),
 file_search.graph_batch_unsent(uuid,text), file_search.fail_extraction(uuid,text), file_search.close_graph_batch(uuid,jsonb,jsonb,uuid,text),
 file_search.file_parts(text,text,integer,integer)
 from public, anon, authenticated;
revoke all on function file_search.graph_held_chunks() from public, anon;
grant execute on function file_search.graph_held_chunks() to authenticated;

-- The chunks of a bucket whose entities and relations have not been saved, of each file's latest
-- extracted content, with their text, file and place, in file and chunk order; and how many wait in
-- all, and how many of the bucket's files still wait for their text. A chunk an open batch of the
-- graph reader holds is counted apart, as in_batch, and a chunk whose read failed 3 times is listed
-- apart, with its reason. Only the project's own functions call it, after checking the caller may
-- read the bucket.
create or replace function file_search.unextracted(p_bucket text, p_limit integer) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Limit must be 1 through 50' using errcode='22023'; end if;
 with latest as (
  select distinct on (f.object_id) f.version_id, f.object_id, f.state
  from file_search.file_version f where f.state not in ('retired','purged')
  order by f.object_id, f.queued_at desc),
 files as (
  select l.version_id, l.state, o.name from latest l join storage.objects o on o.id=l.object_id where o.bucket_id=p_bucket),
 unread as (
  select c.chunk_id, c.ordinal, c.place, c.body, f.name, t.state as attempt_state, t.error,
   c.chunk_id in (select file_search.graph_held_chunks()) as held
  from file_search.chunk c join files f on f.version_id=c.version_id and f.state='extracted'
  left join file_search.chunk_extraction_attempt t on t.chunk_id=c.chunk_id
  where not exists (select 1 from file_search.chunk_extraction x where x.chunk_id=c.chunk_id)),
 waiting as (select * from unread where not held and attempt_state is distinct from 'failed'),
 page as (select * from waiting order by name, ordinal limit p_limit),
 failed as (select * from unread where attempt_state='failed' order by name, ordinal limit p_limit)
 select jsonb_build_object(
  'chunks', coalesce((select jsonb_agg(jsonb_build_object('chunk_id', p.chunk_id, 'file', p.name, 'place', p.place, 'text', p.body)
    order by p.name, p.ordinal) from page p), '[]'::jsonb),
  'waiting', (select count(*) from waiting),
  'in_batch', (select count(*) from unread where held),
  'failed', (select count(*) from unread where attempt_state='failed'),
  'failed_chunks', coalesce((select jsonb_agg(jsonb_build_object('chunk_id', x.chunk_id, 'file', x.name, 'place', x.place, 'text', x.body, 'error', x.error)
    order by x.name, x.ordinal) from failed x), '[]'::jsonb),
  'awaiting_text', (select count(*) from files where state='waiting'))
 into result;
 return result;
end $$;
revoke all on function file_search.unextracted(text,integer) from public, anon, authenticated;

alter table file_search.graph_batch add column if not exists dropped integer not null default 0 check (dropped>=0);

-- Each entity or relation a batch's read gave that close_graph_batch dropped before its save, with
-- the reason. The part's other entities and relations are saved. Only the project's own functions
-- and postgres read it.
create table if not exists file_search.graph_drop (
 drop_id bigint generated always as identity primary key,
 batch_id uuid not null references file_search.graph_batch(batch_id) on delete cascade,
 chunk_id uuid not null references file_search.chunk(chunk_id) on delete cascade,
 reason text not null,
 item jsonb not null,
 dropped_at timestamptz not null default clock_timestamp()
);
create index if not exists graph_drop_batch on file_search.graph_drop(batch_id);
create index if not exists graph_drop_chunk on file_search.graph_drop(chunk_id);
alter table file_search.graph_drop enable row level security;
revoke all on file_search.graph_drop from public, anon, authenticated;
revoke all on sequence file_search.graph_drop_drop_id_seq from public, anon, authenticated;

-- Trims one read before its save. Of two entities with one name and different types, the first is
-- kept. A relation whose source or target names no kept entity, or that joins an entity to itself,
-- is dropped. Gives the kept entities and relations, and each dropped item with its reason. Lists
-- that are not lists are given back as they came, for save_extraction to refuse.
create or replace function file_search.trim_extraction(p_entities jsonb, p_relations jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare e jsonb; r jsonb; k text; a text; b text; types jsonb:='{}'::jsonb;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb; dropped jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(coalesce(p_entities, 'null'))<>'array' or jsonb_typeof(coalesce(p_relations, 'null'))<>'array' then
  return jsonb_build_object('entities', p_entities, 'relations', p_relations, 'dropped', '[]'::jsonb); end if;
 for e in select x from jsonb_array_elements(p_entities) x loop
  k:=file_search.graph_key(e->>'name');
  if types ? k and types->>k<>file_search.graph_key(e->>'type') then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason', 'Two entities share one name', 'item', e));
   continue;
  end if;
  types:=types||jsonb_build_object(k, file_search.graph_key(e->>'type'));
  ents:=ents||jsonb_build_array(e);
 end loop;
 for r in select x from jsonb_array_elements(p_relations) x loop
  a:=file_search.graph_key(r->>'source'); b:=file_search.graph_key(r->>'target');
  if not (types ? a and types ? b) then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason', 'A relation names an entity the part does not list', 'item', r));
  elsif a=b then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason', 'A relation joins an entity to itself', 'item', r));
  else
   rels:=rels||jsonb_build_array(r);
  end if;
 end loop;
 return jsonb_build_object('entities', ents, 'relations', rels, 'dropped', dropped);
end $$;

-- Closes a sent batch with its results, once. p_results is [{chunk_id, entities, relations}] for a
-- read, [{chunk_id, error}] for an answer that failed, or [{chunk_id, retry}] for a request the batch
-- API did not answer, such as an error on its side, which leaves the chunk waiting with no attempt
-- counted. Each read is trimmed with trim_extraction, its drops are kept in graph_drop, and it is
-- saved with save_extraction under
-- p_saved_by and p_saved_by_name, and a save it refuses counts as a failed read. A chunk of the batch
-- with no result counts as a failed read too. p_usage holds the batch's input_tokens,
-- cache_write_tokens, cache_read_tokens, output_tokens, cost_usd and ended_at, and any problem.
create or replace function file_search.close_graph_batch(p_batch uuid, p_results jsonb, p_usage jsonb,
 p_saved_by uuid, p_saved_by_name text) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare b file_search.graph_batch; r jsonb; ch uuid; res jsonb; t jsonb; n_saved integer:=0; n_failed integer:=0; n_skipped integer:=0; n_retried integer:=0; n_dropped integer:=0; seen uuid[]:='{}';
begin
 if p_saved_by is null then raise exception 'Name who saved the extraction' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_results, 'null'))<>'array' then raise exception 'The results are a list' using errcode='22023'; end if;
 select * into b from file_search.graph_batch where batch_id=p_batch for update;
 if b.batch_id is null or b.sent_at is null then raise exception 'No such sent batch' using errcode='22023'; end if;
 if b.closed_at is not null then return jsonb_build_object('batch_id', p_batch, 'closed', false, 'reason', 'The batch was closed before'); end if;
 for r in select x from jsonb_array_elements(p_results) x loop
  ch:=case when (r->>'chunk_id') ~ '^[0-9a-f-]{36}$' then (r->>'chunk_id')::uuid end;
  continue when ch is null or not ch=any(b.chunks) or ch=any(seen);
  seen:=seen||ch;
  if r ? 'retry' then
   n_retried:=n_retried+1;
   continue;
  end if;
  if r ? 'error' then
   perform file_search.fail_extraction(ch, r->>'error');
   n_failed:=n_failed+1;
   continue;
  end if;
  begin
   t:=file_search.trim_extraction(r->'entities', r->'relations');
   -- Items the project dropped before the batch was closed, such as one that fits none of its classes, are kept too.
   t:=jsonb_set(t, '{dropped}', coalesce(case when jsonb_typeof(r->'dropped')='array' then r->'dropped' end, '[]'::jsonb)||(t->'dropped'));
   res:=file_search.save_extraction(ch, t->'entities', t->'relations', p_saved_by, p_saved_by_name, false);
   if (res->>'saved')::boolean then
    n_saved:=n_saved+1;
    insert into file_search.graph_drop(batch_id, chunk_id, reason, item)
    select p_batch, ch, d->>'reason', d->'item' from jsonb_array_elements(t->'dropped') d;
    n_dropped:=n_dropped+jsonb_array_length(t->'dropped');
   else n_skipped:=n_skipped+1; end if;
  exception when others then
   perform file_search.fail_extraction(ch, sqlerrm);
   n_failed:=n_failed+1;
  end;
 end loop;
 for ch in select x from unnest(b.chunks) x where not x=any(seen) loop
  perform file_search.fail_extraction(ch, 'No result came back for this part');
  n_failed:=n_failed+1;
 end loop;
 update file_search.graph_batch set closed_at=clock_timestamp(), saved=n_saved, failed=n_failed, retried=n_retried, dropped=n_dropped,
  ended_at=coalesce((p_usage->>'ended_at')::timestamptz, clock_timestamp()),
  input_tokens=coalesce((p_usage->>'input_tokens')::bigint, 0), cache_write_tokens=coalesce((p_usage->>'cache_write_tokens')::bigint, 0),
  cache_read_tokens=coalesce((p_usage->>'cache_read_tokens')::bigint, 0), output_tokens=coalesce((p_usage->>'output_tokens')::bigint, 0),
  cost_usd=coalesce((p_usage->>'cost_usd')::numeric, 0), problem=coalesce(p_usage->>'problem', problem)
 where batch_id=p_batch;
 return jsonb_build_object('batch_id', p_batch, 'closed', true, 'saved', n_saved, 'failed', n_failed, 'retried', n_retried, 'dropped', n_dropped, 'saved_before', n_skipped);
end $$;

revoke all on function file_search.trim_extraction(jsonb,jsonb), file_search.close_graph_batch(uuid,jsonb,jsonb,uuid,text)
 from public, anon, authenticated;

-- The parts a read refused for a mistake the trim now drops wait to be read again.
update file_search.chunk_extraction_attempt set state='waiting', attempts=0
where error like 'A relation names an entity this chunk does not:%' or error like 'A relation joins two different entities:%'
 or error like 'Two entities in this chunk share the name %';

-- close_graph_batch as the build holds it, keeping the items fabrik dropped before the batch closed.
-- Closes a sent batch with its results, once. p_results is [{chunk_id, entities, relations}] for a
-- read, [{chunk_id, error}] for an answer that failed, or [{chunk_id, retry}] for a request the batch
-- API did not answer, such as an error on its side, which leaves the chunk waiting with no attempt
-- counted. A read may carry dropped, [{reason, item}], the items the project dropped before it.
-- Each read is trimmed with trim_extraction, its drops and those are kept in graph_drop, and it is
-- saved with save_extraction under
-- p_saved_by and p_saved_by_name, and a save it refuses counts as a failed read. A chunk of the batch
-- with no result counts as a failed read too. p_usage holds the batch's input_tokens,
-- cache_write_tokens, cache_read_tokens, output_tokens, cost_usd and ended_at, and any problem.
create or replace function file_search.close_graph_batch(p_batch uuid, p_results jsonb, p_usage jsonb,
 p_saved_by uuid, p_saved_by_name text) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare b file_search.graph_batch; r jsonb; ch uuid; res jsonb; t jsonb; n_saved integer:=0; n_failed integer:=0; n_skipped integer:=0; n_retried integer:=0; n_dropped integer:=0; seen uuid[]:='{}';
begin
 if p_saved_by is null then raise exception 'Name who saved the extraction' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_results, 'null'))<>'array' then raise exception 'The results are a list' using errcode='22023'; end if;
 select * into b from file_search.graph_batch where batch_id=p_batch for update;
 if b.batch_id is null or b.sent_at is null then raise exception 'No such sent batch' using errcode='22023'; end if;
 if b.closed_at is not null then return jsonb_build_object('batch_id', p_batch, 'closed', false, 'reason', 'The batch was closed before'); end if;
 for r in select x from jsonb_array_elements(p_results) x loop
  ch:=case when (r->>'chunk_id') ~ '^[0-9a-f-]{36}$' then (r->>'chunk_id')::uuid end;
  continue when ch is null or not ch=any(b.chunks) or ch=any(seen);
  seen:=seen||ch;
  if r ? 'retry' then
   n_retried:=n_retried+1;
   continue;
  end if;
  if r ? 'error' then
   perform file_search.fail_extraction(ch, r->>'error');
   n_failed:=n_failed+1;
   continue;
  end if;
  begin
   t:=file_search.trim_extraction(r->'entities', r->'relations');
   -- Items the project dropped before the batch was closed, such as one that fits none of its classes, are kept too.
   t:=jsonb_set(t, '{dropped}', coalesce(case when jsonb_typeof(r->'dropped')='array' then r->'dropped' end, '[]'::jsonb)||(t->'dropped'));
   res:=file_search.save_extraction(ch, t->'entities', t->'relations', p_saved_by, p_saved_by_name, false);
   if (res->>'saved')::boolean then
    n_saved:=n_saved+1;
    insert into file_search.graph_drop(batch_id, chunk_id, reason, item)
    select p_batch, ch, d->>'reason', d->'item' from jsonb_array_elements(t->'dropped') d;
    n_dropped:=n_dropped+jsonb_array_length(t->'dropped');
   else n_skipped:=n_skipped+1; end if;
  exception when others then
   perform file_search.fail_extraction(ch, sqlerrm);
   n_failed:=n_failed+1;
  end;
 end loop;
 for ch in select x from unnest(b.chunks) x where not x=any(seen) loop
  perform file_search.fail_extraction(ch, 'No result came back for this part');
  n_failed:=n_failed+1;
 end loop;
 update file_search.graph_batch set closed_at=clock_timestamp(), saved=n_saved, failed=n_failed, retried=n_retried, dropped=n_dropped,
  ended_at=coalesce((p_usage->>'ended_at')::timestamptz, clock_timestamp()),
  input_tokens=coalesce((p_usage->>'input_tokens')::bigint, 0), cache_write_tokens=coalesce((p_usage->>'cache_write_tokens')::bigint, 0),
  cache_read_tokens=coalesce((p_usage->>'cache_read_tokens')::bigint, 0), output_tokens=coalesce((p_usage->>'output_tokens')::bigint, 0),
  cost_usd=coalesce((p_usage->>'cost_usd')::numeric, 0), problem=coalesce(p_usage->>'problem', problem)
 where batch_id=p_batch;
 return jsonb_build_object('batch_id', p_batch, 'closed', true, 'saved', n_saved, 'failed', n_failed, 'retried', n_retried, 'dropped', n_dropped, 'saved_before', n_skipped);
end $$;

insert into file_search.schema_upgrade(id) values ('0003-graph-reader') on conflict (id) do nothing;
