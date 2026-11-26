-- readable_records as b936cc4 defined it, before 0020-own-records-set: a grant limited to the actor's own records
-- calls is_own_record for each record. own-records-times.sql loads it to time fabrik_find_records before the upgrade.
-- Kept as it was; never part of a build.
grant create on schema fabrik_private to fabrik_identity;
set role fabrik_identity;
create or replace function fabrik_private.readable_records(p_scope uuid, p_kind text, p_title text, p_from timestamptz, p_to timestamptz)
returns setof uuid
language sql stable security definer set search_path=pg_catalog as $$
 with g as materialized (select * from fabrik_private.read_grants()),
 w as materialized (select replace(replace(replace(x,'\','\\'),'%','\%'),'_','\_') w from regexp_split_to_table(btrim(coalesce(p_title,'')),'\s+') x where x<>'')
 select r.record_id from fabrik.record r
 where (p_scope is null or r.scope_id=p_scope) and (p_kind is null or r.kind=p_kind)
  and (not exists(select 1 from w) or exists(select 1 from fabrik.record_version v where v.record_id=r.record_id
   and not exists(select 1 from w where v.title not ilike '%'||w.w||'%')))
  and (p_from is null or exists(select 1 from fabrik.record_version v where v.record_id=r.record_id and v.recorded_at>=p_from and v.recorded_at<p_to))
  and exists(select 1 from g where g.scope_id=r.scope_id and (g.record_kinds is null or r.kind=any(g.record_kinds))
   and (g.record_id is null or g.record_id=r.record_id)
   and case when g.own_records then fabrik_private.is_own_record(g.actor_id,r.record_id) else true end)
$$;
reset role;
revoke create on schema fabrik_private from fabrik_identity;
