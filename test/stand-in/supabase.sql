-- The parts of a new Supabase project that setup.sql and tests.sql rely on, for a local
-- PostgreSQL 17 cluster. Run as the cluster's superuser, supabase_admin, before setup.sql.

-- postgres is not a superuser on Supabase: it creates roles and bypasses row-level security.
create role postgres login createrole createdb bypassrls;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_storage_admin nologin;
grant anon, authenticated, service_role to authenticator;
-- Supabase lets postgres set the Data API's settings on authenticator, as its documentation's
-- alter role authenticator set pgrst.db_schemas does; PostgreSQL 17 asks for the admin option.
grant authenticator to postgres with admin option, inherit false, set false;
grant set on parameter pgrst.db_schemas to postgres;
grant anon, authenticated, service_role to postgres;
-- Supabase lets postgres put policies and triggers on storage's tables, through supautils' policy
-- grants, but not act as their owner. Here postgres holds the owner's rights and cannot switch to it.
grant supabase_storage_admin to postgres with inherit true, set false;
grant create on database fabrik to postgres;

create schema auth;
-- The columns fabrik reads, with the types read from a project on 2026-10-01.
create table auth.users (id uuid primary key, email character varying, created_at timestamptz, last_sign_in_at timestamptz);
create table auth.sessions (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz,
 updated_at timestamptz,
 not_after timestamptz,
 refreshed_at timestamp without time zone,
 user_agent text,
 ip inet
);
create function auth.uid() returns uuid language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
-- The request's claims, as Supabase's auth.jwt() gives them.
create function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant all on auth.users, auth.sessions to postgres;
grant execute on function auth.uid(), auth.jwt() to public;

create schema storage authorization supabase_storage_admin;
set role supabase_storage_admin;
create table storage.buckets (
 id text primary key,
 name text not null unique,
 public boolean not null default false,
 created_at timestamptz default now()
);
-- The columns and unique indexes as read from a project on 2026-09-27, with versioned storage.
create table storage.objects (
 id uuid primary key default gen_random_uuid(),
 bucket_id text references storage.buckets(id),
 name text,
 owner uuid,
 created_at timestamptz default now(),
 updated_at timestamptz default now(),
 last_accessed_at timestamptz default now(),
 metadata jsonb,
 path_tokens text[],
 version text,
 owner_id text,
 user_metadata jsonb,
 archived_at timestamptz,
 is_delete_marker boolean not null default false,
 is_versioned boolean not null default false
);
create unique index objects_bucket_id_name_version_key on storage.objects (bucket_id, name collate "C", version) nulls not distinct;
create unique index idx_objects_current_version on storage.objects (bucket_id, name collate "C") where archived_at is null;
create unique index idx_objects_null_version on storage.objects (bucket_id, name collate "C") where not is_versioned;
alter table storage.objects enable row level security;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to postgres, anon, authenticated, service_role;
-- Supabase's own guard, as read from a project on 2026-09-27: SQL deletes need storage.allow_delete_query.
create function storage.protect_delete() returns trigger language plpgsql as $$
begin
 if coalesce(current_setting('storage.allow_delete_query', true), 'false') != 'true' then
  raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
   using hint = 'This prevents accidental data loss from orphaned objects.', errcode = '42501';
 end if;
 return null;
end $$;
create trigger protect_buckets_delete before delete on storage.buckets for each statement execute function storage.protect_delete();
create trigger protect_objects_delete before delete on storage.objects for each statement execute function storage.protect_delete();
reset role;

create schema extensions authorization postgres;
create extension vector with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Vault, with its secrets unencrypted: nothing secret is kept here.
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text not null, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
language sql as $$ insert into vault.secrets(secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void
language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name), description = coalesce(new_description, description) where id = secret_id $$;
grant usage on schema vault to postgres;
grant all on vault.secrets, vault.decrypted_secrets to postgres;
grant execute on function vault.create_secret(text, text, text), vault.update_secret(uuid, text, text, text) to postgres;

-- pg_net's http_post, which records each call instead of sending it.
create schema net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
 headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds integer default 5000) returns bigint
language sql as $$ insert into net.calls(url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id $$;
create table net._http_response (id bigint, status_code integer, content_type text, headers jsonb, content text,
 timed_out boolean, error_msg text, created timestamptz not null default now());
grant usage on schema net to postgres;
grant all on net.calls, net.calls_id_seq, net._http_response to postgres;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) to postgres;

-- pg_cron's schedule, which records each job instead of running it.
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null, active boolean not null default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$ insert into cron.job(jobname, schedule, command) values (job_name, schedule, command)
 on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
grant usage on schema cron to postgres;
grant all on cron.job, cron.job_jobid_seq to postgres;
create function cron.unschedule(job_name text) returns boolean
language sql as $$ with gone as (delete from cron.job where jobname = job_name returning 1) select exists(select 1 from gone) $$;
grant execute on function cron.schedule(text, text, text), cron.unschedule(text) to postgres;
