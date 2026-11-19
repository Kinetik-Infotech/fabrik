-- fabrik setup: takes an earlier, unfinished attempt back off a project, so setup can build it again from the start.
-- Run as postgres, through fabrik-setup or the SQL Editor. It refuses, and changes nothing, once fabrik holds a record or
-- a file in a scope's bucket: from then on the project holds the person's work, and it stays.
-- It removes fabrik's and file search's schemas with everything in them, their four roles, the empty buckets of fabrik's
-- scopes, file search's schedule and its two secrets, and the Data API's fabrik schema. The Auth users an earlier
-- attempt made stay: the owner's first sign-in gives the owner's a new password. The fabrik_setup schema and the
-- fabrik-setup hosted function stay, for the build that follows. One transaction: a failure keeps nothing.
do $$
declare
 n bigint;
 r record;
begin
 if to_regclass('fabrik.record') is not null then
  execute 'select count(*) from fabrik.record' into n;
  if n > 0 then
   raise exception 'fabrik holds % record(s), so nothing was reset', n using errcode = '55000';
  end if;
 end if;
 if to_regclass('fabrik.scope') is not null then
  execute 'select count(*) from storage.objects o join fabrik.scope s on s.code = o.bucket_id' into n;
  if n > 0 then
   raise exception 'fabrik''s scopes hold % file(s), so nothing was reset', n using errcode = '55000';
  end if;
  -- Each scope's bucket, empty, so the scopes can be made again.
  perform set_config('storage.allow_delete_query', 'true', true);
  execute 'delete from storage.buckets b using fabrik.scope s where s.code = b.id';
 end if;

 -- The Data API stops serving fabrik before the schema goes, so its schema cache can still be built.
 alter role authenticator reset pgrst.db_schemas;
 perform pg_notify('pgrst', 'reload config');

 if to_regnamespace('cron') is not null and exists(select 1 from pg_proc where proname = 'unschedule' and pronamespace = 'cron'::regnamespace) then
  for r in execute 'select jobname from cron.job where jobname in (''file-search-work'', ''graph-reader'')' loop
   perform cron.unschedule(r.jobname);
  end loop;
 end if;
 if to_regclass('vault.secrets') is not null then
  delete from vault.secrets where name in ('file_search_worker_secret', 'file_search_project_url', 'graph_reader_secret', 'anthropic_api_key');
 end if;

 -- Each schema with everything in it, and what depends on it elsewhere: fabrik's and file search's triggers and policies
 -- on storage.objects, and the foreign key to auth.users.
 drop schema if exists fabrik_tests, file_search, fabrik_task, fabrik_storage, fabrik, fabrik_private cascade;

 for r in select rolname from pg_roles where rolname in ('fabrik_owner', 'fabrik_identity', 'fabrik_writer', 'fabrik_reader') loop
  execute format('drop owned by %I cascade', r.rolname);
  execute format('drop role %I', r.rolname);
 end loop;

 if to_regclass('fabrik_setup.person') is not null then
  delete from fabrik_setup.person;
 end if;
end $$;
