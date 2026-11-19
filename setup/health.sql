-- fabrik setup: the health check at the end of setup. Reads only, as postgres, run by fabrik setup --owner. One row, whose ok is true when every part is:
--   scopes        the three scopes are there, each enabled, with a sessions scope for each person with a sign-in;
--   administrator the first administrator is there, enabled;
--   data_api      the Data API serves fabrik;
--   schedule      file search's schedule and both its secrets are there;
--   searchable    file search covers every scope's bucket.
with scopes as (
 select count(*) filter (where code in ('general', 'reference', 'administration') and enabled) as three,
  count(*) filter (where starts_with(code, 'sessions_')) as sessions
 from fabrik.scope
), people as (
 select count(*) filter (where authority_class = 'administrator' and enabled) as administrators,
  count(*) filter (where actor_kind = 'human' and auth_user_id is not null) as humans
 from fabrik.actor
), parts as (
 select
  (select three = 3 and sessions = (select humans from people) from scopes) as scopes,
  (select administrators >= 1 from people) as administrator,
  coalesce((select bool_or(c like 'pgrst.db_schemas=%' and c ~ '(^|[=, ])fabrik(,|$)') from pg_roles r, unnest(r.rolconfig) c where r.rolname = 'authenticator'), false) as data_api,
  exists(select 1 from cron.job where jobname = 'file-search-work' and active)
   and (select count(*) from vault.decrypted_secrets where name in ('file_search_worker_secret', 'file_search_project_url')) = 2 as schedule,
  not exists(select 1 from fabrik.scope s
   where not exists(select 1 from file_search.indexed_bucket b where b.bucket_id = s.code)) as searchable
)
select scopes and administrator and data_api and schedule and searchable as ok, * from parts;
