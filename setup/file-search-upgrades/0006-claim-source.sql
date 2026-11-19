-- 0006-claim-source
-- base: 29c1d11
-- claim_chunks records a chunk from a record's version against its call with the record's id, as claim_files does. It
-- recorded the object's id alone, which a record's chunk does not have, so the claim broke worker_claim_source and every
-- embed run that reached such a chunk failed on it. Safe to run twice. Run as postgres.

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
  returning c.chunk_id, c.version_id, c.object_id, c.record_id, c.body),
 noted as (
  insert into file_search.worker_claim(call_id, version_id, chunk_id, object_id, record_id)
  select p_call, c.version_id, c.chunk_id, c.object_id, c.record_id from claimed c where p_call is not null)
 select c.chunk_id, c.body from claimed c
$$;

insert into file_search.schema_upgrade(id) values ('0006-claim-source') on conflict (id) do nothing;
