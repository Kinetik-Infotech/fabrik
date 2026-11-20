-- fabrik: new-project setup.
-- Builds the fabrik schema on a NEW, EMPTY Supabase project, in its final state.
-- Run once, top to bottom, in the SQL Editor as the project's postgres login
-- (or through apply_migration). It has no BEGIN/COMMIT: sent as one request, it runs as
-- one implicit transaction, so a failure leaves nothing behind. Uses SET ROLE, not SET LOCAL.
-- It carries no data. Create the first administrator and scope afterwards with bootstrap.sql.

-- ===================================================================
-- 1. Internal roles (NOLOGIN). The postgres login is a member of all four.
-- ===================================================================
create role fabrik_owner nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role fabrik_identity nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role fabrik_writer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role fabrik_reader nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
-- Membership lets postgres assign ownership, administer, and pass the administrator-login checks.
grant fabrik_owner, fabrik_identity, fabrik_writer, fabrik_reader to postgres with inherit true, set true;

-- ===================================================================
-- 2. Schemas
-- ===================================================================
create schema fabrik authorization fabrik_owner;
create schema fabrik_private authorization fabrik_owner;
revoke all on schema fabrik, fabrik_private from public;
grant usage on schema fabrik to fabrik_identity, fabrik_writer, fabrik_reader;
grant usage on schema fabrik_private to fabrik_identity, fabrik_writer, fabrik_reader;
-- Global, not IN SCHEMA: a per-schema revoke cannot remove PostgreSQL's global default grant to
-- PUBLIC. postgres keeps its defaults; its one function here is revoked explicitly.
alter default privileges for role fabrik_owner, fabrik_identity, fabrik_writer, fabrik_reader
 revoke execute on functions from public;

-- ===================================================================
-- 3. Tables, constraints and indexes (owned by fabrik_owner)
-- ===================================================================
set role fabrik_owner;

create table fabrik.actor (
 actor_id uuid primary key default gen_random_uuid(),
 display_name text not null check (length(btrim(display_name)) between 1 and 200),
 actor_kind text not null check (actor_kind in ('human','agent','application')),
 accountable_human_id uuid not null references fabrik.actor(actor_id) deferrable initially deferred,
 authority_class text not null check (authority_class in ('administrator','restricted')),
 requires_human_approval boolean not null default false,
 enabled boolean not null default false,
 check (actor_kind <> 'human' or accountable_human_id = actor_id),
 check (authority_class <> 'administrator' or not requires_human_approval),
 -- An application never administers, approves or waits for approval.
 check (actor_kind <> 'application' or (authority_class = 'restricted' and not requires_human_approval))
);
create index actor_accountable_idx on fabrik.actor(accountable_human_id);

reset role;
-- Added as postgres: fabrik_owner has no REFERENCES privilege on auth.users,
-- and postgres cannot grant it one (Supabase protects the auth schema).
alter table fabrik.actor add column auth_user_id uuid unique references auth.users(id);
set role fabrik_owner;

create table fabrik.scope (
 scope_id uuid primary key default gen_random_uuid(),
 code text not null unique check(code ~ '^[a-z][a-z0-9_]{0,62}$'),
 display_name text not null check(length(btrim(display_name)) between 1 and 200),
 description text not null check(length(btrim(description)) between 1 and 4000),
 enabled boolean not null default true,
 created_by uuid not null references fabrik.actor(actor_id),
 created_at timestamptz not null default clock_timestamp(),
 -- Why the scope was added, for a scope added with fabrik_add_scope; null for the scopes setup makes.
 created_reason text check (created_reason is null or length(btrim(created_reason)) between 1 and 4000)
);
create index scope_creator_idx on fabrik.scope(created_by);

create table fabrik.record (
 record_id uuid primary key,
 kind text not null check (kind in ('activity','decision','model','evidence')),
 created_by uuid not null references fabrik.actor(actor_id),
 created_at timestamptz not null default clock_timestamp(),
 scope_id uuid not null references fabrik.scope(scope_id),
 deleted_at timestamptz
);
create index record_creator_idx on fabrik.record(created_by);
create index record_scope_kind_idx on fabrik.record(scope_id,kind,record_id);

create table fabrik.authorisation (
 authorisation_id uuid primary key default gen_random_uuid(),
 executor_actor_id uuid not null references fabrik.actor(actor_id),
 accountable_human_id uuid not null references fabrik.actor(actor_id),
 issued_by_actor_id uuid not null references fabrik.actor(actor_id),
 revoked_by_actor_id uuid references fabrik.actor(actor_id),
 mode text not null check (mode in ('standing_permission','explicit_approval')),
 issuance_request_id uuid not null,
 issuance_hash text not null check (issuance_hash ~ '^[0-9a-f]{64}$'),
 record_kinds text[] not null check (cardinality(record_kinds)>0 and record_kinds <@ array['activity','decision','model','evidence']::text[] and array_position(record_kinds,null) is null),
 record_id uuid references fabrik.record(record_id),
 allowed_actions text[] not null check (cardinality(allowed_actions)>0 and allowed_actions <@ array['read','create','edit','start','hold','complete','reopen','cancel','decide','delete']::text[] and array_position(allowed_actions,null) is null),
 request_id uuid,
 own_records boolean not null default false,
 request_payload jsonb,
 request_hash text check (request_hash ~ '^[0-9a-f]{64}$'),
 issued_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz,
 revoked_at timestamptz,
 consumed_version_id uuid unique,
 consumed_deletion_id uuid unique,
 reason text not null check (length(btrim(reason)) between 1 and 4000),
 revocation_reason text,
 scope_id uuid not null references fabrik.scope(scope_id),
 unique (issued_by_actor_id, issuance_request_id),
 unique (authorisation_id, executor_actor_id, accountable_human_id, mode),
 check (expires_at is null or expires_at > issued_at),
 check ((revoked_at is null and revoked_by_actor_id is null and revocation_reason is null) or
        (revoked_at is not null and revoked_by_actor_id is not null and revocation_reason is not null and length(btrim(revocation_reason)) between 1 and 4000)),
 check ((mode = 'standing_permission' and request_id is null and request_payload is null and request_hash is null and consumed_version_id is null and consumed_deletion_id is null) or
        (mode = 'explicit_approval' and request_id is not null and request_payload is not null and jsonb_typeof(request_payload)='object' and request_hash is not null and expires_at is not null)),
 check (consumed_version_id is null or consumed_deletion_id is null),
 check (request_payload is null or octet_length(request_payload::text) <= 262144),
 constraint authorisation_own_records_check check (not own_records or (record_id is null and mode='standing_permission' and 'read'=any(allowed_actions) and not 'delete'=any(allowed_actions)))
);
create index authorisation_executor_idx on fabrik.authorisation(executor_actor_id, accountable_human_id);
create index authorisation_human_idx on fabrik.authorisation(accountable_human_id);
create index authorisation_issuer_idx on fabrik.authorisation(issued_by_actor_id);
create index authorisation_revoker_idx on fabrik.authorisation(revoked_by_actor_id);
create index authorisation_record_idx on fabrik.authorisation(record_id);
create index authorisation_live_idx on fabrik.authorisation(executor_actor_id, expires_at) where revoked_at is null;
create index authorisation_consumed_pair_idx on fabrik.authorisation(consumed_version_id,authorisation_id);
create index authorisation_scope_idx on fabrik.authorisation(scope_id);
create index authorisation_executor_scope_idx on fabrik.authorisation(executor_actor_id,scope_id,mode) where revoked_at is null;

create sequence fabrik.change_no_seq as bigint;
create table fabrik.record_version (
 version_id uuid primary key default gen_random_uuid(),
 record_id uuid not null references fabrik.record(record_id),
 version_number integer not null check (version_number > 0),
 previous_version_id uuid,
 change_no bigint not null unique check (change_no > 0),
 request_id uuid not null unique,
 request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz not null default clock_timestamp(),
 executor_actor_id uuid not null references fabrik.actor(actor_id),
 accountable_human_id uuid not null references fabrik.actor(actor_id),
 authority_mode text not null check (authority_mode in ('standing_permission','explicit_approval')),
 authorisation_id uuid not null,
 title text not null check (length(btrim(title)) between 1 and 500),
 change_reason text not null check (length(btrim(change_reason)) between 1 and 4000),
 payload_version integer not null default 1 check (payload_version = 1),
 payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
 unique (record_id,version_number),
 unique (version_id,record_id),
 unique (version_id,authorisation_id),
 foreign key (previous_version_id,record_id) references fabrik.record_version(version_id,record_id),
 -- A version keeps the id of the grant it was saved under, without a link to it, so a scope's
 -- grants can go with the scope once its records have moved out.
 check ((version_number=1 and previous_version_id is null) or (version_number>1 and previous_version_id is not null))
);
alter table fabrik.authorisation add constraint authorisation_consumed_fk
 foreign key (consumed_version_id,authorisation_id) references fabrik.record_version(version_id,authorisation_id)
 deferrable initially deferred;
create unique index version_approval_once_idx on fabrik.record_version(authorisation_id) where authority_mode='explicit_approval';
create index version_authorisation_idx on fabrik.record_version(authorisation_id,executor_actor_id,accountable_human_id,authority_mode);
create index version_record_cutoff_idx on fabrik.record_version(record_id,change_no desc);
create index version_previous_idx on fabrik.record_version(previous_version_id,record_id);
create index version_executor_idx on fabrik.record_version(executor_actor_id);
create index version_human_idx on fabrik.record_version(accountable_human_id);
-- A record that came from another system carries payload.source {system, id}. A lookup by that id reads only the
-- versions that have a source, so the index is partial; it covers every version of those records, and the lookup
-- keeps the current one. An expression index on the payload needs no new column to keep in step with a save.
create index version_source_idx on fabrik.record_version((payload->'source'->>'id'),(payload->'source'->>'system'))
 where payload->'source' is not null;
-- The connector's lookups by a record's type, payload.type, read only the versions of that type.
create index version_type_idx on fabrik.record_version((payload->>'type')) where payload->>'type' is not null;

-- The relations a link may carry, a governed list. A link names one of these codes. A relation with
-- single_parent allows one link of it from a version. fabrik_save_relation_type adds one or changes
-- its description; the four below are seeded.
create table fabrik.relation_type (
 code text primary key check (code ~ '^[a-z]+(_[a-z]+)*$' and length(code)<=100),
 description text not null check (length(btrim(description)) between 1 and 1000),
 single_parent boolean not null default false,
 record_id uuid unique references fabrik.record(record_id),
 version_id uuid unique references fabrik.record_version(version_id)
);
insert into fabrik.relation_type(code,description,single_parent) values
 ('supports','The source gives evidence for the target.',false),
 ('describes','The source describes the target.',false),
 ('parent','The target is the plan this activity belongs to; an activity has one.',true),
 ('depends_on','The source waits on the target.',false),
 ('has_task','The source project holds the target task.',false),
 ('blocks','The source task must finish before the target task can start.',false),
 ('has_step','The source workflow has the target as one of its steps.',false),
 ('member_of','The source person or organisation belongs to the target group.',false),
 ('authored','The source person wrote the target.',false),
 ('mentions','The source names the target.',false);

create table fabrik.version_link (
 link_id uuid primary key default gen_random_uuid(),
 source_version_id uuid not null references fabrik.record_version(version_id),
 target_version_id uuid not null references fabrik.record_version(version_id),
 relation text not null references fabrik.relation_type(code),
 locator text check (length(locator)<=2000),
 note text check (length(note)<=4000),
 check (source_version_id <> target_version_id),
 unique nulls not distinct (source_version_id,target_version_id,relation,locator)
);
create index link_target_idx on fabrik.version_link(target_version_id);
create index link_relation_idx on fabrik.version_link(relation);

-- One row per deleted record, written only by the deletion. It keeps who, when, why and under
-- which approval, and a SHA-256 of the content removed, never the content.
create table fabrik.record_deletion (
 deletion_id uuid primary key default gen_random_uuid(),
 request_id uuid not null unique,
 record_id uuid not null unique references fabrik.record(record_id),
 kind text not null,
 scope_id uuid not null references fabrik.scope(scope_id),
 executor_actor_id uuid not null references fabrik.actor(actor_id),
 accountable_human_id uuid not null references fabrik.actor(actor_id),
 authorisation_id uuid not null references fabrik.authorisation(authorisation_id),
 reason text not null check (length(btrim(reason)) between 1 and 4000),
 deleted_at timestamptz not null default clock_timestamp(),
 versions_emptied integer not null check (versions_emptied > 0),
 links_emptied integer not null check (links_emptied >= 0),
 approvals_emptied integer not null check (approvals_emptied >= 0),
 content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$')
);
create index record_deletion_scope_idx on fabrik.record_deletion(scope_id);
create index record_deletion_executor_idx on fabrik.record_deletion(executor_actor_id);
create index record_deletion_human_idx on fabrik.record_deletion(accountable_human_id);
create index record_deletion_authorisation_idx on fabrik.record_deletion(authorisation_id);
alter table fabrik.authorisation add constraint authorisation_consumed_deletion_fk
 foreign key (consumed_deletion_id) references fabrik.record_deletion(deletion_id) deferrable initially deferred;

-- The upgrades this build already contains, and each upgrade applied later. See the setup
-- skill's Upgrades section.
create table fabrik_private.schema_upgrade (
 id text primary key check (id ~ '^[0-9]{4}-[a-z0-9-]+$'),
 applied_at timestamptz not null default clock_timestamp(),
 applied_by_login name not null default session_user
);
revoke all on fabrik_private.schema_upgrade from public;

-- Append-only actor history, written only by the actor trigger. changed_by_actor_id is the
-- administrator who approved the change; for the very first administrator, themselves.
create table fabrik.actor_change (
 change_id bigint generated always as identity primary key,
 actor_id uuid not null references fabrik.actor(actor_id),
 field text not null,
 old_value jsonb,
 new_value jsonb,
 changed_at timestamptz not null default clock_timestamp(),
 changed_by_login name not null default session_user,
 changed_by_actor_id uuid not null references fabrik.actor(actor_id)
);
create index actor_change_actor_time_idx on fabrik.actor_change(actor_id,changed_at);
create index actor_change_changed_by_idx on fabrik.actor_change(changed_by_actor_id);

alter table fabrik.actor enable row level security;
alter table fabrik.scope enable row level security;
alter table fabrik.record enable row level security;
alter table fabrik.authorisation enable row level security;
alter table fabrik.record_version enable row level security;
alter table fabrik.version_link enable row level security;
alter table fabrik.relation_type enable row level security;
alter table fabrik.actor_change enable row level security;
alter table fabrik.record_deletion enable row level security;

-- Table privileges for the internal roles only. No client role receives any.
revoke all on all tables in schema fabrik from public;
revoke all on all sequences in schema fabrik from public;
grant select on fabrik.actor, fabrik.authorisation, fabrik.record, fabrik.record_version, fabrik.version_link, fabrik.scope, fabrik.record_deletion to fabrik_identity;
grant select on fabrik.actor, fabrik.record, fabrik.authorisation, fabrik.record_version, fabrik.version_link, fabrik.scope, fabrik.record_deletion to fabrik_writer, fabrik_reader;
grant insert on fabrik.record, fabrik.record_version, fabrik.version_link, fabrik.authorisation to fabrik_writer;
grant select on fabrik.relation_type to fabrik_identity, fabrik_writer, fabrik_reader;
grant insert, update on fabrik.relation_type to fabrik_writer;
grant update (revoked_at,revoked_by_actor_id,revocation_reason,consumed_version_id,consumed_deletion_id) on fabrik.authorisation to fabrik_writer;
grant usage on sequence fabrik.change_no_seq to fabrik_writer;

-- Function-creating roles need CREATE only while this script runs; revoked in section 5.
grant create on schema fabrik_private to fabrik_identity, fabrik_writer, fabrik_reader;
grant create on schema fabrik to fabrik_writer, fabrik_reader;
reset role;

-- ===================================================================
-- 4. Functions, each created by its owning role
-- ===================================================================

-- 4a. Owned by the postgres (management) login.
-- Supabase does not let postgres grant the auth schema to other roles.
-- This private wrapper returns only auth.uid(), with no access to Auth rows.
create function fabrik_private.request_auth_uid()
returns uuid language sql stable security definer set search_path=pg_catalog
as $$ select auth.uid() $$;

revoke all on function fabrik_private.request_auth_uid() from public, anon, authenticated;
grant execute on function fabrik_private.request_auth_uid() to fabrik_owner, fabrik_identity, fabrik_writer, fabrik_reader;

-- 4b. Owned by fabrik_identity: identity, authority and scope checks.
set role fabrik_identity;

CREATE OR REPLACE FUNCTION fabrik_private.authority_live(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 select exists(select 1 from fabrik.authorisation z
 join fabrik.actor e on e.actor_id=z.executor_actor_id
 join fabrik.actor h on h.actor_id=z.accountable_human_id
 join fabrik.actor i on i.actor_id=z.issued_by_actor_id
 join fabrik.actor ih on ih.actor_id=i.accountable_human_id
 where exists(select 1 from fabrik.scope s where s.scope_id=z.scope_id and s.enabled) and z.authorisation_id=p_id and z.revoked_at is null and (z.expires_at is null or z.expires_at>clock_timestamp())
 and e.enabled and h.enabled and i.enabled and ih.enabled and h.actor_kind='human' and ih.actor_kind='human'
 and e.accountable_human_id=h.actor_id and i.authority_class='administrator')
$function$
;

-- Whether a record is the actor's own: its creator is the actor, or an actor answerable to the same
-- person.
create function fabrik_private.is_own_record(p_actor uuid, p_record uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.record r join fabrik.actor c on c.actor_id=r.created_by
  join fabrik.actor x on x.actor_id=p_actor where r.record_id=p_record and c.accountable_human_id=x.accountable_human_id)
$$;

CREATE OR REPLACE FUNCTION fabrik_private.scope_read_for(p_actor uuid, p_scope uuid, p_kind text, p_record uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 select exists(select 1 from fabrik.actor a join fabrik.actor h on h.actor_id=a.accountable_human_id
 join fabrik.scope s on s.scope_id=p_scope
 where a.actor_id=p_actor and a.enabled and h.enabled and h.actor_kind='human' and (
 (a.authority_class='administrator')
 or (s.enabled and exists(select 1 from fabrik.authorisation z where z.executor_actor_id=a.actor_id
  and z.scope_id=s.scope_id and z.mode='standing_permission' and 'read'=any(z.allowed_actions)
  and (p_kind is null or p_kind=any(z.record_kinds))
  and (z.record_id is null or (p_record is not null and z.record_id=p_record))
  and (not z.own_records or (p_record is not null and fabrik_private.is_own_record(a.actor_id,p_record)))
  and fabrik_private.authority_live(z.authorisation_id)))))
$function$
;

CREATE OR REPLACE FUNCTION fabrik_private.current_actor()
 RETURNS fabrik.actor
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare a fabrik.actor;
begin
 select x.* into a from fabrik.actor x join fabrik.actor h on h.actor_id=x.accountable_human_id
 where x.auth_user_id=fabrik_private.request_auth_uid() and x.enabled and h.enabled and h.actor_kind='human';
 if not found then raise exception 'No enabled fabrik actor for this Auth user' using errcode='42501'; end if;
 return a;
end $function$
;

create or replace function fabrik_private.can_read_record(p_id uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; r fabrik.record;
begin
 a:=fabrik_private.current_actor();
 select * into r from fabrik.record where record_id=p_id;
 if not found then return false; end if;
 return fabrik_private.scope_read_for(a.actor_id,r.scope_id,r.kind,r.record_id);
end $$;

-- Whether the current actor can read the scope as a whole. A grant limited to the actor's own
-- records does not make the scope readable as a whole.
create function fabrik_private.can_read_scope(p_scope uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.current_actor();
 if a.authority_class='administrator' then return exists(select 1 from fabrik.scope where scope_id=p_scope); end if;
 return exists(select 1 from fabrik.authorisation z where z.executor_actor_id=a.actor_id and z.scope_id=p_scope
 and z.mode='standing_permission' and 'read'=any(z.allowed_actions) and not z.own_records and fabrik_private.authority_live(z.authorisation_id));
end $$;

-- Whether the current actor can see that the scope exists: any live read grant, limited or not.
create function fabrik_private.can_see_scope(p_scope uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.current_actor();
 if a.authority_class='administrator' then return exists(select 1 from fabrik.scope where scope_id=p_scope); end if;
 return exists(select 1 from fabrik.authorisation z where z.executor_actor_id=a.actor_id and z.scope_id=p_scope
 and z.mode='standing_permission' and 'read'=any(z.allowed_actions) and fabrik_private.authority_live(z.authorisation_id));
end $$;

-- Whether the actor may create a record of the kind in the scope: whoever can read it, or a holder
-- of a live grant with create limited to the actor's own records.
create function fabrik_private.scope_insert_for(p_actor uuid, p_scope uuid, p_kind text) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.scope_read_for(p_actor,p_scope,p_kind,null)
 or exists(select 1 from fabrik.actor a join fabrik.actor h on h.actor_id=a.accountable_human_id
  join fabrik.scope s on s.scope_id=p_scope and s.enabled
  join fabrik.authorisation z on z.executor_actor_id=a.actor_id and z.scope_id=s.scope_id
  where a.actor_id=p_actor and a.enabled and h.enabled and h.actor_kind='human'
   and z.mode='standing_permission' and z.own_records and 'create'=any(z.allowed_actions) and p_kind=any(z.record_kinds)
   and fabrik_private.authority_live(z.authorisation_id))
$$;

create or replace function fabrik_private.assert_request_scope(p jsonb,p_actor uuid) returns void
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r fabrik.record; t record; l jsonb; sid uuid:=(p->>'scope_id')::uuid;
begin
 if not exists(select 1 from fabrik.scope where scope_id=sid and enabled) then
  raise exception 'Scope or record unavailable' using errcode='42501';
 end if;
 select * into r from fabrik.record where record_id=(p->>'record_id')::uuid;
 if found then
  if r.scope_id<>sid or r.kind<>p->>'kind' or not fabrik_private.scope_read_for(p_actor,sid,r.kind,r.record_id) then
   raise exception 'Scope or record unavailable' using errcode='42501';
  end if;
  if r.deleted_at is not null then raise exception 'The record was deleted' using errcode='23514'; end if;
 elsif not fabrik_private.scope_insert_for(p_actor,sid,p->>'kind') then
  raise exception 'Scope or record unavailable' using errcode='42501';
 end if;
 for l in select value from jsonb_array_elements(p->'links') loop
  select v.record_id,target_record.scope_id,target_record.kind,target_record.deleted_at into t from fabrik.record_version v join fabrik.record target_record using(record_id)
  where v.version_id=(l->>'target_version_id')::uuid;
  if not found or t.deleted_at is not null then raise exception 'Link target unavailable' using errcode='42501'; end if;
  if t.scope_id<>sid or not fabrik_private.scope_read_for(p_actor,sid,t.kind,t.record_id) then
   raise exception 'Link target unavailable' using errcode='42501';
  end if;
 end loop;
end $$;

create function fabrik_private.can_insert_record(p_scope uuid,p_kind text) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.scope where scope_id=p_scope and enabled)
 and fabrik_private.scope_insert_for((fabrik_private.current_actor()).actor_id,p_scope,p_kind)
$$;

create function fabrik_private.can_insert_version(p_record uuid,p_authorisation uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.record r join fabrik.authorisation z on z.scope_id=r.scope_id
 where r.record_id=p_record and z.authorisation_id=p_authorisation
 and z.executor_actor_id=(fabrik_private.current_actor()).actor_id
 and fabrik_private.authority_live(z.authorisation_id) and fabrik_private.can_read_record(r.record_id))
$$;

create function fabrik_private.can_link(p_source uuid,p_target uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.record_version sv join fabrik.record sr on sr.record_id=sv.record_id
 join fabrik.record_version tv on tv.version_id=p_target join fabrik.record tr on tr.record_id=tv.record_id
 where sv.version_id=p_source and sr.scope_id=tr.scope_id
 and fabrik_private.can_read_record(sr.record_id) and fabrik_private.can_read_record(tr.record_id))
$$;

create function fabrik_private.guard_actor_reference() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if not exists(select 1 from fabrik.actor where actor_id=new.accountable_human_id and actor_kind='human') then
  raise exception 'Accountable actor must be human' using errcode='23514';
 end if;
 return new;
end $$;

create function fabrik_private.acting_actor()
returns fabrik.actor language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; named text;
begin
 named:=nullif(current_setting('fabrik.provisioning_actor',true),'');
 if named is not null and fabrik_private.request_auth_uid() is null
    and pg_has_role(session_user,'fabrik_owner','MEMBER') then
  select x.* into a from fabrik.actor x join fabrik.actor h on h.actor_id=x.accountable_human_id
  where x.actor_id=named::uuid and x.enabled and x.authority_class='administrator' and h.enabled and h.actor_kind='human';
  if not found then raise exception 'Enabled administrator approver required' using errcode='42501'; end if;
  return a;
 end if;
 return fabrik_private.current_actor();
end $$;

-- An actor's name, by id: the reads name an actor's accountable person with it.
create function fabrik_private.actor_name(p_actor uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select display_name from fabrik.actor where actor_id=p_actor
$$;

-- The record a deletion in this transaction is emptying; set only by fabrik_private.erase_record.
create function fabrik_private.deleting_record() returns uuid
language sql stable set search_path=pg_catalog as $$
 select nullif(current_setting('fabrik.deleting_record',true),'')::uuid
$$;

-- Whether an approval request carries a record's content: a save of the record itself, or a save
-- whose links point at one of its versions. A deletion request carries none.
create function fabrik_private.carries_record(p jsonb, p_record uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select p->>'operation' is null and (p->>'record_id'=p_record::text
  or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p->'links')='array' then p->'links' else '[]'::jsonb end) l
   join fabrik.record_version v on v.version_id::text=l->>'target_version_id' where v.record_id=p_record))
$$;

-- An approval request with a record's content removed: all of it, for a save of the record
-- itself; otherwise the note and locator of each link to one of its versions.
create function fabrik_private.erased_request(p jsonb, p_record uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select case when p->>'record_id'=p_record::text then '{}'::jsonb
  else jsonb_set(p,'{links}',coalesce((select jsonb_agg(
    case when exists(select 1 from fabrik.record_version v where v.version_id::text=x.l->>'target_version_id' and v.record_id=p_record)
     then x.l||(case when x.l->>'note' is not null then '{"note":"Deleted"}'::jsonb else '{}'::jsonb end)
         ||(case when x.l->>'locator' is not null then '{"locator":"Deleted"}'::jsonb else '{}'::jsonb end)
     else x.l end order by x.n)
   from jsonb_array_elements(p->'links') with ordinality as x(l,n)),'[]'::jsonb)) end
$$;

-- What deleting a record would empty, and the records whose latest version links to it. Seen
-- whole, whatever the caller may read, so an approval and its deletion compare the same list.
create function fabrik_private.deletion_facts(p_record uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 with mine as (select version_id from fabrik.record_version where record_id=p_record),
 latest as (select distinct on (record_id) record_id,version_id from fabrik.record_version where record_id<>p_record order by record_id,change_no desc)
 select jsonb_build_object(
  'versions',(select count(*) from mine),
  'links',(select count(*) from fabrik.version_link l where l.source_version_id in (select version_id from mine) or l.target_version_id in (select version_id from mine)),
  'approvals',(select count(*) from fabrik.authorisation z where z.mode='explicit_approval' and fabrik_private.carries_record(z.request_payload,p_record)),
  'dependents',coalesce((select jsonb_agg(d.record_id order by d.record_id) from (select distinct q.record_id from latest q
    join fabrik.version_link l on l.source_version_id=q.version_id where l.target_version_id in (select version_id from mine)) d),'[]'::jsonb))
$$;

-- An activity state by its current name: versions saved by an older build carry planned,
-- active and on_hold, which are pending, in_progress and paused.
create function fabrik_private.activity_state(p_state text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case p_state when 'planned' then 'pending' when 'active' then 'in_progress' when 'on_hold' then 'paused' else p_state end
$$;

-- The records the current actor may read, each checked once, as can_read_record checks it.
create or replace function fabrik_private.readable_records() returns setof uuid
language sql stable security definer set search_path=pg_catalog as $$
 select r.record_id from fabrik.record r, lateral (select (fabrik_private.current_actor()).actor_id) a
 where fabrik_private.scope_read_for(a.actor_id,r.scope_id,r.kind,r.record_id)
$$;

-- Whether p_record is reached from p_targets along each record's latest links of p_relation.
create or replace function fabrik_private.activity_loop(p_record uuid, p_relation text, p_targets uuid[]) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 with recursive walk(record_id) as (
  select unnest(p_targets)
  union
  select t.record_id from walk w
   cross join lateral (select v.version_id from fabrik.record_version v where v.record_id=w.record_id order by v.change_no desc limit 1) lv
   join fabrik.version_link l on l.source_version_id=lv.version_id and l.relation=p_relation
   join fabrik.record_version t on t.version_id=l.target_version_id
   where w.record_id<>p_record)
 select exists(select 1 from walk where record_id=p_record)
$$;

-- The finish order breaks an activity save p would leave, both ways: the activity finishing before a
-- child, or a deliverable it waits on, and its parent, or an activity waiting on it as a deliverable,
-- finishing before it. A finish is the forecast finish, or the baseline finish where the forecast is
-- null. A cancelled activity, and one with no finish, is left out. The save's own links name its
-- parent and deliverables; each other record is read at its latest version.
create or replace function fabrik_private.finish_order_problems(p jsonb) returns text[]
language sql stable security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
 with me as (
  select (p->>'record_id')::uuid rid, p->>'title' title, p->'payload' payload,
   coalesce(p->'payload'->>'forecast_finish_at',p->'payload'->>'baseline_finish_at')::timestamptz fin
  where p->>'kind'='activity' and fabrik_private.activity_state(p->'payload'->>'state')<>'cancelled'
   and coalesce(p->'payload'->>'forecast_finish_at',p->'payload'->>'baseline_finish_at') is not null
 ), other as (
  -- Each other activity's latest version, with the relation that joins it to this one: child, parent,
  -- deliverable (this one waits on it) or waiter (it waits on this one, a deliverable).
  select 'child' way, cv.* from me join fabrik.record_version tv on tv.record_id=me.rid
   join fabrik.version_link l on l.target_version_id=tv.version_id and l.relation='parent'
   join fabrik.record_version cv on cv.version_id=l.source_version_id
  union all
  select 'waiter', cv.* from me join fabrik.record_version tv on tv.record_id=me.rid
   join fabrik.version_link l on l.target_version_id=tv.version_id and l.relation='depends_on'
   join fabrik.record_version cv on cv.version_id=l.source_version_id
   where me.payload->>'task_type'='deliverable'
  union all
  select case z->>'relation' when 'parent' then 'parent' else 'deliverable' end, lv.*
   from me cross join jsonb_array_elements(p->'links') z
   join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
   cross join lateral (select v.* from fabrik.record_version v where v.record_id=t.record_id order by v.change_no desc limit 1) lv
   where z->>'relation' in ('parent','depends_on')
 ), live as (
  select distinct o.way, o.record_id, o.title, o.payload,
   coalesce(o.payload->>'forecast_finish_at',o.payload->>'baseline_finish_at')::timestamptz fin,
   exists(select 1 from fabrik.version_link ol where ol.source_version_id=o.version_id and ol.relation='parent') has_parent
  from other o join fabrik.record r on r.record_id=o.record_id
  where r.kind='activity' and r.deleted_at is null and o.record_id<>(p->>'record_id')::uuid
   and not exists(select 1 from fabrik.record_version n where n.record_id=o.record_id and n.change_no>o.change_no)
   and fabrik_private.activity_state(o.payload->>'state')<>'cancelled'
   and coalesce(o.payload->>'forecast_finish_at',o.payload->>'baseline_finish_at') is not null
   and (o.way<>'deliverable' or o.payload->>'task_type'='deliverable')
 ), pair as (
  -- The earlier activity, and the later one it contains or waits on.
  select case when l.way in ('child','deliverable') then m.title else l.title end early_title,
   case when l.way in ('child','deliverable') then m.fin else l.fin end early_fin,
   case when l.way in ('child','deliverable') then l.payload else m.payload end late_payload,
   case when l.way in ('child','deliverable') then l.title else m.title end late_title,
   case when l.way in ('child','deliverable') then l.fin else m.fin end late_fin,
   l.way in ('deliverable','waiter') waits,
   case when l.way='child' then exists(select 1 from jsonb_array_elements(p->'links') z where z->>'relation'='parent') else l.has_parent end early_has_parent
  from me m cross join live l
 )
 -- A plan under a plan with no parent is a sprint; one deeper is a plan. A time carries its year
 -- when the other falls in another year.
 select coalesce(array_agg(format('%s finishes %s, before its %s %s, which finishes %s',early_title,
   to_char(early_fin at time zone 'Europe/London',f),
   case when waits then 'deliverable' when late_payload->>'task_type' in ('deliverable','blocker') then late_payload->>'task_type'
    when late_payload->>'activity_kind'='plan' then case when early_has_parent then 'plan' else 'sprint' end else 'task' end,
   coalesce(nullif(btrim(late_payload->>'index'),''),late_title),
   to_char(late_fin at time zone 'Europe/London',f)) order by early_title,late_fin,late_title),'{}')
 from pair cross join lateral (select case when extract(year from early_fin at time zone 'Europe/London')<>extract(year from late_fin at time zone 'Europe/London')
   then 'FMDD Mon YYYY HH24:MI' else 'FMDD Mon HH24:MI' end f) fmt
 where early_fin<late_fin
$$;


-- The versions saved from p_from until p_to whose record the current actor may read, with each
-- record's kind and scope.
create or replace function fabrik_private.audit_versions(p_from timestamptz, p_to timestamptz)
returns table(recorded_at timestamptz, version_id uuid, record_id uuid, title text, change_reason text, executor_actor_id uuid,
 version_number integer, authorisation_id uuid, accountable_human_id uuid, kind text, scope_id uuid)
language sql stable security definer set search_path=pg_catalog as $$
 select v.recorded_at,v.version_id,v.record_id,v.title,v.change_reason,v.executor_actor_id,v.version_number,v.authorisation_id,v.accountable_human_id,r.kind,r.scope_id
 from fabrik.record_version v join fabrik.record r on r.record_id=v.record_id
 where v.recorded_at>=p_from and v.recorded_at<p_to and r.record_id in (select fabrik_private.readable_records())
$$;
revoke all on function fabrik_private.readable_records(), fabrik_private.activity_loop(uuid,text,uuid[]),
 fabrik_private.finish_order_problems(jsonb), fabrik_private.audit_versions(timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function fabrik_private.readable_records(), fabrik_private.audit_versions(timestamptz,timestamptz) to fabrik_owner, fabrik_reader;
grant execute on function fabrik_private.activity_loop(uuid,text,uuid[]), fabrik_private.finish_order_problems(jsonb) to fabrik_owner, fabrik_writer;

grant execute on function fabrik_private.current_actor(), fabrik_private.authority_live(uuid),
 fabrik_private.can_read_record(uuid), fabrik_private.guard_actor_reference(),
 fabrik_private.scope_read_for(uuid,uuid,text,uuid), fabrik_private.assert_request_scope(jsonb,uuid),
 fabrik_private.can_read_scope(uuid), fabrik_private.can_insert_record(uuid,text),
 fabrik_private.can_see_scope(uuid), fabrik_private.is_own_record(uuid,uuid), fabrik_private.scope_insert_for(uuid,uuid,text),
 fabrik_private.can_insert_version(uuid,uuid), fabrik_private.can_link(uuid,uuid),
 fabrik_private.deleting_record(), fabrik_private.deletion_facts(uuid), fabrik_private.actor_name(uuid),
 fabrik_private.carries_record(jsonb,uuid), fabrik_private.erased_request(jsonb,uuid),
 fabrik_private.activity_state(text)
 to fabrik_owner, fabrik_writer, fabrik_reader;
revoke all on function fabrik_private.acting_actor() from public, anon, authenticated;
grant execute on function fabrik_private.acting_actor() to fabrik_owner, fabrik_writer, fabrik_reader;
reset role;

-- 4c. Owned by fabrik_owner: the write check, row holds and trigger guards.
set role fabrik_owner;

-- Every write runs at READ COMMITTED. Writes run side by side.
create function fabrik_private.lock_writes() returns void
language plpgsql volatile set search_path=pg_catalog as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'fabrik writes require READ COMMITTED' using errcode='25001';
 end if;
end $$;

grant execute on function fabrik_private.lock_writes() to fabrik_writer;

-- Holds the records p_records, in record id order, until the transaction ends: shared for a save,
-- which several saves hold at once, or exclusive for a deletion or a move.
create function fabrik_private.hold_records(p_records uuid[], p_exclusive boolean) returns void
language plpgsql volatile security definer set search_path=pg_catalog as $$
begin
 if p_exclusive then
  perform 1 from fabrik.record where record_id=any(p_records) order by record_id for update;
 else
  perform 1 from fabrik.record where record_id=any(p_records) order by record_id for share;
 end if;
end $$;

-- Holds an exact approval until the transaction ends, so it is used once. A standing grant is not held.
create function fabrik_private.hold_approval(p_authorisation_id uuid) returns void
language plpgsql volatile security definer set search_path=pg_catalog as $$
begin
 perform 1 from fabrik.authorisation where authorisation_id=p_authorisation_id and mode='explicit_approval' for update;
end $$;

revoke all on function fabrik_private.hold_records(uuid[],boolean), fabrik_private.hold_approval(uuid) from public, anon, authenticated;
grant execute on function fabrik_private.hold_records(uuid[],boolean), fabrik_private.hold_approval(uuid) to fabrik_writer;

create or replace function fabrik_private.guard_actor_change()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 perform fabrik_private.lock_writes();
 if not pg_has_role(session_user,'fabrik_owner','MEMBER') or fabrik_private.request_auth_uid() is not null then
  raise exception 'Actor changes require the administrator login without an Auth identity' using errcode='42501';
 end if;
 if tg_op='DELETE' then raise exception 'Retire actors; do not delete them' using errcode='23514'; end if;
 -- Every change names its approving administrator, except the very first administrator.
 if nullif(current_setting('fabrik.provisioning_actor',true),'') is null then
  if tg_op<>'INSERT' or exists(select 1 from fabrik.actor) then
   raise exception 'Actor changes must name the approving administrator' using errcode='42501';
  end if;
  if new.actor_kind<>'human' or new.authority_class<>'administrator' or new.accountable_human_id<>new.actor_id or not new.enabled then
   raise exception 'The first actor must be an enabled human administrator, accountable to themselves' using errcode='23514';
  end if;
 else
  perform fabrik_private.acting_actor();
 end if;
 if tg_op='UPDATE' then
  if new.actor_id<>old.actor_id or new.actor_kind<>old.actor_kind or new.accountable_human_id<>old.accountable_human_id then
   raise exception 'Actor identity and accountability are fixed' using errcode='23514';
  end if;
  if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
   raise exception 'Auth user link is immutable once set' using errcode='23514';
  end if;
 end if;
 return new;
end $$;

create function fabrik_private.guard_version() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 -- A deletion empties its record's versions and marks the record deleted; nothing else changes.
 if tg_op='UPDATE' and current_user='fabrik_owner' and new.record_id=fabrik_private.deleting_record() then
  if tg_table_name='record' and to_jsonb(old)->>'deleted_at' is null and to_jsonb(new)->>'deleted_at' is not null
   and (to_jsonb(new)-'deleted_at')=(to_jsonb(old)-'deleted_at') then return new; end if;
  if tg_table_name='record_version' and (to_jsonb(new)-array['title','change_reason','payload'])=(to_jsonb(old)-array['title','change_reason','payload'])
   and to_jsonb(new)->>'title'='Deleted' and to_jsonb(new)->>'change_reason'='Deleted' and to_jsonb(new)->'payload'='{}'::jsonb then return new; end if;
 end if;
 -- A move changes only its records' scope.
 if tg_op='UPDATE' and current_user='fabrik_owner' and tg_table_name='record' and new.record_id=any(fabrik_private.moving_records())
  and (to_jsonb(new)-'scope_id')=(to_jsonb(old)-'scope_id') then return new; end if;
 if tg_op<>'INSERT' then raise exception 'Saved versions and record identities are immutable' using errcode='23514'; end if;
 if current_user<>'fabrik_writer' then raise exception 'Use fabrik_save_version' using errcode='42501'; end if;
 if tg_table_name='record_version' and exists(select 1 from fabrik.record where record_id=new.record_id and deleted_at is not null) then
  raise exception 'The record was deleted' using errcode='23514';
 end if;
 return new;
end $$;

create function fabrik_private.guard_version_link() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 -- A deletion empties the text of every link from or to its record's versions.
 if tg_op='UPDATE' and current_user='fabrik_owner' and fabrik_private.deleting_record() is not null
  and exists(select 1 from fabrik.record_version v where v.record_id=fabrik_private.deleting_record() and v.version_id in (old.source_version_id,old.target_version_id))
  and (to_jsonb(new)-array['locator','note'])=(to_jsonb(old)-array['locator','note'])
  and new.locator is not distinct from (case when old.locator is null then null else 'Deleted '||old.link_id end)
  and new.note is not distinct from (case when old.note is null then null else 'Deleted' end) then
  return new;
 end if;
 if tg_op<>'INSERT' then raise exception 'Saved links are immutable' using errcode='23514'; end if;
 if current_user<>'fabrik_writer' or new.source_version_id::text is distinct from current_setting('fabrik.saving_version',true) then
  raise exception 'Links must be inserted by the save creating their source version' using errcode='42501';
 end if;
 -- A relation with single_parent allows one link of it from a version. Only the save creating the
 -- version inserts its links, so two cannot arrive at once.
 if exists(select 1 from fabrik.relation_type t where t.code=new.relation and t.single_parent)
  and exists(select 1 from fabrik.version_link l where l.source_version_id=new.source_version_id and l.relation=new.relation) then
  raise exception 'Only one % is allowed',new.relation using errcode='23514';
 end if;
 return new;
end $$;

CREATE OR REPLACE FUNCTION fabrik_private.guard_authorisation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare a fabrik.actor;
begin
 -- Deleting an empty scope deletes its grants and approvals, only from fabrik_private.delete_scope.
 if tg_op='DELETE' and current_user='fabrik_owner' and old.scope_id=fabrik_private.deleting_scope() then return old; end if;
 -- A deletion empties the approval requests that carried its record's content.
 if tg_op='UPDATE' and current_user='fabrik_owner' and fabrik_private.deleting_record() is not null then
  if old.mode='explicit_approval' and fabrik_private.carries_record(old.request_payload,fabrik_private.deleting_record())
   and (to_jsonb(new)-array['request_payload','reason'])=(to_jsonb(old)-array['request_payload','reason'])
   and new.request_payload=fabrik_private.erased_request(old.request_payload,fabrik_private.deleting_record())
   and new.reason=(case when old.request_payload->>'record_id'=fabrik_private.deleting_record()::text then 'Deleted' else old.reason end) then
   return new;
  end if;
  raise exception 'A deletion empties only the approvals that carry its record' using errcode='42501';
 end if;
 if current_user<>'fabrik_writer' then raise exception 'Use authority functions' using errcode='42501'; end if;
 a:=fabrik_private.acting_actor();
 if tg_op='DELETE' then raise exception 'Authorisations are retained' using errcode='23514'; end if;
 if tg_op='INSERT' then
  if a.authority_class<>'administrator' or new.issued_by_actor_id<>a.actor_id then raise exception 'Administrator issuer required' using errcode='42501'; end if;
  if not exists(select 1 from fabrik.actor e join fabrik.actor h on h.actor_id=e.accountable_human_id
   where e.actor_id=new.executor_actor_id and h.actor_id=new.accountable_human_id and h.actor_kind='human' and e.enabled and h.enabled) then
   raise exception 'Invalid executor or accountable human' using errcode='23514';
  end if;
  if new.expires_at is null and new.mode='explicit_approval' then
   raise exception 'Exact approval requires expiry' using errcode='23514';
  end if;
  return new;
 end if;
 if (to_jsonb(new)-array['revoked_at','revoked_by_actor_id','revocation_reason','consumed_version_id','consumed_deletion_id'])
   is distinct from (to_jsonb(old)-array['revoked_at','revoked_by_actor_id','revocation_reason','consumed_version_id','consumed_deletion_id']) then
  raise exception 'Authority scope is immutable; revoke and issue another grant' using errcode='23514';
 end if;
 if row(new.revoked_at,new.revoked_by_actor_id,new.revocation_reason) is distinct from row(old.revoked_at,old.revoked_by_actor_id,old.revocation_reason) then
  if a.authority_class<>'administrator' or old.revoked_at is not null or new.revoked_at is null or new.revoked_by_actor_id<>a.actor_id then
   raise exception 'Invalid revocation' using errcode='42501';
  end if;
 end if;
 if new.consumed_version_id is distinct from old.consumed_version_id then
  if old.consumed_version_id is not null or new.consumed_version_id is null or old.mode<>'explicit_approval'
    or new.executor_actor_id<>a.actor_id or not fabrik_private.authority_live(new.authorisation_id)
    or not exists(select 1 from fabrik.record_version where version_id=new.consumed_version_id and authorisation_id=new.authorisation_id and executor_actor_id=a.actor_id) then
   raise exception 'Invalid approval consumption' using errcode='42501';
  end if;
 end if;
 if new.consumed_deletion_id is distinct from old.consumed_deletion_id then
  if old.consumed_deletion_id is not null or old.consumed_version_id is not null or new.consumed_deletion_id is null or old.mode<>'explicit_approval'
    or new.executor_actor_id<>a.actor_id or not fabrik_private.authority_live(new.authorisation_id)
    or not exists(select 1 from fabrik.record_deletion where deletion_id=new.consumed_deletion_id and authorisation_id=new.authorisation_id and executor_actor_id=a.actor_id) then
   raise exception 'Invalid approval consumption' using errcode='42501';
  end if;
 end if;
 return new;
end $function$
;

create function fabrik_private.guard_scope() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 perform fabrik_private.lock_writes();
 if tg_op='DELETE' then
  if current_user='fabrik_owner' and old.scope_id=fabrik_private.deleting_scope() then return old; end if;
  raise exception 'Disable scopes; delete only an empty one, with fabrik_delete_scope' using errcode='23514';
 end if;
 if tg_op='UPDATE' and row(new.scope_id,new.code,new.created_by,new.created_at,new.created_reason) is distinct from row(old.scope_id,old.code,old.created_by,old.created_at,old.created_reason) then
  raise exception 'Scope identity is fixed' using errcode='23514';
 end if;
 return new;
end $$;

create function fabrik_private.log_actor_change()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare prior jsonb; approver uuid;
begin
 -- The guard has already refused a change with no approver, other than the first administrator.
 approver := coalesce(nullif(current_setting('fabrik.provisioning_actor',true),'')::uuid, new.actor_id);
 prior := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
 insert into fabrik.actor_change(actor_id,field,old_value,new_value,changed_by_actor_id)
 select new.actor_id,v.key,prior->v.key,v.value,approver from jsonb_each(to_jsonb(new)) v
 where tg_op='INSERT' or (prior->v.key) is distinct from v.value;
 return new;
end $$;

create function fabrik_private.guard_actor_change_log()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op<>'INSERT' then raise exception 'Actor change history is append-only' using errcode='23514'; end if;
 if current_user<>'fabrik_owner' or pg_trigger_depth()<2 then
  raise exception 'Actor change history is written only by the actor trigger' using errcode='42501';
 end if;
 return new;
end $$;

revoke all on function fabrik_private.log_actor_change(), fabrik_private.guard_actor_change_log() from public, anon, authenticated;

-- After any actor update, at least one approver must remain: an enabled administrator whose
-- accountable person is an enabled human. Otherwise no change could ever be approved again.
create function fabrik_private.guard_approver_remains()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if not exists(select 1 from fabrik.actor x join fabrik.actor h on h.actor_id=x.accountable_human_id
   where x.enabled and x.authority_class='administrator' and h.enabled and h.actor_kind='human') then
  raise exception 'At least one enabled administrator must remain' using errcode='23514';
 end if;
 return null;
end $$;
revoke all on function fabrik_private.guard_approver_remains() from public, anon, authenticated;

-- Actor provisioning, for the administrator login only. Each change is attributed to its approver.
create function fabrik_private.provision_first_administrator(p_auth_user_id uuid, p_display_name text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare id uuid:=gen_random_uuid();
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_auth_user_id is null then raise exception 'Auth user id required' using errcode='22023'; end if;
 perform set_config('fabrik.provisioning_actor','',true);
 insert into fabrik.actor(actor_id,auth_user_id,display_name,actor_kind,accountable_human_id,authority_class,requires_human_approval,enabled)
 values(id,p_auth_user_id,p_display_name,'human',id,'administrator',false,true);
 return id;
end $$;

create function fabrik_private.provision_actor(p_approver_actor_id uuid, p_auth_user_id uuid, p_display_name text,
 p_actor_kind text, p_accountable_human_id uuid, p_authority_class text, p_requires_human_approval boolean)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare id uuid:=gen_random_uuid(); previous_actor text;
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_approver_actor_id is null then raise exception 'Administrator approver required' using errcode='22023'; end if;
 if p_auth_user_id is null then raise exception 'Auth user id required' using errcode='22023'; end if;
 previous_actor:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',p_approver_actor_id::text,true);
 -- A person is accountable to themselves.
 insert into fabrik.actor(actor_id,auth_user_id,display_name,actor_kind,accountable_human_id,authority_class,requires_human_approval,enabled)
 values(id,p_auth_user_id,p_display_name,p_actor_kind,case when p_actor_kind='human' then id else p_accountable_human_id end,
  p_authority_class,coalesce(p_requires_human_approval,false),true);
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 return id;
exception when others then
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 raise;
end $$;

create function fabrik_private.provision_actor_enabled(p_approver_actor_id uuid, p_actor_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare previous_actor text;
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_approver_actor_id is null then raise exception 'Administrator approver required' using errcode='22023'; end if;
 previous_actor:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',p_approver_actor_id::text,true);
 update fabrik.actor set enabled=p_enabled where actor_id=p_actor_id;
 if not found then raise exception 'Actor unavailable' using errcode='22023'; end if;
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
exception when others then
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 raise;
end $$;

revoke all on function fabrik_private.provision_first_administrator(uuid,text),
 fabrik_private.provision_actor(uuid,uuid,text,text,uuid,text,boolean),
 fabrik_private.provision_actor_enabled(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function fabrik_private.provision_first_administrator(uuid,text),
 fabrik_private.provision_actor(uuid,uuid,text,text,uuid,text,boolean),
 fabrik_private.provision_actor_enabled(uuid,uuid,boolean) to fabrik_owner;
-- The deletion log takes a row only from erase_record, for the record it is emptying.
create function fabrik_private.guard_record_deletion() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' and current_user='fabrik_owner' then
  if new.record_id=fabrik_private.deleting_record() then return new; end if;
 end if;
 raise exception 'Record deletions are append-only; use fabrik_delete_record' using errcode='23514';
end $$;

-- Empties a record's content: each version's title, reason and payload, the text of each link
-- from or to it, and what each approval request carried of it, then logs the deletion with a
-- SHA-256 of what was removed. fabrik_delete_record calls it after every check.
create function fabrik_private.erase_record(p_request jsonb, p_authorisation uuid, p_executor uuid, p_human uuid)
returns fabrik.record_deletion
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare rid uuid:=(p_request->>'record_id')::uuid; r fabrik.record; d fabrik.record_deletion; fp text; nv integer; nl integer; na integer;
begin
 select * into r from fabrik.record where record_id=rid for update;
 if not found or r.deleted_at is not null then raise exception 'The record was deleted' using errcode='23514'; end if;
 perform set_config('fabrik.deleting_record',rid::text,true);
 select encode(sha256(convert_to(jsonb_build_object('format',1,'record',rid,
  'versions',coalesce((select jsonb_agg(jsonb_build_object('version_id',v.version_id,'title',v.title,'change_reason',v.change_reason,'payload',v.payload) order by v.version_number)
    from fabrik.record_version v where v.record_id=rid),'[]'::jsonb),
  'links',coalesce((select jsonb_agg(jsonb_build_object('link_id',l.link_id,'locator',l.locator,'note',l.note) order by l.link_id)
    from fabrik.version_link l where exists(select 1 from fabrik.record_version v where v.record_id=rid and v.version_id in (l.source_version_id,l.target_version_id))),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(jsonb_build_object('authorisation_id',z.authorisation_id,'request_payload',z.request_payload,'reason',z.reason) order by z.authorisation_id)
    from fabrik.authorisation z where z.mode='explicit_approval' and fabrik_private.carries_record(z.request_payload,rid)),'[]'::jsonb))::text,'UTF8')),'hex')
 into fp;
 update fabrik.record_version set title='Deleted',change_reason='Deleted',payload='{}'::jsonb where record_id=rid;
 get diagnostics nv=row_count;
 update fabrik.version_link l set locator=case when l.locator is null then null else 'Deleted '||l.link_id end,
  note=case when l.note is null then null else 'Deleted' end
 where exists(select 1 from fabrik.record_version v where v.record_id=rid and v.version_id in (l.source_version_id,l.target_version_id));
 get diagnostics nl=row_count;
 update fabrik.authorisation set request_payload=fabrik_private.erased_request(request_payload,rid),
  reason=(case when request_payload->>'record_id'=rid::text then 'Deleted' else reason end)
 where mode='explicit_approval' and fabrik_private.carries_record(request_payload,rid);
 get diagnostics na=row_count;
 update fabrik.record set deleted_at=clock_timestamp() where record_id=rid;
 insert into fabrik.record_deletion(request_id,record_id,kind,scope_id,executor_actor_id,accountable_human_id,authorisation_id,reason,
  versions_emptied,links_emptied,approvals_emptied,content_sha256)
 values((p_request->>'request_id')::uuid,rid,r.kind,r.scope_id,p_executor,p_human,p_authorisation,p_request->>'reason',nv,nl,na,fp) returning * into d;
 perform set_config('fabrik.deleting_record','',true);
 return d;
end $$;
revoke all on function fabrik_private.erase_record(jsonb,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function fabrik_private.erase_record(jsonb,uuid,uuid,uuid) to fabrik_writer;

reset role;

-- 4d. Owned by fabrik_writer: request validation, public write functions, provisioning.
set role fabrik_writer;

create function fabrik_private.require_object(p jsonb,required text[],optional text[] default array[]::text[]) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Expected JSON object' using errcode='22023'; end if;
 if not p ?& required or exists(select 1 from jsonb_object_keys(p) k where not k=any(required||optional)) then
  raise exception 'Missing or unknown JSON fields' using errcode='22023';
 end if;
end $$;
create function fabrik_private.require_text(p jsonb,k text,nullable boolean default false,max_length integer default 4000,nonblank boolean default false) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if nullable and p->k='null'::jsonb then return; end if;
 if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>max_length or (nonblank and length(btrim(p->>k))=0) then
  raise exception 'Invalid text field: %',k using errcode='22023';
 end if;
end $$;
create function fabrik_private.require_array(p jsonb,k text,max_items integer) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p->k) is distinct from 'array' then raise exception 'Expected array: %',k using errcode='22023'; end if;
 if jsonb_array_length(p->k)>max_items then raise exception 'Too many items: %',k using errcode='22023'; end if;
end $$;
create function fabrik_private.iso_time(p jsonb,k text) returns timestamptz
language plpgsql stable set search_path=pg_catalog set timezone='UTC' set datestyle='ISO,YMD' as $$
declare t timestamptz;
begin
 if p->k='null'::jsonb then return null; end if;
 perform fabrik_private.require_text(p,k,false,40,true);
 if (p->>k) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
  raise exception 'Timestamp must be ISO 8601 with timezone: %',k using errcode='22023';
 end if;
 t:=(p->>k)::timestamptz;
 if not isfinite(t) then raise exception 'Finite timestamp required' using errcode='22023'; end if;
 return t;
end $$;
-- A link or plain words, in the field p_field. A link starts https://, in any case, and has no ? part and
-- no name or password before its host. A value starting with another scheme and :// is refused. Plain
-- words, such as a name with a time or a file's name, start with neither / nor \ and hold no .. path
-- segment.
create function fabrik_private.validate_reference(p_field text, p text) returns void
language plpgsql immutable set search_path=pg_catalog as $$
declare host text;
begin
 if p is null then return; end if;
 if length(p) not between 1 and 2000 or p ~ '[[:cntrl:]]' then
  raise exception '%: a reference is one line of 1 to 2000 characters',p_field using errcode='22023';
 end if;
 if p ~* '^https://' then
  if position('?' in p)>0 then raise exception '%: a link has no ? part',p_field using errcode='22023'; end if;
  host:=substring(p from '^[Hh][Tt][Tt][Pp][Ss]://([^/#]*)');
  if position('@' in host)>0 then raise exception '%: a link has no name or password before its host',p_field using errcode='22023'; end if;
  if host !~ '^[A-Za-z0-9.-]+(:443)?$' then
   raise exception '%: a link''s host is letters, digits, dots and hyphens, with port 443 at most',p_field using errcode='22023';
  end if;
 elsif p ~ '^[A-Za-z][A-Za-z0-9+.-]*://' then
  raise exception '%: a link starts https://',p_field using errcode='22023';
 elsif p ~ '^[/\\]' then
  raise exception '%: plain words start with neither / nor \',p_field using errcode='22023';
 elsif p ~ '(^|[/\\])\.\.([/\\]|$)' then
  raise exception '%: plain words hold no .. path segment',p_field using errcode='22023';
 end if;
end $$;
-- The check with no field's name, for a caller that names none.
create or replace function fabrik_private.validate_reference(p text) returns void
language sql immutable set search_path=pg_catalog as $$
 select fabrik_private.validate_reference('reference',p)
$$;
create function fabrik_private.canonical_request_hash(p jsonb,executor_id uuid,human_id uuid) returns text
language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('format',1,'request',p,'executor',executor_id,'human',human_id)::text,'UTF8')),'hex')
$$;

CREATE OR REPLACE FUNCTION fabrik_private.validate_shape(p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare b jsonb; x jsonb; k text; g jsonb; dt date;
begin
 perform fabrik_private.require_object(p,array['request_id','record_id','scope_id','kind','expected_previous_version_id','title','payload','links','reason']);
 if octet_length(p::text)>262144 then raise exception 'Save request exceeds 256 KiB' using errcode='22023'; end if;
 foreach k in array array['request_id','record_id','scope_id'] loop
  perform fabrik_private.require_text(p,k,false,36,true); perform (p->>k)::uuid;
 end loop;
 perform fabrik_private.require_text(p,'expected_previous_version_id',true,36,true);
 if p->>'expected_previous_version_id' is not null then perform (p->>'expected_previous_version_id')::uuid; end if;
 perform fabrik_private.require_text(p,'title',false,500,true);
 perform fabrik_private.require_text(p,'reason',false,4000,true);
 perform fabrik_private.require_text(p,'kind',false,20,true);
 perform fabrik_private.require_array(p,'links',200);
 for x in select value from jsonb_array_elements(p->'links') loop
  perform fabrik_private.require_object(x,array['target_version_id','relation'],array['locator','note']);
  perform fabrik_private.require_text(x,'target_version_id',false,36,true); perform (x->>'target_version_id')::uuid;
  if not exists(select 1 from fabrik.relation_type t where t.code=coalesce(x->>'relation','')) then
   raise exception 'Unknown link relation "%": save it with fabrik_save_relation_type, or use one fabrik_list_relation_types lists',coalesce(x->>'relation','') using errcode='22023';
  end if;
  if x ? 'locator' then perform fabrik_private.require_text(x,'locator',true,2000); end if;
  if x ? 'note' then perform fabrik_private.require_text(x,'note',true,4000); end if;
 end loop;
 b:=p->'payload';
 case p->>'kind'
 when 'activity' then
  perform fabrik_private.require_object(b,array['activity_kind','description','completion_requirements','state','baseline_start_at','baseline_finish_at','forecast_start_at','forecast_finish_at','blockers','external_references','completion_note'],array['owner_actor_id','owner_label','index','task_type','assignee_actor_id','source','type','labels','properties']);
  if coalesce(b->>'activity_kind','') not in ('plan','task') then raise exception 'Invalid activity kind or state' using errcode='22023'; end if;
  if b ? 'assignee_actor_id' and b->'assignee_actor_id'<>'null'::jsonb then
   if b->>'activity_kind'<>'task' then raise exception 'Only a task has an assignee' using errcode='22023'; end if;
   perform fabrik_private.require_text(b,'assignee_actor_id',false,36,true); perform (b->>'assignee_actor_id')::uuid;
  end if;
  if b ? 'owner_actor_id' and b->'owner_actor_id'<>'null'::jsonb then
   perform fabrik_private.require_text(b,'owner_actor_id',false,36,true); perform (b->>'owner_actor_id')::uuid;
  end if;
  if b ? 'index' then
   perform fabrik_private.require_text(b,'index',false,20,true);
   if (b->>'index') ~ '[[:cntrl:]]' then raise exception 'An activity index is one line' using errcode='22023'; end if;
  end if;
  if b ? 'task_type' then
   if b->>'activity_kind'<>'task' then raise exception 'Only a task has a task type' using errcode='22023'; end if;
   if coalesce(b->>'task_type','') not in ('work','deliverable','blocker') then raise exception 'Task types are work, deliverable and blocker' using errcode='22023'; end if;
  end if;
  if coalesce(b->>'state','') not in ('pending','in_progress','paused','completed','cancelled') then
   raise exception 'Activity states are pending, in_progress, paused, completed and cancelled' using errcode='22023';
  end if;
  foreach k in array array['description','completion_requirements','completion_note'] loop perform fabrik_private.require_text(b,k); end loop;
  if b ? 'owner_label' then perform fabrik_private.require_text(b,'owner_label',true,200); end if;
  foreach k in array array['baseline_start_at','baseline_finish_at','forecast_start_at','forecast_finish_at'] loop perform fabrik_private.iso_time(b,k); end loop;
  if fabrik_private.iso_time(b,'baseline_start_at')>fabrik_private.iso_time(b,'baseline_finish_at') or
     fabrik_private.iso_time(b,'forecast_start_at')>fabrik_private.iso_time(b,'forecast_finish_at') then
   raise exception 'Start must not follow finish' using errcode='22023';
  end if;
  perform fabrik_private.require_array(b,'blockers',20);
  for x in select value from jsonb_array_elements(b->'blockers') loop
   perform fabrik_private.require_object(x,array['blocker_id','description']);
   perform fabrik_private.require_text(x,'blocker_id',false,36,true); perform (x->>'blocker_id')::uuid;
   perform fabrik_private.require_text(x,'description',false,4000,true);
  end loop;
  if exists(select 1 from jsonb_array_elements(b->'blockers') v group by v->>'blocker_id' having count(*)>1) then raise exception 'Duplicate blocker ID' using errcode='22023'; end if;
  perform fabrik_private.require_array(b,'external_references',10);
  for x in select value from jsonb_array_elements(b->'external_references') loop
   perform fabrik_private.require_object(x,array['label','reference']);
   perform fabrik_private.require_text(x,'label',false,200,true);
   perform fabrik_private.require_text(x,'reference',false,2000,true);
   perform fabrik_private.validate_reference('external_references.reference',x->>'reference');
  end loop;
 when 'decision' then
  perform fabrik_private.require_object(b,array['question','alternatives','decision','rationale','decided_on'],array['source','type','labels','properties']);
  foreach k in array array['question','decision','rationale'] loop perform fabrik_private.require_text(b,k); end loop;
  perform fabrik_private.require_array(b,'alternatives',10);
  for x in select value from jsonb_array_elements(b->'alternatives') loop
   if jsonb_typeof(x)<>'string' or length(x#>>'{}')>1000 then raise exception 'Invalid alternative' using errcode='22023'; end if;
  end loop;
  if b->'decided_on'<>'null'::jsonb then
   perform fabrik_private.require_text(b,'decided_on',false,10,true);
   if (b->>'decided_on') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid decision date' using errcode='22023'; end if;
   dt:=(b->>'decided_on')::date;
  end if;
  if b->>'decision'='' and b->'decided_on'<>'null'::jsonb then raise exception 'Undecided question cannot have decision date' using errcode='22023'; end if;
 when 'evidence' then
  perform fabrik_private.require_object(b,array['summary','source_reference','source_date','standing','limitations'],array['file_sha256','source','type','labels','properties']);
  foreach k in array array['summary','limitations'] loop perform fabrik_private.require_text(b,k); end loop;
  perform fabrik_private.require_text(b,'source_reference',true,2000);
  perform fabrik_private.validate_reference('source_reference',b->>'source_reference');
  if b->'source_date'<>'null'::jsonb then
   perform fabrik_private.require_text(b,'source_date',false,10,true);
   if (b->>'source_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid source date' using errcode='22023'; end if;
   dt:=(b->>'source_date')::date;
  end if;
  if coalesce(b->>'standing','') not in ('stated','observed','unverified') then raise exception 'Invalid evidence standing' using errcode='22023'; end if;
  if b ? 'file_sha256' and (jsonb_typeof(b->'file_sha256') is distinct from 'string' or (b->>'file_sha256') !~ '^[0-9a-f]{64}$') then raise exception 'Invalid file checksum' using errcode='22023'; end if;
 when 'model' then
  perform fabrik_private.require_object(b,array['model_kind','source_version','source_status','description','graph'],array['source','type','labels','properties']);
  if coalesce(b->>'model_kind','') not in ('observed_current','proposed_target') then raise exception 'Invalid model kind' using errcode='22023'; end if;
  foreach k in array array['source_version','source_status','description'] loop perform fabrik_private.require_text(b,k); end loop;
  g:=b->'graph';
  perform fabrik_private.require_object(g,array['format_version','nodes','edges']);
  if g->'format_version' is distinct from '1'::jsonb then raise exception 'Unsupported graph format' using errcode='22023'; end if;
  perform fabrik_private.require_array(g,'nodes',1000); perform fabrik_private.require_array(g,'edges',5000);
  for x in select value from jsonb_array_elements(g->'nodes') loop
   perform fabrik_private.require_object(x,array['id','type','label','attributes']);
   perform fabrik_private.require_text(x,'id',false,100,true); perform fabrik_private.require_text(x,'type',false,100,true);
   perform fabrik_private.require_text(x,'label',false,500);
   if jsonb_typeof(x->'attributes') is distinct from 'object' then raise exception 'Node attributes must be an object' using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(g->'nodes') n group by n->>'id' having count(*)>1) then raise exception 'Duplicate graph node ID' using errcode='22023'; end if;
  for x in select value from jsonb_array_elements(g->'edges') loop
   perform fabrik_private.require_object(x,array['id','source','target','type','attributes']);
   foreach k in array array['id','source','target','type'] loop perform fabrik_private.require_text(x,k,false,100,true); end loop;
   if jsonb_typeof(x->'attributes') is distinct from 'object' then raise exception 'Edge attributes must be an object' using errcode='22023'; end if;
   if not exists(select 1 from jsonb_array_elements(g->'nodes') n where n->>'id'=x->>'source') or
      not exists(select 1 from jsonb_array_elements(g->'nodes') n where n->>'id'=x->>'target') then raise exception 'Missing graph endpoint' using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(g->'edges') e group by e->>'id' having count(*)>1) then raise exception 'Duplicate graph edge ID' using errcode='22023'; end if;
 else raise exception 'Unknown record kind' using errcode='22023';
 end case;
 -- A record that came from another system names it: source {system, id}, both text.
 if b ? 'source' then
  if jsonb_typeof(b->'source') is distinct from 'object' then raise exception 'Invalid source' using errcode='22023'; end if;
  perform fabrik_private.require_object(b->'source',array['system','id']);
  perform fabrik_private.require_text(b->'source','system',false,100,true);
  perform fabrik_private.require_text(b->'source','id',false,200,true);
 end if;
 -- Any kind may also carry the type and labels it had there, and its properties, an object of any keys.
 if b ? 'type' then perform fabrik_private.require_text(b,'type',false,100,true); end if;
 if b ? 'labels' then
  perform fabrik_private.require_array(b,'labels',200);
  if exists(select 1 from jsonb_array_elements(b->'labels') l where jsonb_typeof(l) is distinct from 'string' or length(l#>>'{}')>200) then
   raise exception 'Invalid labels' using errcode='22023'; end if;
 end if;
 if b ? 'properties' and jsonb_typeof(b->'properties') is distinct from 'object' then raise exception 'Invalid properties' using errcode='22023'; end if;
end $function$
;

CREATE OR REPLACE FUNCTION fabrik_private.validate_version(p jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare oldv fabrik.record_version; b jsonb:=p->'payload'; link_item jsonb; target_row record; rid uuid:=(p->>'record_id')::uuid;
 actions text[]; oldstate text; newstate text; k text; added uuid[]; problems text[];
begin
 perform fabrik_private.validate_shape(p);
 perform fabrik_private.assert_request_scope(p,(fabrik_private.current_actor()).actor_id);
 select * into oldv from fabrik.record_version where record_id=rid order by change_no desc limit 1;
 if oldv.version_id is distinct from (p->>'expected_previous_version_id')::uuid then raise exception 'Previous version is stale' using errcode='40001'; end if;
 if oldv.version_id is null then
  if exists(select 1 from fabrik.record where record_id=rid) then raise exception 'Record has no saved version' using errcode='23514'; end if;
  actions:=array['create'];
 else
  if (select kind from fabrik.record where record_id=rid)<>p->>'kind' then raise exception 'Record kind is fixed' using errcode='23514'; end if;
  actions:=array['edit'];
 end if;
 if p->>'kind'='activity' then
  newstate:=b->>'state'; oldstate:=fabrik_private.activity_state(oldv.payload->>'state');
  if oldv.version_id is null and newstate<>'pending' then raise exception 'New activity starts pending' using errcode='23514'; end if;
  if oldv.version_id is not null then
   -- The baseline may change, in any state, and the version's reason says why.
   if b->>'activity_kind'<>oldv.payload->>'activity_kind' then raise exception 'Activity kind is fixed' using errcode='23514'; end if;
   if oldstate<>newstate then
    if not ((oldstate='pending' and newstate in ('in_progress','cancelled')) or (oldstate='in_progress' and newstate in ('paused','completed','cancelled')) or
      (oldstate='paused' and newstate in ('in_progress','cancelled')) or (oldstate='completed' and newstate='in_progress')) then
     raise exception 'Invalid activity state transition' using errcode='23514';
    end if;
    actions:=actions||case when newstate='in_progress' and oldstate='completed' then 'reopen' when newstate='in_progress' then 'start'
      when newstate='paused' then 'hold' when newstate='completed' then 'complete' else 'cancel' end;
   end if;
   if oldstate='completed' and b->'completion_requirements' is distinct from oldv.payload->'completion_requirements' and newstate<>'in_progress' then
    raise exception 'Changed completion requirements must reopen the activity' using errcode='23514';
   end if;
  end if;
  -- A new assignee is an enabled person who can read activities in the scope.
  if b->>'assignee_actor_id' is not null and b->'assignee_actor_id' is distinct from oldv.payload->'assignee_actor_id' and (
    not exists(select 1 from fabrik.actor x where x.actor_id=(b->>'assignee_actor_id')::uuid and x.actor_kind='human' and x.enabled)
    or not fabrik_private.scope_read_for((b->>'assignee_actor_id')::uuid,(p->>'scope_id')::uuid,'activity',rid)) then
   raise exception 'Assignee is not a person who can read this scope' using errcode='23514';
  end if;
  -- Every activity's owner is an enabled person who can read activities in the scope.
  if not fabrik_private.owner_ok((b->>'owner_actor_id')::uuid,(p->>'scope_id')::uuid,rid) then
   raise exception 'Owner is not a person who can read this scope' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_array_elements(b->'blockers') n join fabrik.record_version v on v.record_id=rid
    cross join lateral jsonb_array_elements(v.payload->'blockers') prev
    where n->>'blocker_id'=prev->>'blocker_id' and n->>'description'<>prev->>'description') then
   raise exception 'Blocker IDs cannot be reused for different descriptions' using errcode='23514';
  end if;
  -- Supporting evidence: a supports link from this version to evidence, or from evidence to a version
  -- of this record that differs from this one only in its state.
  if newstate='completed' and (length(btrim(b->>'completion_requirements'))=0 or length(btrim(b->>'completion_note'))=0 or jsonb_array_length(b->'blockers')<>0 or
    (not exists(select 1 from jsonb_array_elements(p->'links') z join fabrik.record_version v on v.version_id=(z->>'target_version_id')::uuid
      join fabrik.record r on r.record_id=v.record_id where z->>'relation'='supports' and r.kind='evidence')
     and not exists(select 1 from fabrik_private.evidence_through_state(rid,p->>'title',fabrik_private.with_owner_label(p)->'payload',null)))) then
   raise exception 'Completion requires requirements, note, no blockers and supporting evidence' using errcode='23514';
  end if;
 elsif p->>'kind'='decision' then
  if (oldv.version_id is null and b->>'decision'<>'') or (oldv.version_id is not null and b->'decision' is distinct from oldv.payload->'decision') then actions:=actions||'decide'::text; end if;
 end if;
 for link_item in select value from jsonb_array_elements(p->'links') loop
  select v.*,r.kind,r.scope_id into target_row from fabrik.record_version v join fabrik.record r using(record_id) where v.version_id=(link_item->>'target_version_id')::uuid;
  if not found or target_row.scope_id<>(p->>'scope_id')::uuid or not fabrik_private.can_read_record(target_row.record_id) then raise exception 'Link target unavailable' using errcode='42501'; end if;
  if link_item->>'relation' in ('parent','depends_on') then
   if p->>'kind'<>'activity' or target_row.kind<>'activity' or target_row.record_id=rid then raise exception 'Invalid activity link' using errcode='23514'; end if;
   if link_item->>'relation'='parent' and target_row.payload->>'activity_kind'<>'plan' then raise exception 'Parent must be a plan' using errcode='23514'; end if;
  end if;
 end loop;
 select z->>'relation' into k from jsonb_array_elements(p->'links') z join fabrik.relation_type rt on rt.code=z->>'relation'
  where rt.single_parent group by 1 having count(*)>1 limit 1;
 if k is not null then raise exception 'Only one % is allowed',k using errcode='23514'; end if;
 -- A link that adds a target record can close a loop: walk from each added target.
 foreach k in array array['depends_on','parent'] loop
  added:=array(select distinct t.record_id from jsonb_array_elements(p->'links') z join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
   where z->>'relation'=k and t.record_id not in (select pt.record_id from fabrik.version_link pl join fabrik.record_version pt on pt.version_id=pl.target_version_id
    where pl.source_version_id=oldv.version_id and pl.relation=k));
  if cardinality(added)>0 then
   -- Saves that add a parent or a dependency wait for each other, so two of them never close a loop together.
   perform pg_advisory_xact_lock(19483,31002);
   if fabrik_private.activity_loop(rid,k,added) then raise exception 'Circular activity relationship' using errcode='23514'; end if;
  end if;
 end loop;
 -- No activity finishes before what it contains or waits on.
 if p->>'kind'='activity' then
  -- Only a save that changes a finish, a task type, a parent or a dependency can break the order.
  -- Those saves wait for each other, so two of them never break it together.
  if oldv.version_id is null or coalesce(b->>'forecast_finish_at',b->>'baseline_finish_at')::timestamptz
    is distinct from coalesce(oldv.payload->>'forecast_finish_at',oldv.payload->>'baseline_finish_at')::timestamptz
   or b->>'task_type' is distinct from oldv.payload->>'task_type'
   or array(select z->>'relation'||' '||t.record_id from jsonb_array_elements(p->'links') z join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
     where z->>'relation' in ('parent','depends_on') order by 1)
    is distinct from array(select pl.relation||' '||pt.record_id from fabrik.version_link pl join fabrik.record_version pt on pt.version_id=pl.target_version_id
     where pl.source_version_id=oldv.version_id and pl.relation in ('parent','depends_on') order by 1) then
   perform pg_advisory_xact_lock(19483,31003);
   problems:=fabrik_private.finish_order_problems(p);
   if cardinality(problems)>0 then
    raise exception 'This finish cannot be saved: %.',array_to_string(problems,'; ') using errcode='23514';
   end if;
  end if;
 end if;
 return actions;
end $function$
;

-- A deletion request: the record, its scope and kind, the reason, and the records whose latest
-- version links to it, exactly as deletion_facts lists them now. Returns the action it needs.
create function fabrik_private.validate_deletion(p jsonb) returns text[]
language plpgsql stable set search_path=pg_catalog as $$
declare k text; r fabrik.record;
begin
 perform fabrik_private.require_object(p,array['operation','request_id','record_id','scope_id','kind','reason','dependents']);
 if p->>'operation' is distinct from 'delete' then raise exception 'A deletion request has operation delete' using errcode='22023'; end if;
 foreach k in array array['request_id','record_id','scope_id'] loop
  perform fabrik_private.require_text(p,k,false,36,true); perform (p->>k)::uuid;
 end loop;
 perform fabrik_private.require_text(p,'kind',false,20,true);
 perform fabrik_private.require_text(p,'reason',false,4000,true);
 perform fabrik_private.require_array(p,'dependents',10000);
 select * into r from fabrik.record where record_id=(p->>'record_id')::uuid;
 if not found or r.scope_id<>(p->>'scope_id')::uuid or r.kind<>p->>'kind' then raise exception 'Scope or record unavailable' using errcode='42501'; end if;
 if r.deleted_at is not null then raise exception 'The record was deleted' using errcode='23514'; end if;
 if p->'dependents' is distinct from fabrik_private.deletion_facts(r.record_id)->'dependents' then
  raise exception 'The records that link to this record have changed; preview the deletion again' using errcode='23514';
 end if;
 return array['delete'];
end $$;

CREATE OR REPLACE FUNCTION fabrik_private.assert_authority(p jsonb, p_authorisation uuid, p_actions text[])
 RETURNS fabrik.authorisation
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare a fabrik.actor; z fabrik.authorisation;
begin
 a:=fabrik_private.current_actor();
 perform fabrik_private.assert_request_scope(p,a.actor_id);
 select * into z from fabrik.authorisation where authorisation_id=p_authorisation;
 if not found or z.executor_actor_id<>a.actor_id or z.accountable_human_id<>a.accountable_human_id
 or not fabrik_private.authority_live(z.authorisation_id) then raise exception 'Authority unavailable' using errcode='42501'; end if;
 if z.scope_id is distinct from (p->>'scope_id')::uuid or not (p->>'kind'=any(z.record_kinds)) or (z.record_id is not null and z.record_id<>(p->>'record_id')::uuid)
 or not p_actions <@ z.allowed_actions then raise exception 'Action outside authority scope' using errcode='42501'; end if;
 if z.own_records and exists(select 1 from fabrik.record where record_id=(p->>'record_id')::uuid)
 and not fabrik_private.is_own_record(a.actor_id,(p->>'record_id')::uuid) then raise exception 'Action outside authority scope' using errcode='42501'; end if;
 if a.requires_human_approval and (z.mode<>'explicit_approval' or not exists(select 1 from fabrik.actor where actor_id=z.issued_by_actor_id and actor_kind='human')) then
  raise exception 'Exact human-issued approval required' using errcode='42501';
 end if;
 if z.mode='explicit_approval' and (z.consumed_version_id is not null or z.consumed_deletion_id is not null or z.request_id<>(p->>'request_id')::uuid or z.request_payload<>p
  or z.request_hash<>fabrik_private.canonical_request_hash(p,a.actor_id,a.accountable_human_id)) then
  raise exception 'Approval already used or does not match exact request' using errcode='42501';
 end if;
 return z;
end $function$
;

-- Retained 7-argument form: refuses unscoped grants with a clear message (22023).
create or replace function fabrik.fabrik_grant_permission(p_issuance_request_id uuid,p_executor_id uuid,p_record_kinds text[],p_record_id uuid,p_actions text[],p_expires_at timestamptz,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin raise exception 'scope_id is required; use the scoped grant function' using errcode='22023'; end $$;

CREATE OR REPLACE FUNCTION fabrik.fabrik_grant_permission(p_issuance_request_id uuid, p_executor_id uuid, p_scope_id uuid, p_record_kinds text[], p_record_id uuid, p_actions text[], p_expires_at timestamp with time zone, p_reason text, p_own_records boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; e fabrik.actor; z fabrik.authorisation; h text; req jsonb;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 select * into e from fabrik.actor where actor_id=p_executor_id and enabled;
 if not found then raise exception 'Executor unavailable' using errcode='22023'; end if;
 if p_scope_id is null or not exists(select 1 from fabrik.scope where scope_id=p_scope_id and enabled) then raise exception 'Scope unavailable' using errcode='22023'; end if;
 req:=jsonb_build_object('scope_id',p_scope_id,'operation','grant','executor',p_executor_id,'kinds',p_record_kinds,'record',p_record_id,'actions',p_actions,'expiry',p_expires_at,'reason',p_reason)
  ||case when coalesce(p_own_records,false) then jsonb_build_object('own_records',true) else '{}'::jsonb end;
 h:=fabrik_private.canonical_request_hash(req,a.actor_id,e.accountable_human_id);
 select * into z from fabrik.authorisation where issued_by_actor_id=a.actor_id and issuance_request_id=p_issuance_request_id;
 if found then
  if z.issuance_hash<>h then raise exception 'Issuance retry differs' using errcode='22023'; end if;
  return to_jsonb(z);
 end if;
 if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at<=clock_timestamp()) then raise exception 'Expiry must be in the future' using errcode='22023'; end if;
 if p_record_id is not null and not exists(select 1 from fabrik.record where record_id=p_record_id and scope_id=p_scope_id and kind=any(p_record_kinds)) then
  raise exception 'Record scope does not match kinds' using errcode='22023';
 end if;
 if coalesce(p_own_records,false) then
  if p_record_id is not null then raise exception 'A grant limited to own records covers no single record' using errcode='22023'; end if;
  if p_actions is null or 'delete'=any(p_actions) then raise exception 'A grant limited to own records does not carry delete' using errcode='22023'; end if;
  if not 'read'=any(p_actions) then raise exception 'A grant limited to own records carries read' using errcode='22023'; end if;
 end if;
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,own_records,expires_at,reason)
 values(p_scope_id,e.actor_id,e.accountable_human_id,a.actor_id,'standing_permission',p_issuance_request_id,h,p_record_kinds,p_record_id,p_actions,coalesce(p_own_records,false),p_expires_at,p_reason) returning * into z;
 return to_jsonb(z);
end $function$
;

CREATE OR REPLACE FUNCTION fabrik.fabrik_approve_change(p_issuance_request_id uuid, p_executor_id uuid, p_request jsonb, p_expires_at timestamp with time zone, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; e fabrik.actor; z fabrik.authorisation; ih text; rh text; actions text[]; existing_id uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 if p_request ? 'operation' then
  if a.actor_kind<>'human' then raise exception 'Record deletion needs a human administrator''s approval' using errcode='42501'; end if;
 else
  perform fabrik_private.validate_shape(p_request);
 end if;
 select * into e from fabrik.actor where actor_id=p_executor_id and enabled;
 if not found then raise exception 'Executor unavailable' using errcode='22023'; end if;
 if e.requires_human_approval and a.actor_kind<>'human' then raise exception 'Executor requires human-issued approval' using errcode='42501'; end if;
 perform fabrik_private.assert_request_scope(p_request,e.actor_id);
 rh:=fabrik_private.canonical_request_hash(p_request,e.actor_id,e.accountable_human_id);
 ih:=fabrik_private.canonical_request_hash(jsonb_build_object('operation','approve','request',p_request,'executor',p_executor_id,'expiry',p_expires_at,'reason',p_reason),a.actor_id,e.accountable_human_id);
 select * into z from fabrik.authorisation where issued_by_actor_id=a.actor_id and issuance_request_id=p_issuance_request_id;
 if found then
  if z.issuance_hash<>ih then raise exception 'Issuance retry differs' using errcode='22023'; end if;
  return to_jsonb(z);
 end if;
 if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at<=clock_timestamp() then raise exception 'Exact approval needs future expiry' using errcode='22023'; end if;
 actions:=case when p_request ? 'operation' then fabrik_private.validate_deletion(p_request) else fabrik_private.validate_version(p_request) end;
 select record_id into existing_id from fabrik.record where record_id=(p_request->>'record_id')::uuid;
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,request_id,request_payload,request_hash,expires_at,reason)
 values((p_request->>'scope_id')::uuid,e.actor_id,e.accountable_human_id,a.actor_id,'explicit_approval',p_issuance_request_id,ih,array[p_request->>'kind'],existing_id,actions,
  (p_request->>'request_id')::uuid,p_request,rh,p_expires_at,p_reason) returning * into z;
 return to_jsonb(z);
end $function$
;

create function fabrik.fabrik_revoke_authorisation(p_authorisation_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; z fabrik.authorisation;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then raise exception 'Revocation reason required' using errcode='22023'; end if;
 select * into z from fabrik.authorisation where authorisation_id=p_authorisation_id;
 if not found then raise exception 'Authorisation unavailable' using errcode='22023'; end if;
 if z.revoked_at is not null then return to_jsonb(z); end if;
 update fabrik.authorisation set revoked_at=clock_timestamp(),revoked_by_actor_id=a.actor_id,revocation_reason=p_reason
 where authorisation_id=p_authorisation_id returning * into z;
 return to_jsonb(z);
end $$;

CREATE OR REPLACE FUNCTION fabrik.fabrik_save_version(p_request jsonb, p_authorisation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; z fabrik.authorisation; v fabrik.record_version; oldv fabrik.record_version;
 h text; actions text[]; aid uuid:=p_authorisation_id; l jsonb; rid uuid; vnum integer; vid uuid; t timestamptz; w jsonb:='[]'::jsonb; k text;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 perform fabrik_private.validate_shape(p_request);
 rid:=(p_request->>'record_id')::uuid;
 -- The record and each record it links to stay as they are until the save ends: a deletion or a
 -- move waits. Other saves go on.
 perform fabrik_private.hold_records(rid||array(select tv.record_id from fabrik.record_version tv
  where tv.version_id in (select (lnk->>'target_version_id')::uuid from jsonb_array_elements(p_request->'links') lnk)),false);
 perform fabrik_private.assert_request_scope(p_request,a.actor_id);
 h:=fabrik_private.canonical_request_hash(p_request,a.actor_id,a.accountable_human_id);
 select * into v from fabrik.record_version where request_id=(p_request->>'request_id')::uuid;
 if found then
  if v.executor_actor_id<>a.actor_id or v.request_hash<>h or not fabrik_private.can_read_record(v.record_id) then
   raise exception 'Save retry unavailable or different' using errcode='42501';
  end if;
  return to_jsonb(v)||jsonb_build_object('scope_id',(p_request->>'scope_id')::uuid,'warnings',w);
 end if;
 actions:=fabrik_private.validate_version(p_request);
 if aid is null then
  if a.actor_kind<>'human' or a.authority_class<>'administrator' then raise exception 'Supply the id of a grant or approval that covers this change' using errcode='42501'; end if;
  aid:=(fabrik.fabrik_approve_change((p_request->>'request_id')::uuid,a.actor_id,p_request,clock_timestamp()+interval '5 minutes',p_request->>'reason')->>'authorisation_id')::uuid;
 end if;
 perform fabrik_private.hold_approval(aid);
 z:=fabrik_private.assert_authority(p_request,aid,actions);
 select * into oldv from fabrik.record_version where record_id=rid order by change_no desc limit 1;
 t:=clock_timestamp(); vid:=gen_random_uuid(); vnum:=coalesce(oldv.version_number,0)+1;
 begin
  if oldv.version_id is null then
   insert into fabrik.record(record_id,kind,scope_id,created_by,created_at) values(rid,p_request->>'kind',(p_request->>'scope_id')::uuid,a.actor_id,t);
  end if;
  insert into fabrik.record_version(version_id,record_id,version_number,previous_version_id,change_no,request_id,request_hash,recorded_at,
   executor_actor_id,accountable_human_id,authority_mode,authorisation_id,title,change_reason,payload)
  values(vid,rid,vnum,oldv.version_id,nextval('fabrik.change_no_seq'::regclass),(p_request->>'request_id')::uuid,h,t,
   a.actor_id,a.accountable_human_id,z.mode,z.authorisation_id,p_request->>'title',p_request->>'reason',fabrik_private.with_owner_label(p_request)->'payload') returning * into v;
 exception when unique_violation then
  -- Another save of the same record, or of the same request, finished first.
  get stacked diagnostics k=constraint_name;
  if k in ('record_pkey','record_version_record_id_version_number_key','record_version_request_id_key') then
   raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
  end if;
  raise;
 end;
 perform set_config('fabrik.saving_version',vid::text,true);
 for l in select value from jsonb_array_elements(p_request->'links') loop
  insert into fabrik.version_link(source_version_id,target_version_id,relation,locator,note)
   values(vid,(l->>'target_version_id')::uuid,l->>'relation',l->>'locator',l->>'note');
 end loop;
 perform set_config('fabrik.saving_version','',true);
 if z.mode='explicit_approval' then
  update fabrik.authorisation set consumed_version_id=vid where authorisation_id=z.authorisation_id;
 end if;
 return to_jsonb(v)||jsonb_build_object('scope_id',(p_request->>'scope_id')::uuid,'warnings',w);
end $function$
;

-- Deletes a record's content under an exact approval from a human administrator, used once.
-- The actor needs a live grant with delete for the record's kind, unless an administrator.
create function fabrik.fabrik_delete_record(p_request jsonb, p_authorisation_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; z fabrik.authorisation; d fabrik.record_deletion; actions text[];
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if jsonb_typeof(p_request) is distinct from 'object' or p_request->>'operation' is distinct from 'delete' then
  raise exception 'A deletion request has operation delete' using errcode='22023';
 end if;
 select * into d from fabrik.record_deletion where request_id=(p_request->>'request_id')::uuid;
 if found then
  if d.executor_actor_id<>a.actor_id or d.record_id::text is distinct from p_request->>'record_id' then
   raise exception 'Deletion retry unavailable or different' using errcode='42501';
  end if;
  return to_jsonb(d);
 end if;
 -- The record waits for the saves under way on it and on records linking to it, and holds off new ones.
 perform fabrik_private.hold_records(array[(p_request->>'record_id')::uuid],true);
 perform fabrik_private.assert_request_scope(p_request,a.actor_id);
 actions:=fabrik_private.validate_deletion(p_request);
 if p_authorisation_id is null then raise exception 'Record deletion needs an approval' using errcode='42501'; end if;
 perform fabrik_private.hold_approval(p_authorisation_id);
 z:=fabrik_private.assert_authority(p_request,p_authorisation_id,actions);
 if z.mode<>'explicit_approval' or not exists(select 1 from fabrik.actor where actor_id=z.issued_by_actor_id and actor_kind='human' and authority_class='administrator') then
  raise exception 'Record deletion needs a human administrator''s approval' using errcode='42501';
 end if;
 if a.authority_class<>'administrator' and not exists(select 1 from fabrik.authorisation g where g.executor_actor_id=a.actor_id
   and g.scope_id=(p_request->>'scope_id')::uuid and g.mode='standing_permission' and 'delete'=any(g.allowed_actions)
   and p_request->>'kind'=any(g.record_kinds) and (g.record_id is null or g.record_id=(p_request->>'record_id')::uuid)
   and fabrik_private.authority_live(g.authorisation_id)) then
  raise exception 'Action outside authority scope' using errcode='42501';
 end if;
 d:=fabrik_private.erase_record(p_request,z.authorisation_id,a.actor_id,a.accountable_human_id);
 update fabrik.authorisation set consumed_deletion_id=d.deletion_id where authorisation_id=z.authorisation_id;
 return to_jsonb(d);
end $$;

-- Administrator provisioning, run in the SQL Editor by the postgres login only.
CREATE OR REPLACE FUNCTION fabrik_private.provision_grant(p_approver_actor_id uuid, p_issuance_request_id uuid, p_executor_id uuid, p_scope_id uuid, p_record_kinds text[], p_record_id uuid, p_actions text[], p_expires_at timestamp with time zone, p_reason text, p_own_records boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare previous_actor text; a fabrik.actor; e fabrik.actor; z fabrik.authorisation; h text; req jsonb;
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_approver_actor_id is null then raise exception 'Administrator approver required' using errcode='22023'; end if;
 previous_actor:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',p_approver_actor_id::text,true);
 perform fabrik_private.lock_writes(); a:=fabrik_private.acting_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 select * into e from fabrik.actor where actor_id=p_executor_id and enabled;
 if not found then raise exception 'Executor unavailable' using errcode='22023'; end if;
 if p_scope_id is null or not exists(select 1 from fabrik.scope where scope_id=p_scope_id and enabled) then raise exception 'Scope unavailable' using errcode='22023'; end if;
 req:=jsonb_build_object('scope_id',p_scope_id,'operation','grant','executor',p_executor_id,'kinds',p_record_kinds,'record',p_record_id,'actions',p_actions,'expiry',p_expires_at,'reason',p_reason)
  ||case when coalesce(p_own_records,false) then jsonb_build_object('own_records',true) else '{}'::jsonb end;
 h:=fabrik_private.canonical_request_hash(req,a.actor_id,e.accountable_human_id);
 select * into z from fabrik.authorisation where issued_by_actor_id=a.actor_id and issuance_request_id=p_issuance_request_id;
 if found then
  if z.issuance_hash<>h then raise exception 'Issuance retry differs' using errcode='22023'; end if;
  perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z);
 end if;
 if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at<=clock_timestamp()) then raise exception 'Expiry must be in the future' using errcode='22023'; end if;
 if p_record_id is not null and not exists(select 1 from fabrik.record where record_id=p_record_id and scope_id=p_scope_id and kind=any(p_record_kinds)) then
  raise exception 'Record scope does not match kinds' using errcode='22023';
 end if;
 if coalesce(p_own_records,false) then
  if p_record_id is not null then raise exception 'A grant limited to own records covers no single record' using errcode='22023'; end if;
  if p_actions is null or 'delete'=any(p_actions) then raise exception 'A grant limited to own records does not carry delete' using errcode='22023'; end if;
  if not 'read'=any(p_actions) then raise exception 'A grant limited to own records carries read' using errcode='22023'; end if;
 end if;
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,own_records,expires_at,reason)
 values(p_scope_id,e.actor_id,e.accountable_human_id,a.actor_id,'standing_permission',p_issuance_request_id,h,p_record_kinds,p_record_id,p_actions,coalesce(p_own_records,false),p_expires_at,p_reason) returning * into z;
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z);
exception when others then
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 raise;
end $function$
;

CREATE OR REPLACE FUNCTION fabrik_private.provision_revocation(p_approver_actor_id uuid, p_authorisation_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare previous_actor text; a fabrik.actor; z fabrik.authorisation;
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_approver_actor_id is null then raise exception 'Administrator approver required' using errcode='22023'; end if;
 previous_actor:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',p_approver_actor_id::text,true);
 perform fabrik_private.lock_writes(); a:=fabrik_private.acting_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then raise exception 'Revocation reason required' using errcode='22023'; end if;
 select * into z from fabrik.authorisation where authorisation_id=p_authorisation_id;
 if not found then raise exception 'Authorisation unavailable' using errcode='22023'; end if;
 if z.revoked_at is not null then perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z); end if;
 update fabrik.authorisation set revoked_at=clock_timestamp(),revoked_by_actor_id=a.actor_id,revocation_reason=p_reason
 where authorisation_id=p_authorisation_id returning * into z;
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z);
exception when others then
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 raise;
end $function$
;

revoke all on function fabrik_private.provision_grant(uuid,uuid,uuid,uuid,text[],uuid,text[],timestamptz,text,boolean),
 fabrik_private.provision_revocation(uuid,uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.provision_grant(uuid,uuid,uuid,uuid,text[],uuid,text[],timestamptz,text,boolean),
 fabrik_private.provision_revocation(uuid,uuid,text) to fabrik_owner;
reset role;

-- 4e. Owned by fabrik_reader: permission-filtered reads.
set role fabrik_reader;

create function fabrik_private.read_actor() returns fabrik.actor
language plpgsql stable set search_path=pg_catalog as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'fabrik reads require READ COMMITTED for current permissions' using errcode='25001'; end if;
 return fabrik_private.current_actor();
end $$;
grant execute on function fabrik_private.read_actor() to fabrik_identity;
create function fabrik_private.read_cutoff(p_cutoff bigint) returns bigint
language plpgsql stable set search_path=pg_catalog as $$
declare m bigint;
begin
 perform fabrik_private.read_actor();
 select coalesce(max(change_no),0) into m from fabrik.record_version;
 if p_cutoff is not null and (p_cutoff<0 or p_cutoff>m) then raise exception 'Cutoff outside accessible history' using errcode='22023'; end if;
 return coalesce(p_cutoff,m);
end $$;

CREATE OR REPLACE FUNCTION fabrik.fabrik_get_record(p_record_id uuid, p_cutoff bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare c bigint; v fabrik.record_version;
begin
 c:=fabrik_private.read_cutoff(p_cutoff);
 if exists(select 1 from fabrik.record where record_id=p_record_id and deleted_at is not null) then
  return jsonb_build_object('cutoff',c,'deleted',(select to_jsonb(x) from fabrik.record_deletion x where x.record_id=p_record_id));
 end if;
 select * into v from fabrik.record_version where record_id=p_record_id and change_no<=c order by change_no desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('cutoff',c,'version',to_jsonb(v)||jsonb_build_object('scope_id',(select scope_id from fabrik.record where record_id=v.record_id)),'links',coalesce((select jsonb_agg(to_jsonb(l) order by l.link_id) from fabrik.version_link l where source_version_id=v.version_id),'[]'::jsonb));
end $function$
;

create function fabrik.fabrik_get_authorisations(p_executor_id uuid default null,p_cursor uuid default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if a.authority_class<>'administrator' and p_executor_id is not null and p_executor_id<>a.actor_id then return jsonb_build_object('items','[]'::jsonb,'next_cursor',null); end if;
 with page as (select * from fabrik.authorisation where (p_executor_id is null or executor_actor_id=p_executor_id)
  and (p_cursor is null or authorisation_id>p_cursor) order by authorisation_id limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(page) order by authorisation_id),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(authorisation_id order by authorisation_id desc))[1] end) into result from page;
 return result;
end $$;

CREATE OR REPLACE FUNCTION fabrik.fabrik_get_history(p_record_id uuid, p_cutoff bigint DEFAULT NULL::bigint, p_cursor bigint DEFAULT 0, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare c bigint; result jsonb;
begin
 c:=fabrik_private.read_cutoff(p_cutoff);
 if p_limit is null or p_limit not between 1 and 100 or p_cursor is null or p_cursor<0 or p_cursor>c then raise exception 'Invalid history page' using errcode='22023'; end if;
 with page as (select v.* from fabrik.record_version v where v.record_id=p_record_id and v.change_no<=c and v.change_no>p_cursor order by v.change_no limit p_limit),
 changes as (select v.change_no,to_jsonb(v)||jsonb_build_object('scope_id',(select scope_id from fabrik.record where record_id=v.record_id),'changed_fields',
  coalesce((select jsonb_agg(k order by k) from (select jsonb_object_keys(v.payload) k union select jsonb_object_keys(prev.payload) k) keys where v.payload->k is distinct from prev.payload->k),'[]'::jsonb)
   ||case when v.title is distinct from prev.title then '["title"]'::jsonb else '[]'::jsonb end
   ||case when
    coalesce((select jsonb_agg(to_jsonb(l)-array['link_id','source_version_id'] order by l.target_version_id,l.relation,l.locator,l.note) from fabrik.version_link l where l.source_version_id=v.version_id),'[]'::jsonb)
    is distinct from
    coalesce((select jsonb_agg(to_jsonb(l)-array['link_id','source_version_id'] order by l.target_version_id,l.relation,l.locator,l.note) from fabrik.version_link l where l.source_version_id=prev.version_id),'[]'::jsonb)
    then '["links"]'::jsonb else '[]'::jsonb end,
  'links',coalesce((select jsonb_agg(to_jsonb(l) order by l.link_id) from fabrik.version_link l where l.source_version_id=v.version_id),'[]'::jsonb)) item
 from page v left join fabrik.record_version prev on prev.version_id=v.previous_version_id)
 select jsonb_build_object('cutoff',c,'items',coalesce(jsonb_agg(item order by change_no),'[]'::jsonb),'next_cursor',case when count(*)=p_limit then max(change_no) end,
  'deleted',(select to_jsonb(x) from fabrik.record_deletion x join fabrik.record r using(record_id) where x.record_id=p_record_id)) into result from changes;
 return result;
end $function$
;

reset role;
set role fabrik_identity;
CREATE OR REPLACE FUNCTION fabrik_private.read_progress(p_cutoff bigint, p_observed_at timestamp with time zone, p_cursor uuid, p_limit integer, p_scope_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare rr uuid[]; m bigint; c bigint; obs timestamptz:=coalesce(p_observed_at,clock_timestamp()); latest_time timestamptz; result jsonb;
begin
 perform fabrik_private.read_actor();
 rr:=array(select fabrik_private.readable_records());
 select coalesce(max(v.change_no),0) into m from fabrik.record_version v where v.record_id in (select unnest(rr));
 if p_cutoff is not null and (p_cutoff<0 or p_cutoff>m) then raise exception 'Cutoff outside accessible history' using errcode='22023'; end if;
 c:=coalesce(p_cutoff,m);
 if p_limit is null or p_limit not between 1 and 100 or not isfinite(obs) or obs>clock_timestamp() then raise exception 'Invalid progress page or observation time' using errcode='22023'; end if;
 select max(v.recorded_at) into latest_time from fabrik.record_version v join fabrik.record r using(record_id) where v.change_no<=c and (p_scope_id is null or r.scope_id=p_scope_id) and r.record_id in (select unnest(rr));
 if obs<latest_time then raise exception 'Observation time precedes selected content' using errcode='22023'; end if;
 with hist as (
  select v.*,r.scope_id,fabrik_private.activity_state(v.payload->>'state') state,
   lag(fabrik_private.activity_state(v.payload->>'state')) over(partition by v.record_id order by v.change_no) prior_state
  from fabrik.record_version v join fabrik.record r using(record_id) where r.kind='activity' and r.deleted_at is null and r.record_id in (select unnest(rr)) and v.change_no<=c and (p_scope_id is null or r.scope_id=p_scope_id)
 ), latest as (select distinct on(record_id) * from hist order by record_id,change_no desc),
 times as (select record_id,min(recorded_at) first_saved_at,min(recorded_at) filter(where state='in_progress' and prior_state is distinct from 'in_progress') started_at,
  max(recorded_at) filter(where state='completed' and prior_state is distinct from 'completed') finished_at from hist group by record_id),
 page as (select l.*,t.first_saved_at,t.started_at,case when l.state='completed' then t.finished_at else null end actual_finish
  from latest l join times t using(record_id) where p_cursor is null or l.record_id>p_cursor order by l.record_id limit p_limit),
 items as (select q.record_id,to_jsonb(q)||jsonb_build_object(
  'assignee_name',fabrik_private.actor_name((q.payload->>'assignee_actor_id')::uuid),
  'creator_actor_id',case when q.payload->>'activity_kind'='plan' then (select fabrik_private.actor_person(o.created_by) from fabrik.record o where o.record_id=q.record_id) end,
  'creator_name',case when q.payload->>'activity_kind'='plan' then (select fabrik_private.actor_name(fabrik_private.actor_person(o.created_by)) from fabrik.record o where o.record_id=q.record_id) end,
  'baseline_finish_variance_seconds',extract(epoch from (q.actual_finish-(q.payload->>'baseline_finish_at')::timestamptz)),
  'forecast_finish_variance_seconds',extract(epoch from (q.actual_finish-(q.payload->>'forecast_finish_at')::timestamptz)),
  'baseline_overdue_seconds',case when q.payload->>'state' not in ('completed','cancelled') and q.payload->>'baseline_finish_at' is not null then greatest(0,extract(epoch from(obs-(q.payload->>'baseline_finish_at')::timestamptz))) else null end,
  'forecast_overdue_seconds',case when q.payload->>'state' not in ('completed','cancelled') and q.payload->>'forecast_finish_at' is not null then greatest(0,extract(epoch from(obs-(q.payload->>'forecast_finish_at')::timestamptz))) else null end,
  'overdue_seconds',case when q.payload->>'state' not in ('completed','cancelled') and coalesce(q.payload->>'forecast_finish_at',q.payload->>'baseline_finish_at') is not null then greatest(0,extract(epoch from(obs-coalesce(q.payload->>'forecast_finish_at',q.payload->>'baseline_finish_at')::timestamptz))) else null end,
  'dependencies',coalesce((select jsonb_agg(jsonb_build_object('record_id',d.record_id,'referenced_version_id',vl.target_version_id,'current_version_id',d.version_id,'state',d.state,'unfinished',d.state<>'completed') order by d.record_id)
   from fabrik.version_link vl join fabrik.record_version referenced on referenced.version_id=vl.target_version_id
   join latest d on d.record_id=referenced.record_id where vl.source_version_id=q.version_id and vl.relation='depends_on'),'[]'::jsonb),
  'parent',(select jsonb_build_object('record_id',referenced.record_id,'referenced_version_id',vl.target_version_id)
   from fabrik.version_link vl join fabrik.record_version referenced on referenced.version_id=vl.target_version_id
   join latest pl on pl.record_id=referenced.record_id where vl.source_version_id=q.version_id and vl.relation='parent'),
  -- The activity's links to evidence, and the evidence linked to a version of the activity that
  -- differs from this one only in its state.
  'evidence',coalesce((select jsonb_agg(e.item order by e.record_id,e.referenced_version_id) from (
   select referenced.record_id,vl.target_version_id referenced_version_id,jsonb_build_object('record_id',referenced.record_id,'referenced_version_id',vl.target_version_id,
    'current_version_id',(select cv.version_id from fabrik.record_version cv where cv.record_id=referenced.record_id and cv.change_no<=c order by cv.change_no desc limit 1),
    'title',referenced.title,'standing',referenced.payload->>'standing','deleted',er.deleted_at is not null) item
   from fabrik.version_link vl join fabrik.record_version referenced on referenced.version_id=vl.target_version_id
   join fabrik.record er on er.record_id=referenced.record_id where vl.source_version_id=q.version_id and vl.relation='supports' and er.kind='evidence' and er.record_id in (select unnest(rr))
   union all
   select ev.record_id,ev.version_id,jsonb_build_object('record_id',ev.record_id,'referenced_version_id',ev.version_id,'current_version_id',ev.version_id,
    'title',ev.title,'standing',ev.payload->>'standing','deleted',false)
   from fabrik_private.evidence_through_state(q.record_id,q.title,q.payload,c) t join fabrik.record_version ev on ev.version_id=t.version_id
   where t.record_id in (select unnest(rr)) and not exists(select 1 from fabrik.version_link ol join fabrik.record_version ot on ot.version_id=ol.target_version_id
    where ol.source_version_id=q.version_id and ol.relation='supports' and ot.record_id=t.record_id)) e),'[]'::jsonb)) item from page q),
 counts as (select state,count(*) n from latest group by state)
 select jsonb_build_object('cutoff',c,'observed_at',obs,'counts',
  '{"pending":0,"in_progress":0,"paused":0,"completed":0,"cancelled":0}'::jsonb||coalesce((select jsonb_object_agg(state,n) from counts),'{}'::jsonb),
  'items',coalesce((select jsonb_agg(item order by record_id) from items),'[]'::jsonb),
  'next_cursor',case when (select count(*) from page)=p_limit then (select record_id from page order by record_id desc limit 1) end) into result;
 return result;
end $function$
;
revoke all on function fabrik_private.read_progress(bigint,timestamptz,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function fabrik_private.read_progress(bigint,timestamptz,uuid,integer,uuid) to fabrik_owner, fabrik_reader;
reset role;
set role fabrik_reader;
CREATE OR REPLACE FUNCTION fabrik.fabrik_get_progress(p_cutoff bigint, p_observed_at timestamp with time zone, p_cursor uuid, p_limit integer, p_scope_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 select fabrik_private.read_progress(p_cutoff,p_observed_at,p_cursor,p_limit,p_scope_id)
$function$
;

create or replace function fabrik.fabrik_get_progress(p_cutoff bigint default null,p_observed_at timestamptz default null,p_cursor uuid default null,p_limit integer default 100) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik.fabrik_get_progress(p_cutoff,p_observed_at,p_cursor,p_limit,null::uuid)
$$;

-- What deleting a record would empty, the records that link to it, and the request to approve,
-- with its reason left for the actor to give. Changes nothing.
create function fabrik.fabrik_preview_deletion(p_record_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r fabrik.record; f jsonb;
begin
 perform fabrik_private.read_actor();
 select * into r from fabrik.record where record_id=p_record_id;
 if not found then return null; end if;
 if r.deleted_at is not null then
  return jsonb_build_object('deleted',(select to_jsonb(x) from fabrik.record_deletion x where x.record_id=r.record_id));
 end if;
 f:=fabrik_private.deletion_facts(r.record_id);
 return jsonb_build_object('record_id',r.record_id,'scope_id',r.scope_id,'kind',r.kind,
  'title',(select v.title from fabrik.record_version v where v.record_id=r.record_id order by v.change_no desc limit 1),
  'versions',f->'versions','links',f->'links','approvals',f->'approvals','dependents',f->'dependents',
  'request',jsonb_build_object('operation','delete','request_id',gen_random_uuid(),'record_id',r.record_id,'scope_id',r.scope_id,
   'kind',r.kind,'reason',null,'dependents',f->'dependents'));
end $$;

-- The signed-in actor's own record: name, kind, authority, and the person accountable for them.
create function fabrik.fabrik_get_actor() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.read_actor();
 return jsonb_build_object('actor_id',a.actor_id,'display_name',a.display_name,'actor_kind',a.actor_kind,
  'authority_class',a.authority_class,'requires_human_approval',a.requires_human_approval,
  'accountable_human_id',a.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(a.accountable_human_id));
end $$;

create function fabrik.fabrik_get_scopes(p_cursor uuid default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 with page as (select scope_id,code,display_name,description,enabled from fabrik.scope where p_cursor is null or scope_id>p_cursor order by scope_id limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(page) order by scope_id),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(scope_id order by scope_id desc))[1] end) into result from page;
 return result;
end $$;

-- The records the actor may read, newest save first: each record's latest version at the cutoff,
-- with its kind, scope, title, and when and by whom it was saved. Filters by kind, by scope, and by
-- words that must all appear in the title, in any case. Deleted records are left out.
reset role;
set role fabrik_identity;
create or replace function fabrik_private.read_records(p_kind text,p_scope_id uuid,p_title text,
 p_cutoff bigint,p_cursor bigint,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rr uuid[]; m bigint; c bigint; words text[]; result jsonb;
begin
 perform fabrik_private.read_actor();
 rr:=array(select fabrik_private.readable_records());
 select coalesce(max(v.change_no),0) into m from fabrik.record_version v where v.record_id in (select unnest(rr));
 if p_cutoff is not null and (p_cutoff<0 or p_cutoff>m) then raise exception 'Cutoff outside accessible history' using errcode='22023'; end if;
 c:=coalesce(p_cutoff,m);
 if p_limit is null or p_limit not between 1 and 100 or (p_cursor is not null and p_cursor<1) then raise exception 'Invalid records page' using errcode='22023'; end if;
 if p_kind is not null and p_kind not in ('activity','decision','model','evidence') then raise exception 'Kind must be activity, decision, model or evidence' using errcode='22023'; end if;
 words:=array(select replace(replace(replace(w,'\','\\'),'%','\%'),'_','\_') from regexp_split_to_table(btrim(coalesce(p_title,'')),'\s+') w where w<>'');
 with latest as (select distinct on(v.record_id) v.record_id,v.version_id,v.version_number,v.change_no,v.title,v.recorded_at,v.executor_actor_id,r.kind,r.scope_id
  from fabrik.record_version v join fabrik.record r using(record_id)
  where r.deleted_at is null and r.record_id in (select unnest(rr)) and v.change_no<=c and (p_kind is null or r.kind=p_kind) and (p_scope_id is null or r.scope_id=p_scope_id)
  order by v.record_id,v.change_no desc),
 page as (select * from latest l where (p_cursor is null or l.change_no<p_cursor)
  and not exists(select 1 from unnest(words) w where l.title not ilike '%'||w||'%')
  order by l.change_no desc limit p_limit)
 select jsonb_build_object('cutoff',c,
  'items',coalesce(jsonb_agg(jsonb_build_object('record_id',record_id,'kind',kind,'scope_id',scope_id,'title',title,'version_id',version_id,
   'version_number',version_number,'change_no',change_no,'saved_at',recorded_at,'saved_by',fabrik_private.actor_name(executor_actor_id)) order by change_no desc),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then min(change_no) end) into result from page;
 return result;
end $$;
revoke all on function fabrik_private.read_records(text,uuid,text,bigint,bigint,integer) from public, anon, authenticated;
grant execute on function fabrik_private.read_records(text,uuid,text,bigint,bigint,integer) to fabrik_owner, fabrik_reader;
reset role;
set role fabrik_reader;
create or replace function fabrik.fabrik_find_records(p_kind text default null,p_scope_id uuid default null,p_title text default null,
 p_cutoff bigint default null,p_cursor bigint default null,p_limit integer default 100) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.read_records(p_kind,p_scope_id,p_title,p_cutoff,p_cursor,p_limit)
$$;

reset role;

-- ===================================================================
-- 5. Triggers and row-level security policies
-- ===================================================================
set role fabrik_owner;
revoke create on schema fabrik_private from fabrik_identity, fabrik_writer, fabrik_reader;
revoke create on schema fabrik from fabrik_writer, fabrik_reader;

create constraint trigger actor_human_reference after insert or update on fabrik.actor
 deferrable initially deferred for each row execute function fabrik_private.guard_actor_reference();
create trigger actor_change before insert or update or delete on fabrik.actor
 for each row execute function fabrik_private.guard_actor_change();
create trigger actor_change_audit after insert or update on fabrik.actor
 for each row execute function fabrik_private.log_actor_change();
create trigger actor_approver_remains after update on fabrik.actor
 for each statement execute function fabrik_private.guard_approver_remains();
create trigger actor_change_insert_guard before insert on fabrik.actor_change
 for each row execute function fabrik_private.guard_actor_change_log();
create trigger actor_change_immutable before update or delete or truncate on fabrik.actor_change
 for each statement execute function fabrik_private.guard_actor_change_log();
create trigger scope_guard before insert or update or delete on fabrik.scope
 for each row execute function fabrik_private.guard_scope();
create trigger record_immutable before insert or update or delete on fabrik.record
 for each row execute function fabrik_private.guard_version();
create trigger version_immutable before insert or update or delete on fabrik.record_version
 for each row execute function fabrik_private.guard_version();
create trigger link_immutable before insert or update or delete on fabrik.version_link
 for each row execute function fabrik_private.guard_version_link();
create trigger authorisation_guard before insert or update or delete on fabrik.authorisation
 for each row execute function fabrik_private.guard_authorisation();
create trigger record_deletion_guard before insert or update or delete on fabrik.record_deletion
 for each row execute function fabrik_private.guard_record_deletion();
create trigger record_deletion_immutable before truncate on fabrik.record_deletion
 for each statement execute function fabrik_private.guard_record_deletion();

create policy actor_identity_read on fabrik.actor for select to fabrik_identity using (true);
create policy actor_writer_read on fabrik.actor for select to fabrik_writer using (true);
create policy actor_reader_read on fabrik.actor for select to fabrik_reader
 using (actor_id=(select (fabrik_private.current_actor()).actor_id));

create policy scope_identity_read on fabrik.scope for select to fabrik_identity using (true);
create policy scope_writer_read on fabrik.scope for select to fabrik_writer using (true);
create policy scope_reader_read on fabrik.scope for select to fabrik_reader using (fabrik_private.can_see_scope(scope_id));

create policy record_identity_read on fabrik.record for select to fabrik_identity using (true);
create policy record_writer_read on fabrik.record for select to fabrik_writer using (fabrik_private.can_read_record(record_id));
create policy record_writer_insert on fabrik.record for insert to fabrik_writer
 with check (created_by=(select (fabrik_private.current_actor()).actor_id) and fabrik_private.can_insert_record(scope_id,kind));
create policy record_reader_read on fabrik.record for select to fabrik_reader using (fabrik_private.can_read_record(record_id));

create policy authorisation_identity_read on fabrik.authorisation for select to fabrik_identity using (true);
create policy authorisation_writer_read on fabrik.authorisation for select to fabrik_writer using (true);
create policy authorisation_writer_insert on fabrik.authorisation for insert to fabrik_writer
 with check (issued_by_actor_id=(select (fabrik_private.acting_actor()).actor_id));
create policy authorisation_writer_update on fabrik.authorisation for update to fabrik_writer using (true) with check (true);
create policy authorisation_reader_read on fabrik.authorisation for select to fabrik_reader
 using ((select (fabrik_private.acting_actor()).authority_class)='administrator'
 or executor_actor_id=(select (fabrik_private.acting_actor()).actor_id));

create policy version_identity_read on fabrik.record_version for select to fabrik_identity using (true);
create policy version_writer_read on fabrik.record_version for select to fabrik_writer using (fabrik_private.can_read_record(record_id));
create policy version_writer_insert on fabrik.record_version for insert to fabrik_writer
 with check (executor_actor_id=(select (fabrik_private.current_actor()).actor_id) and fabrik_private.can_insert_version(record_id,authorisation_id));
create policy version_reader_read on fabrik.record_version for select to fabrik_reader using (fabrik_private.can_read_record(record_id));

create policy link_identity_read on fabrik.version_link for select to fabrik_identity using (true);
create policy link_writer_read on fabrik.version_link for select to fabrik_writer using (fabrik_private.can_link(source_version_id,target_version_id));
create policy link_writer_insert on fabrik.version_link for insert to fabrik_writer with check (fabrik_private.can_link(source_version_id,target_version_id));
create policy link_reader_read on fabrik.version_link for select to fabrik_reader using (fabrik_private.can_link(source_version_id,target_version_id));

create policy deletion_identity_read on fabrik.record_deletion for select to fabrik_identity using (true);
create policy deletion_writer_read on fabrik.record_deletion for select to fabrik_writer using (true);
create policy deletion_reader_read on fabrik.record_deletion for select to fabrik_reader using (fabrik_private.can_read_record(record_id));

-- Explicit client denial; the table owner keeps administrative inspection. The reader's own policy
-- is actor_change_reader_read, in section 6.
create policy actor_change_client_denied on fabrik.actor_change for all to anon, authenticated using (false) with check (false);
reset role;

-- ===================================================================
-- 6. Client access: authenticated may use schema fabrik and execute fabrik_* only.
--    anon and PUBLIC get nothing. fabrik_private is never granted to clients.
-- ===================================================================
revoke execute on all functions in schema fabrik, fabrik_private from public, anon, authenticated;
revoke all on all tables in schema fabrik from public, anon, authenticated;
revoke all on all sequences in schema fabrik from public, anon, authenticated;
revoke all on schema fabrik_private from public, anon, authenticated;
grant usage on schema fabrik to authenticated;
do $$
declare f record;
begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='fabrik' and p.proname like 'fabrik\_%' escape '\' loop
  execute format('revoke all on function %s from public,anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

-- Refresh the Data API schema cache. Expose schema fabrik (never fabrik_private)
-- under Data API settings in the dashboard; this script does not change that setting.
notify pgrst, 'reload schema';

-- ===================================================================
-- 7. Files: one private Storage bucket per scope, named after the scope's code.
--    In the scope, read permission lets an actor list and download its files, create lets
--    them upload, and read, create and edit together let them replace a file, because a
--    replace is an upload over the file it reads. Read with delete lets them delete any file
--    in the scope, because a delete finds the file it removes. A record's delete also needs a human administrator's approval, through fabrik_delete_record.
-- ===================================================================
-- The storage rules run as the signed-in actor, so their one check lives in a schema
-- of its own, which authenticated may use and the Data API never exposes. The check names
-- every bucket the actor may take an action in, and each rule asks it once per statement,
-- not once per file.
create schema fabrik_storage authorization fabrik_owner;
revoke all on schema fabrik_storage from public;
set role fabrik_owner;
grant create on schema fabrik_storage to fabrik_identity;
reset role;

set role fabrik_identity;
create function fabrik_storage.usable_buckets(p_action text) returns setof text
language sql stable security definer set search_path=pg_catalog as $$
 select s.code from fabrik.actor x
  join fabrik.actor h on h.actor_id=x.accountable_human_id
  join fabrik.scope s on s.enabled
  where x.auth_user_id=fabrik_private.request_auth_uid()
   and x.enabled and h.enabled and h.actor_kind='human'
   and (x.authority_class='administrator'
    or exists(select 1 from fabrik.authorisation z
     where z.executor_actor_id=x.actor_id and z.scope_id=s.scope_id and z.mode='standing_permission'
      and z.record_id is null and not z.own_records and p_action=any(z.allowed_actions)
      and fabrik_private.authority_live(z.authorisation_id)))
$$;
reset role;

set role fabrik_owner;
revoke create on schema fabrik_storage from fabrik_identity;
reset role;
revoke all on function fabrik_storage.usable_buckets(text) from public, anon;
grant usage on schema fabrik_storage to authenticated;
grant execute on function fabrik_storage.usable_buckets(text) to authenticated;

create policy "fabrik: list and download with read permission" on storage.objects
 for select to authenticated using (bucket_id in (select fabrik_storage.usable_buckets('read')));
create policy "fabrik: upload with create permission" on storage.objects
 for insert to authenticated with check (bucket_id in (select fabrik_storage.usable_buckets('create')));
create policy "fabrik: replace with edit permission" on storage.objects
 for update to authenticated using (bucket_id in (select fabrik_storage.usable_buckets('edit')))
 with check (bucket_id in (select fabrik_storage.usable_buckets('edit')));
create policy "fabrik: delete with delete permission" on storage.objects
 for delete to authenticated using (bucket_id in (select fabrik_storage.usable_buckets('delete')));

-- A scope's private bucket is created with the scope, so no scope is ever without one.
-- The bucket must be the scope's own: an existing bucket of that name, private or not,
-- refuses the scope rather than becoming its bucket.
-- Owned by postgres, which may write storage.buckets; fabrik_owner may not.
create function fabrik_storage.create_scope_bucket() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if exists(select 1 from storage.buckets where id=new.code or name=new.code) then
  raise exception 'A bucket named % already exists; a scope needs a private bucket of its own', new.code using errcode='23505';
 end if;
 insert into storage.buckets(id, name, public) values (new.code, new.code, false);
 return new;
end $$;
revoke all on function fabrik_storage.create_scope_bucket() from public, anon, authenticated;
create trigger scope_bucket after insert on fabrik.scope
 for each row execute function fabrik_storage.create_scope_bucket();

-- ===================================================================
-- 8. Audit log.
-- ===================================================================
-- Each upload, replacement, move and deletion of a file in a scope's bucket, and who made it.
-- Append-only, written only by the Storage trigger and by the listing of files already present.
set role fabrik_owner;
create table if not exists fabrik.file_event (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 event text not null check (event in ('uploaded','replaced','moved','deleted')),
 scope_id uuid not null,
 object_id uuid not null,
 name text not null,
 previous_name text,
 actor_id uuid references fabrik.actor(actor_id),
 auth_user_id uuid,
 login name not null default session_user,
 attributed_by text not null default 'none' check (attributed_by in ('sign_in','storage_owner','none'))
);
create index if not exists file_event_time_idx on fabrik.file_event(at desc);
create index if not exists file_event_scope_time_idx on fabrik.file_event(scope_id,at desc);
create index if not exists file_event_actor_idx on fabrik.file_event(actor_id);
alter table fabrik.file_event enable row level security;
revoke all on fabrik.file_event from public;
grant select on fabrik.file_event, fabrik.actor_change to fabrik_reader;

create or replace function fabrik_private.guard_file_event()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 -- The one change allowed: an upgrade naming who made an event, while it sets fabrik.correcting_file_log.
 if tg_op='UPDATE' and current_setting('fabrik.correcting_file_log',true)='on'
   and (to_jsonb(new)-array['actor_id','auth_user_id','attributed_by'])=(to_jsonb(old)-array['actor_id','auth_user_id','attributed_by']) then
  return new;
 end if;
 raise exception 'The file log is append-only' using errcode='23514';
end $$;
revoke all on function fabrik_private.guard_file_event() from public, anon, authenticated;

-- Runs for every change to storage.objects, and logs those in a scope's bucket. The actor is the
-- fabrik actor signed in to the request. Storage writes a file under its own login, with no sign-in,
-- so an upload, replacement or move is then attributed to the file's Storage owner, which Storage
-- sets from the person's sign-in. A deletion without a sign-in names nobody.
create or replace function fabrik_private.log_file_event()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=fabrik_private.request_auth_uid(); how text:='sign_in'; who uuid; sc uuid; old_sc uuid;
begin
 if uid is null and tg_op<>'DELETE' then
  uid:=coalesce(new.owner,case when new.owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then new.owner_id::uuid end);
  how:='storage_owner';
 end if;
 if uid is null then how:='none'; end if;
 select actor_id into who from fabrik.actor where auth_user_id=uid;
 if tg_op in ('INSERT','UPDATE') then select scope_id into sc from fabrik.scope where code=new.bucket_id; end if;
 if tg_op in ('UPDATE','DELETE') then select scope_id into old_sc from fabrik.scope where code=old.bucket_id; end if;
 if tg_op='INSERT' and sc is not null then
  insert into fabrik.file_event(event,scope_id,object_id,name,actor_id,auth_user_id,attributed_by) values('uploaded',sc,new.id,new.name,who,uid,how);
 elsif tg_op='DELETE' and old_sc is not null then
  insert into fabrik.file_event(event,scope_id,object_id,name,actor_id,auth_user_id,attributed_by) values('deleted',old_sc,old.id,old.name,who,uid,how);
 elsif tg_op='UPDATE' and coalesce(sc,old_sc) is not null then
  if new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name then
   insert into fabrik.file_event(event,scope_id,object_id,name,previous_name,actor_id,auth_user_id,attributed_by)
   values('moved',coalesce(sc,old_sc),new.id,new.name,old.name,who,uid,how);
  end if;
  if sc is not null and old.metadata is not null and new.metadata->>'eTag' is distinct from old.metadata->>'eTag' then
   insert into fabrik.file_event(event,scope_id,object_id,name,actor_id,auth_user_id,attributed_by) values('replaced',sc,new.id,new.name,who,uid,how);
  end if;
 end if;
 return null;
end $$;
revoke all on function fabrik_private.log_file_event() from public, anon, authenticated;
reset role;

drop trigger if exists file_event_immutable on fabrik.file_event;
create trigger file_event_immutable before update or delete on fabrik.file_event
 for each row execute function fabrik_private.guard_file_event();
drop trigger if exists file_event_no_truncate on fabrik.file_event;
create trigger file_event_no_truncate before truncate on fabrik.file_event
 for each statement execute function fabrik_private.guard_file_event();
drop trigger if exists fabrik_file_event on storage.objects;
create trigger fabrik_file_event after insert or update or delete on storage.objects
 for each row execute function fabrik_private.log_file_event();

-- The files already in a scope's bucket, logged as uploaded by their Storage owner.
insert into fabrik.file_event(at,event,scope_id,object_id,name,actor_id,auth_user_id,attributed_by)
select o.created_at,'uploaded',s.scope_id,o.id,o.name,a.actor_id,u.uid,case when u.uid is null then 'none' else 'storage_owner' end
from storage.objects o join fabrik.scope s on s.code=o.bucket_id
cross join lateral (select coalesce(o.owner,case when o.owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then o.owner_id::uuid end) uid) u
left join fabrik.actor a on a.auth_user_id=u.uid
where o.archived_at is null and not exists(select 1 from fabrik.file_event f where f.object_id=o.id);

-- Who may read which events: an administrator every one, others their own actor's changes and
-- the file events in scopes where they hold read.
drop policy if exists actor_change_reader_read on fabrik.actor_change;
create policy actor_change_reader_read on fabrik.actor_change for select to fabrik_reader
 using ((select (fabrik_private.current_actor()).authority_class)='administrator'
 or actor_id=(select (fabrik_private.current_actor()).actor_id));
drop policy if exists file_event_reader_read on fabrik.file_event;
create policy file_event_reader_read on fabrik.file_event for select to fabrik_reader
 using (fabrik_private.scope_read_for((select (fabrik_private.current_actor()).actor_id),scope_id,null,null));

grant create on schema fabrik_private to fabrik_identity;
grant create on schema fabrik to fabrik_reader;

set role fabrik_identity;
-- A scope's name, by id: the audit log names the scope of a grant its reader may not open.
create or replace function fabrik_private.scope_name(p_scope uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select display_name from fabrik.scope where scope_id=p_scope
$$;
revoke all on function fabrik_private.scope_name(uuid) from public, anon, authenticated;
grant execute on function fabrik_private.scope_name(uuid) to fabrik_owner, fabrik_writer, fabrik_reader;
reset role;

set role fabrik_reader;
-- What happened from p_from until p_to, newest first, as far as the caller may read. Each item
-- names its time, event, scope, actor and subject, with the ids that lead to the full entry.
create or replace function fabrik.fabrik_get_audit(p_from timestamptz, p_to timestamptz, p_cursor text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; c_at bigint; c_key text; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'A period needs a start before its end' using errcode='22023'; end if;
 if p_cursor is not null then
  if p_cursor !~ '^[0-9]+/[a-z]:[0-9a-f-]+$' then raise exception 'Invalid audit cursor' using errcode='22023'; end if;
  c_at:=split_part(p_cursor,'/',1)::bigint; c_key:=split_part(p_cursor,'/',2);
 end if;
 with events as (
  select v.recorded_at at,'v:'||v.version_id::text k,'record_saved' event,r.scope_id,v.executor_actor_id actor_id,v.title subject,v.change_reason reason,
   jsonb_build_object('record_id',v.record_id,'kind',r.kind,'version_id',v.version_id,'version_number',v.version_number,
    'authorisation_id',v.authorisation_id,'accountable_human_id',v.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(v.accountable_human_id)) details
  from fabrik_private.audit_versions(p_from,p_to) v cross join lateral (select v.kind,v.scope_id) r
  union all
  select d.deleted_at,'d:'||d.deletion_id::text,'record_deleted',d.scope_id,d.executor_actor_id,d.kind,d.reason,
   jsonb_build_object('record_id',d.record_id,'kind',d.kind,'deletion_id',d.deletion_id,'authorisation_id',d.authorisation_id,
    'accountable_human_id',d.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(d.accountable_human_id),
    'approved_by_actor_id',z.issued_by_actor_id,'approved_by_name',fabrik_private.actor_name(z.issued_by_actor_id),'content_sha256',d.content_sha256)
  from fabrik.record_deletion d left join fabrik.authorisation z on z.authorisation_id=d.authorisation_id
  where d.deleted_at>=p_from and d.deleted_at<p_to
  union all
  select m.moved_at,'m:'||m.move_id::text,'record_moved',m.to_scope_id,m.executor_actor_id,
   coalesce(case when fabrik_private.can_read_record(m.record_id) then
    (select v.title from fabrik.record_version v where v.record_id=m.record_id order by v.change_no desc limit 1) end,m.kind),m.reason,
   jsonb_build_object('record_id',m.record_id,'kind',m.kind,'move_id',m.move_id,'request_id',m.request_id,
    'from_scope_id',m.from_scope_id,'from_scope_name',fabrik_private.scope_name(m.from_scope_id),
    'to_scope_id',m.to_scope_id,'to_scope_name',fabrik_private.scope_name(m.to_scope_id))
   ||case when a.authority_class='administrator' then jsonb_build_object('losing_access',m.losing_access,'gaining_access',m.gaining_access) else '{}'::jsonb end
  from fabrik.record_move m where m.moved_at>=p_from and m.moved_at<p_to
  union all
  select c.at,'c:'||lpad(c.event_id::text,19,'0'),'scope_renamed',c.scope_id,c.changed_by_actor_id,c.new_value,c.reason,
   jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value)
  from fabrik.scope_change c where c.at>=p_from and c.at<p_to
  union all
  select s.created_at,'n:'||s.scope_id::text,'scope_created',s.scope_id,s.created_by,s.display_name,coalesce(s.created_reason,'Made at setup'),
   jsonb_build_object('code',s.code,'description',s.description)
  from fabrik.scope s where s.created_at>=p_from and s.created_at<p_to
  union all
  select x.at,'x:'||lpad(x.event_id::text,19,'0'),'scope_deleted',null::uuid,x.deleted_by_actor_id,x.display_name,x.reason,
   jsonb_build_object('deleted_scope_id',x.scope_id,'code',x.code,'description',x.description,'grants_removed',x.grants_removed)
  from fabrik.scope_deletion x where a.authority_class='administrator' and x.at>=p_from and x.at<p_to
  union all
  select z.issued_at,'g:'||z.authorisation_id::text,case when z.mode='explicit_approval' then 'approval_given' else 'grant_issued' end,z.scope_id,z.issued_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,
    'record_kinds',z.record_kinds,'record_id',z.record_id,'own_records',z.own_records,'expires_at',z.expires_at)
  from fabrik.authorisation z where z.issued_at>=p_from and z.issued_at<p_to
  union all
  select z.revoked_at,'r:'||z.authorisation_id::text,'grant_revoked',z.scope_id,z.revoked_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.revocation_reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds)
  from fabrik.authorisation z where z.revoked_at>=p_from and z.revoked_at<p_to
  union all
  select c.changed_at,'a:'||c.change_id::text,case when c.old_value is null then 'actor_created' else 'actor_changed' end,null::uuid,c.changed_by_actor_id,
   fabrik_private.actor_name(c.actor_id),null::text,
   jsonb_build_object('changed_actor_id',c.actor_id)||case when c.old_value is null then '{}'::jsonb
    else jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value) end
  from fabrik.actor_change c where c.changed_at>=p_from and c.changed_at<p_to and (c.old_value is not null or c.field='actor_id')
  union all
  select f.at,'f:'||lpad(f.event_id::text,19,'0'),'file_'||f.event,f.scope_id,f.actor_id,f.name,null::text,
   jsonb_build_object('object_id',f.object_id,'previous_name',f.previous_name,'attributed_by',f.attributed_by,'login',f.login)
  from fabrik.file_event f where f.at>=p_from and f.at<p_to
  union all
  select s.at,'s:'||lpad(s.event_id::text,19,'0'),s.event,null::uuid,s.actor_id,fabrik_private.actor_name(s.actor_id),null::text,
   jsonb_build_object('session_id',s.session_id,'auth_user_id',s.auth_user_id,'user_agent',s.user_agent,'ip',s.ip)
  from fabrik.sign_in_event s where s.at>=p_from and s.at<p_to),
 keyed as (select e.*,(extract(epoch from e.at)*1000000)::bigint micros from events e),
 page as (select * from keyed where p_cursor is null or (micros,k)<(c_at,c_key) order by micros desc,k desc limit p_limit)
 select jsonb_build_object(
  'items',coalesce(jsonb_agg(jsonb_build_object('at',p.at,'event',p.event,'scope_id',p.scope_id,'scope_name',fabrik_private.scope_name(p.scope_id),
    'actor_id',p.actor_id,'actor_name',fabrik_private.actor_name(p.actor_id),'subject',p.subject,'reason',p.reason)||p.details order by p.micros desc,p.k desc),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(p.micros::text||'/'||p.k order by p.micros,p.k))[1] end) into result
 from page p;
 return result;
end $$;
reset role;

revoke create on schema fabrik_private from fabrik_identity;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_get_audit(timestamptz,timestamptz,text,integer) from public, anon;
grant execute on function fabrik.fabrik_get_audit(timestamptz,timestamptz,text,integer) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8b. A plan's owner and a task's assignee.
-- ===================================================================
grant create on schema fabrik_private to fabrik_identity;
grant create on schema fabrik to fabrik_reader;

set role fabrik_identity;
-- The person who answers for an actor: the actor itself for a person, and its accountable
-- person for an agent or an application. A plan's owner is the person who answers for its creator.
create or replace function fabrik_private.actor_person(p_actor uuid) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select accountable_human_id from fabrik.actor where actor_id=p_actor
$$;
-- The enabled people who can read activities in a scope, whose names hold every word given,
-- in any case. Used to find a task's assignee.
create or replace function fabrik_private.scope_people(p_scope uuid, p_name text) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('actor_id',a.actor_id,'display_name',a.display_name) order by a.display_name,a.actor_id),'[]'::jsonb)
 from fabrik.actor a where a.actor_kind='human' and a.enabled
  and fabrik_private.scope_read_for(a.actor_id,p_scope,'activity',null)
  and not exists(select 1 from regexp_split_to_table(btrim(coalesce(p_name,'')),'\s+') w where w<>'' and strpos(lower(a.display_name),lower(w))=0)
$$;
revoke all on function fabrik_private.actor_person(uuid), fabrik_private.scope_people(uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.actor_person(uuid), fabrik_private.scope_people(uuid,text) to fabrik_owner, fabrik_writer, fabrik_reader;
reset role;

set role fabrik_reader;
-- The people a task in a scope can be assigned to, for an actor who can read the scope. An actor
-- who cannot read it gets none.
create or replace function fabrik.fabrik_find_people(p_scope_id uuid, p_name text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if p_scope_id is null or not fabrik_private.can_read_scope(p_scope_id) then return jsonb_build_object('items','[]'::jsonb); end if;
 return jsonb_build_object('items',fabrik_private.scope_people(p_scope_id,p_name));
end $$;

-- The tasks assigned to the caller that they may read, at their latest version at the cutoff,
-- soonest finish first. Completed and cancelled tasks only when p_include_closed is true.
reset role;
set role fabrik_identity;
create or replace function fabrik_private.read_assigned(p_include_closed boolean, p_cutoff bigint,
 p_cursor integer, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare rr uuid[]; m bigint; c bigint; me uuid; obs timestamptz:=clock_timestamp(); result jsonb;
begin
 perform fabrik_private.read_actor();
 rr:=array(select fabrik_private.readable_records());
 select coalesce(max(v.change_no),0) into m from fabrik.record_version v where v.record_id in (select unnest(rr));
 if p_cutoff is not null and (p_cutoff<0 or p_cutoff>m) then raise exception 'Cutoff outside accessible history' using errcode='22023'; end if;
 c:=coalesce(p_cutoff,m);
 me:=(fabrik_private.read_actor()).actor_id;
 if p_limit is null or p_limit not between 1 and 100 or (p_cursor is not null and p_cursor<0) then raise exception 'Invalid assigned tasks page' using errcode='22023'; end if;
 with latest as (select distinct on(v.record_id) v.*,r.scope_id from fabrik.record_version v join fabrik.record r using(record_id)
  where r.kind='activity' and r.deleted_at is null and r.record_id in (select unnest(rr)) and v.change_no<=c order by v.record_id,v.change_no desc),
 mine as (select l.*,fabrik_private.activity_state(l.payload->>'state') state,
  coalesce(l.payload->>'forecast_finish_at',l.payload->>'baseline_finish_at')::timestamptz finish_at
  from latest l where l.payload->>'assignee_actor_id'=me::text
  and (coalesce(p_include_closed,false) or fabrik_private.activity_state(l.payload->>'state') not in ('completed','cancelled'))),
 page as (select * from mine order by finish_at nulls last,record_id offset coalesce(p_cursor,0) limit p_limit)
 select jsonb_build_object('cutoff',c,'observed_at',obs,
  'items',coalesce(jsonb_agg(jsonb_build_object('record_id',q.record_id,'scope_id',q.scope_id,'scope_name',fabrik_private.scope_name(q.scope_id),
   'title',q.title,'version_id',q.version_id,'version_number',q.version_number,'index',q.payload->>'index','state',q.state,
   'description',q.payload->>'description','completion_requirements',q.payload->>'completion_requirements',
   'baseline_finish_at',q.payload->>'baseline_finish_at','forecast_finish_at',q.payload->>'forecast_finish_at',
   'overdue_seconds',case when q.state not in ('completed','cancelled') and q.finish_at is not null then greatest(0,extract(epoch from(obs-q.finish_at))) end,
   'blockers',q.payload->'blockers',
   'parent',(select jsonb_build_object('record_id',pv.record_id,'title',pl.title) from fabrik.version_link vl
     join fabrik.record_version pv on pv.version_id=vl.target_version_id join latest pl on pl.record_id=pv.record_id
     where vl.source_version_id=q.version_id and vl.relation='parent'),
   'unfinished_dependencies',(select count(*) from fabrik.version_link vl join fabrik.record_version dv on dv.version_id=vl.target_version_id
     join latest d on d.record_id=dv.record_id where vl.source_version_id=q.version_id and vl.relation='depends_on'
     and fabrik_private.activity_state(d.payload->>'state')<>'completed'))
   order by q.finish_at nulls last,q.record_id),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then coalesce(p_cursor,0)+p_limit end) into result from page q;
 return result;
end $$;
revoke all on function fabrik_private.read_assigned(boolean,bigint,integer,integer) from public, anon, authenticated;
grant execute on function fabrik_private.read_assigned(boolean,bigint,integer,integer) to fabrik_owner, fabrik_reader;
reset role;
set role fabrik_reader;
create or replace function fabrik.fabrik_get_assigned(p_include_closed boolean default false, p_cutoff bigint default null,
 p_cursor integer default null, p_limit integer default 100) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.read_assigned(p_include_closed,p_cutoff,p_cursor,p_limit)
$$;
reset role;

revoke create on schema fabrik_private from fabrik_identity;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_find_people(uuid,text), fabrik.fabrik_get_assigned(boolean,bigint,integer,integer) from public, anon;
grant execute on function fabrik.fabrik_find_people(uuid,text), fabrik.fabrik_get_assigned(boolean,bigint,integer,integer) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8c. Sign-ins.
-- ===================================================================
-- Each sign-in and sign-out, as Supabase Auth opens and ends a session. Append-only, written only
-- by the trigger on auth.sessions and by the listing of the sessions open when this section runs.
set role fabrik_owner;
create table if not exists fabrik.sign_in_event (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 event text not null check (event in ('signed_in','signed_out','session_expired')),
 session_id uuid not null,
 auth_user_id uuid not null,
 actor_id uuid references fabrik.actor(actor_id),
 user_agent text,
 ip text
);
create index if not exists sign_in_event_time_idx on fabrik.sign_in_event(at desc);
create index if not exists sign_in_event_actor_idx on fabrik.sign_in_event(actor_id);
alter table fabrik.sign_in_event enable row level security;
revoke all on fabrik.sign_in_event from public;
grant select on fabrik.sign_in_event to fabrik_reader;

create or replace function fabrik_private.guard_sign_in_event()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 raise exception 'The sign-in log is append-only' using errcode='23514';
end $$;
revoke all on function fabrik_private.guard_sign_in_event() from public, anon, authenticated;

-- Runs for each session Supabase Auth opens or ends. A sign-in never fails on the log: an error
-- here is raised as a warning, and the session goes ahead unlogged.
create or replace function fabrik_private.log_sign_in_event()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 begin
  if tg_op='INSERT' then
   insert into fabrik.sign_in_event(at,event,session_id,auth_user_id,actor_id,user_agent,ip)
   values(coalesce(new.created_at,clock_timestamp()),'signed_in',new.id,new.user_id,
    (select actor_id from fabrik.actor where auth_user_id=new.user_id),new.user_agent,host(new.ip));
  else
   -- A session Supabase Auth removes after its expiry ended by itself, with no one signing out.
   insert into fabrik.sign_in_event(event,session_id,auth_user_id,actor_id,user_agent,ip)
   values(case when old.not_after is not null and old.not_after<=clock_timestamp() then 'session_expired' else 'signed_out' end,
    old.id,old.user_id,(select actor_id from fabrik.actor where auth_user_id=old.user_id),old.user_agent,host(old.ip));
  end if;
 exception when others then
  raise warning 'fabrik could not log a sign-in: %',sqlerrm;
 end;
 return null;
end $$;
revoke all on function fabrik_private.log_sign_in_event() from public, anon, authenticated;
reset role;

drop trigger if exists sign_in_event_immutable on fabrik.sign_in_event;
create trigger sign_in_event_immutable before update or delete on fabrik.sign_in_event
 for each row execute function fabrik_private.guard_sign_in_event();
drop trigger if exists sign_in_event_no_truncate on fabrik.sign_in_event;
create trigger sign_in_event_no_truncate before truncate on fabrik.sign_in_event
 for each statement execute function fabrik_private.guard_sign_in_event();
-- postgres may create a trigger on auth.sessions, but only its owner may drop one.
do $$
begin
 if not exists(select 1 from pg_trigger where tgname='fabrik_sign_in_event' and tgrelid='auth.sessions'::regclass) then
  create trigger fabrik_sign_in_event after insert or delete on auth.sessions
   for each row execute function fabrik_private.log_sign_in_event();
 end if;
end $$;

-- Only an administrator reads the sign-in log.
drop policy if exists sign_in_event_reader_read on fabrik.sign_in_event;
create policy sign_in_event_reader_read on fabrik.sign_in_event for select to fabrik_reader
 using ((select (fabrik_private.current_actor()).authority_class)='administrator');

-- The sessions already open, logged as signed in when they opened.
insert into fabrik.sign_in_event(at,event,session_id,auth_user_id,actor_id,user_agent,ip)
select coalesce(s.created_at,clock_timestamp()),'signed_in',s.id,s.user_id,a.actor_id,s.user_agent,host(s.ip)
from auth.sessions s left join fabrik.actor a on a.auth_user_id=s.user_id
where not exists(select 1 from fabrik.sign_in_event e where e.session_id=s.id and e.event='signed_in');

-- Each actor with a login, with their sign-in, last activity and open sessions, latest activity
-- first. Owned by postgres, the one role that reads auth's tables; fabrik_get_sign_ins checks the caller.
create or replace function fabrik_private.sign_ins() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(i order by (i->>'last_active_at')::timestamptz desc nulls last, i->>'actor_name'),'[]'::jsonb)
 from (
  select jsonb_build_object('actor_id',x.actor_id,'actor_name',x.display_name,'actor_kind',x.actor_kind,
   'authority_class',x.authority_class,'enabled',x.enabled,'email',u.email,'login_created_at',u.created_at,
   'last_sign_in_at',u.last_sign_in_at,
   'last_active_at',greatest((select max(greatest(s.refreshed_at at time zone 'UTC',s.updated_at)) from auth.sessions s where s.user_id=u.id),u.last_sign_in_at),
   'open_sessions',(select count(*) from auth.sessions s where s.user_id=u.id and (s.not_after is null or s.not_after>now())),
   'latest_session',(select jsonb_build_object('signed_in_at',s.created_at,'user_agent',s.user_agent,'ip',host(s.ip))
     from auth.sessions s where s.user_id=u.id
     order by greatest(s.refreshed_at at time zone 'UTC',s.updated_at,s.created_at) desc nulls last limit 1)) i
  from fabrik.actor x join auth.users u on u.id=x.auth_user_id) z
$$;
revoke all on function fabrik_private.sign_ins() from public, anon, authenticated;
grant execute on function fabrik_private.sign_ins() to fabrik_reader;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- Who has signed in to fabrik and when, for an administrator.
create or replace function fabrik.fabrik_get_sign_ins() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.read_actor();
 if a.authority_class is distinct from 'administrator' then raise exception 'Administrator required' using errcode='42501'; end if;
 return jsonb_build_object('items',fabrik_private.sign_ins());
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_get_sign_ins() from public, anon;
grant execute on function fabrik.fabrik_get_sign_ins() to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8d. Task functions.
-- ===================================================================
-- A person names a scope by its id, code or name, and a record by its id or exact title. Each task
-- function fills in the rest of a save request and saves it with fabrik_save_version, or with
-- p_preview returns the request and grant it would save with. Each runs as the signed-in actor and
-- calls only fabrik's own functions, so it reaches nothing a direct call to them does not. Its helpers
-- live in a schema of their own, which authenticated may use and the Data API never exposes.
create schema if not exists fabrik_task authorization fabrik_owner;
revoke all on schema fabrik_task from public;
grant usage on schema fabrik_task to authenticated, fabrik_reader;
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_reader;
reset role;
grant create on schema fabrik to fabrik_reader;

set role fabrik_reader;
-- A version's links, each with its target's record and kind, and the title, index and id of the
-- target's latest version, as the caller may read them.
create or replace function fabrik_task.version_links(p_version_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('link_id',l.link_id,'relation',l.relation,'target_version_id',l.target_version_id,
   'target_record_id',tv.record_id,'target_kind',r.kind,'target_title',lv.title,'target_index',lv.payload->>'index',
   'target_latest_version_id',lv.version_id,
   'target_deleted',r.deleted_at is not null,'locator',l.locator,'note',l.note) order by l.link_id),'[]'::jsonb)
 from fabrik.version_link l left join fabrik.record_version tv on tv.version_id=l.target_version_id
  left join fabrik.record r on r.record_id=tv.record_id
  left join lateral (select cv.version_id,cv.title,cv.payload from fabrik.record_version cv where cv.record_id=tv.record_id order by cv.change_no desc limit 1) lv on true
 where l.source_version_id=p_version_id
$$;
reset role;

-- A save request's shape checks, which a preview runs before it returns.
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_writer;
reset role;
set role fabrik_writer;
create or replace function fabrik_task.check_shape(p_request jsonb) returns void
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.validate_shape(p_request)
$$;
reset role;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_writer;
reset role;

set role fabrik_owner;
-- Every scope, from fabrik_get_scopes.
create or replace function fabrik_task.scopes() returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare page jsonb; cur uuid; acc jsonb:='[]'::jsonb;
begin
 loop
  page:=fabrik.fabrik_get_scopes(cur,100);
  acc:=acc||(page->'items');
  cur:=(page->>'next_cursor')::uuid;
  exit when cur is null;
 end loop;
 return acc;
end $$;

-- The scope named by its id, then its code, then its name, in any case.
create or replace function fabrik_task.scope(p_scope text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare all_scopes jsonb:=fabrik_task.scopes(); s text:=lower(btrim(coalesce(p_scope,''))); hits jsonb; k text;
begin
 foreach k in array array['scope_id','code','display_name'] loop
  select coalesce(jsonb_agg(x),'[]'::jsonb) into hits from jsonb_array_elements(all_scopes) x where lower(x->>k)=s;
  if jsonb_array_length(hits)=1 then return hits->0; end if;
  if jsonb_array_length(hits)>1 then
   raise exception 'More than one scope has the name "%": %',p_scope,(select string_agg(format('%s (code %s, id %s)',x->>'display_name',x->>'code',x->>'scope_id'),'; ') from jsonb_array_elements(hits) x)
    using errcode='22023';
  end if;
 end loop;
 raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
end $$;

create or replace function fabrik_task.scope_name(p_scope_id uuid) returns text
language sql stable set search_path=pg_catalog as $$
 select x->>'display_name' from jsonb_array_elements(fabrik_task.scopes()) x where x->>'scope_id'=p_scope_id::text
$$;

-- The record named by its id, or by its exact title in any case among the records the caller may read.
create or replace function fabrik_task.record_id(p_record text) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); page jsonb; cut bigint; cur bigint; hits jsonb:='[]'::jsonb;
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return t::uuid; end if;
 loop
  page:=fabrik.fabrik_find_records(null,null,t,cut,cur,100);
  cut:=(page->>'cutoff')::bigint;
  hits:=hits||coalesce((select jsonb_agg(x) from jsonb_array_elements(page->'items') x where lower(btrim(x->>'title'))=lower(t)),'[]'::jsonb);
  cur:=(page->>'next_cursor')::bigint;
  exit when cur is null;
 end loop;
 if jsonb_array_length(hits)=1 then return (hits->0->>'record_id')::uuid; end if;
 if jsonb_array_length(hits)=0 then raise exception 'Record unavailable: no record you can read has the title "%"',t using errcode='42501'; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, saved %s, id %s)',x->>'title',fabrik_task.scope_name((x->>'scope_id')::uuid),x->>'saved_at',x->>'record_id'),'; ')
   from jsonb_array_elements(hits) x) using errcode='22023';
end $$;

-- A record's latest version and links, from fabrik_get_record.
create or replace function fabrik_task.latest(p_record_id uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare r jsonb:=fabrik.fabrik_get_record(p_record_id);
begin
 if r is null then raise exception 'Record unavailable' using errcode='42501'; end if;
 if r ? 'deleted' then raise exception 'The record was deleted' using errcode='23514'; end if;
 return r;
end $$;

-- A record's kind, from the fields its payload holds.
create or replace function fabrik_task.kind(p_payload jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_payload ? 'activity_kind' then 'activity' when p_payload ? 'question' then 'decision'
  when p_payload ? 'standing' then 'evidence' when p_payload ? 'model_kind' then 'model' end
$$;

-- A new record's fields, each at its empty value.
create or replace function fabrik_task.empty_payload(p_kind text) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select case p_kind
  when 'activity' then jsonb_build_object('activity_kind','task','state','pending','description','','owner_actor_id',null,'completion_requirements','',
   'completion_note','','baseline_start_at',null,'baseline_finish_at',null,'forecast_start_at',null,'forecast_finish_at',null,
   'blockers','[]'::jsonb,'external_references','[]'::jsonb)
  when 'decision' then jsonb_build_object('question','','alternatives','[]'::jsonb,'decision','','rationale','','decided_on',null)
  when 'evidence' then jsonb_build_object('summary','','source_reference',null,'source_date',null,'standing','','limitations','')
  when 'model' then jsonb_build_object('model_kind','','source_version','','source_status','','description','',
   'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb))
 end
$$;

-- A record's links as a save request carries them.
create or replace function fabrik_task.request_links(p_record jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',l->'target_version_id','relation',l->'relation',
  'locator',l->'locator','note',l->'note')) order by (l->>'link_id')::uuid),'[]'::jsonb)
 from jsonb_array_elements(coalesce(p_record->'links','[]'::jsonb)) l
$$;

-- The actions a change needs, as fabrik_save_version reckons them.
create or replace function fabrik_task.actions(p_kind text, p_old jsonb, p_new jsonb) returns text[]
language plpgsql immutable set search_path=pg_catalog as $$
declare a text[]; o text; n text;
begin
 if p_old is null then
  a:=array['create'];
  if p_kind='decision' and coalesce(p_new->>'decision','')<>'' then a:=a||'decide'::text; end if;
  return a;
 end if;
 a:=array['edit'];
 if p_kind='activity' then
  o:=case p_old->>'state' when 'planned' then 'pending' when 'active' then 'in_progress' when 'on_hold' then 'paused' else p_old->>'state' end;
  n:=p_new->>'state';
  if o<>n then
   a:=a||case when n='in_progress' and o='completed' then 'reopen' when n='in_progress' then 'start' when n='paused' then 'hold'
    when n='completed' then 'complete' else 'cancel' end;
  end if;
 elsif p_kind='decision' and p_new->'decision' is distinct from p_old->'decision' then
  a:=a||'decide'::text;
 end if;
 return a;
end $$;

-- The grant to save a request with: none for a person who is an administrator, or for an actor whose
-- every save needs an approval; otherwise the caller's live standing grant in the request's scope that
-- covers its kind, its record and every action, soonest expiry first.
create or replace function fabrik_task.grant_for(p_request jsonb, p_actions text[]) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare me jsonb:=fabrik.fabrik_get_actor(); page jsonb; cur uuid; acc jsonb:='[]'::jsonb; g uuid;
begin
 if (me->>'actor_kind'='human' and me->>'authority_class'='administrator') or (me->>'requires_human_approval')::boolean then return null; end if;
 loop
  page:=fabrik.fabrik_get_authorisations((me->>'actor_id')::uuid,cur,100);
  acc:=acc||(page->'items');
  cur:=(page->>'next_cursor')::uuid;
  exit when cur is null;
 end loop;
 select (z->>'authorisation_id')::uuid into g from jsonb_array_elements(acc) z
 where z->>'mode'='standing_permission' and z->>'revoked_at' is null
  and (z->>'expires_at' is null or (z->>'expires_at')::timestamptz>clock_timestamp())
  and z->>'scope_id'=p_request->>'scope_id'
  and (z->'record_kinds') ? (p_request->>'kind')
  and (z->>'record_id' is null or z->>'record_id'=p_request->>'record_id')
  and (select coalesce(bool_and((z->'allowed_actions') ? x),true) from unnest(p_actions) x)
 order by (z->>'own_records')::boolean,(z->>'expires_at')::timestamptz nulls last,z->>'authorisation_id' limit 1;
 if g is null then
  raise exception 'No grant of yours covers % on % records in %. An administrator can grant it, or approve this exact change',
   array_to_string(p_actions,', '),p_request->>'kind',fabrik_task.scope_name((p_request->>'scope_id')::uuid) using errcode='42501';
 end if;
 return g;
end $$;

-- Saves a request with its grant, or returns both for p_preview.
create or replace function fabrik_task.save(p_request jsonb, p_actions text[], p_preview boolean) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare g uuid:=fabrik_task.grant_for(p_request,p_actions);
begin
 if coalesce(p_preview,false) then
  perform fabrik_task.check_shape(p_request);
  return jsonb_build_object('preview',true,'request',p_request,'authorisation_id',g,'actions',to_jsonb(p_actions));
 end if;
 if (fabrik.fabrik_get_actor()->>'requires_human_approval')::boolean then
  raise exception 'Every save by this actor needs a person''s approval. Save the preview''s request with an approval, as the fabrik:records skill''s section 5 describes'
   using errcode='42501';
 end if;
 return fabrik.fabrik_save_version(p_request,g);
end $$;

-- A new version of a record: its latest payload with p_fields merged in, its title or p_title, and its
-- links or p_links.
create or replace function fabrik_task.change(p_record_id uuid, p_reason text, p_fields jsonb, p_title text, p_links jsonb, p_preview boolean) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare r jsonb:=fabrik_task.latest(p_record_id); v jsonb:=r->'version'; k text:=fabrik_task.kind(v->'payload'); payload jsonb; req jsonb;
begin
 if jsonb_typeof(coalesce(p_fields,'{}'::jsonb))<>'object' then raise exception 'The fields are a JSON object' using errcode='22023'; end if;
 payload:=(v->'payload')||coalesce(p_fields,'{}'::jsonb);
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',v->'record_id','scope_id',v->'scope_id','kind',k,
  'expected_previous_version_id',v->'version_id','title',coalesce(p_title,v->>'title'),'reason',p_reason,'payload',payload,
  'links',coalesce(p_links,fabrik_task.request_links(r)));
 return fabrik_task.save(req,fabrik_task.actions(k,v->'payload',payload),p_preview);
end $$;

-- A new record in a scope, with an optional parent plan. A new activity's owner is the person who
-- answers for the caller, unless p_fields names one.
create or replace function fabrik_task.add(p_scope_id uuid, p_kind text, p_title text, p_reason text, p_fields jsonb, p_parent_id uuid, p_preview boolean) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare payload jsonb; links jsonb:='[]'::jsonb; req jsonb;
begin
 if p_kind is null or p_kind not in ('activity','decision','evidence','model') then
  raise exception 'Kind must be activity, decision, model or evidence' using errcode='22023';
 end if;
 if jsonb_typeof(coalesce(p_fields,'{}'::jsonb))<>'object' then raise exception 'The fields are a JSON object' using errcode='22023'; end if;
 payload:=fabrik_task.empty_payload(p_kind)||coalesce(p_fields,'{}'::jsonb);
 if p_kind='activity' and coalesce(payload->'owner_actor_id','null'::jsonb)='null'::jsonb then
  payload:=payload||jsonb_build_object('owner_actor_id',fabrik.fabrik_get_actor()->'accountable_human_id');
 end if;
 if p_kind='activity' and payload->>'activity_kind'='task' and not payload ? 'task_type' then payload:=payload||'{"task_type":"work"}'; end if;
 if p_parent_id is not null then
  links:=jsonb_build_array(jsonb_build_object('target_version_id',fabrik_task.latest(p_parent_id)->'version'->'version_id','relation','parent'));
 end if;
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',p_scope_id,'kind',p_kind,
  'expected_previous_version_id',null,'title',p_title,'reason',p_reason,'payload',payload,'links',links);
 return fabrik_task.save(req,fabrik_task.actions(p_kind,null,payload),p_preview);
end $$;

-- The activities in a scope, from fabrik_get_progress.
create or replace function fabrik_task.activities(p_scope_id uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare page jsonb; cut bigint; obs timestamptz; cur uuid; acc jsonb:='[]'::jsonb;
begin
 loop
  page:=fabrik.fabrik_get_progress(cut,obs,cur,100,p_scope_id);
  cut:=(page->>'cutoff')::bigint; obs:=(page->>'observed_at')::timestamptz;
  acc:=acc||(page->'items');
  cur:=(page->>'next_cursor')::uuid;
  exit when cur is null;
 end loop;
 return acc;
end $$;

-- A task's parent plan, and the indexes of the plan's activities.
create or replace function fabrik_task.task(p_record_id uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare r jsonb:=fabrik_task.latest(p_record_id); v jsonb:=r->'version'; plan uuid; indexes jsonb;
begin
 if v->'payload'->>'activity_kind' is distinct from 'task' then raise exception 'Name a task' using errcode='22023'; end if;
 select (l->>'target_record_id')::uuid into plan from jsonb_array_elements(fabrik_task.version_links((v->>'version_id')::uuid)) l where l->>'relation'='parent';
 select coalesce(jsonb_agg(a->'payload'->'index'),'[]'::jsonb) into indexes from jsonb_array_elements(fabrik_task.activities((v->>'scope_id')::uuid)) a
  where a->'payload' ? 'index' and a->'parent'->>'record_id' is not distinct from plan::text;
 return jsonb_build_object('record',r,'plan_id',plan,'indexes',indexes);
end $$;

-- A record's links as a save request carries them, with a link of a relation to the target record's
-- latest version. It replaces the record's link of that relation to the same record, and a parent
-- replaces any other parent.
create or replace function fabrik_task.links_with(p_record jsonb, p_target_id uuid, p_relation text, p_note text, p_locator text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare links jsonb;
begin
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',l->'target_version_id','relation',l->'relation','locator',l->'locator','note',l->'note'))
  order by (l->>'link_id')::uuid),'[]'::jsonb) into links
 from jsonb_array_elements(p_record->'links') l
 where not exists(select 1 from jsonb_array_elements(fabrik_task.version_links((p_record->'version'->>'version_id')::uuid)) m
  where m->>'link_id'=l->>'link_id' and m->>'relation'=p_relation and (m->>'target_record_id'=p_target_id::text or p_relation='parent'));
 return links||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('target_version_id',fabrik_task.latest(p_target_id)->'version'->'version_id',
  'relation',p_relation,'locator',p_locator,'note',p_note)));
end $$;
reset role;

set role fabrik_reader;
-- A record's latest version, its scope's name, and each link with its target's title and index.
create or replace function fabrik.fabrik_show_record(p_record text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare r jsonb:=fabrik_task.latest(fabrik_task.record_id(p_record)); v jsonb:=r->'version';
begin
 return jsonb_build_object('record_id',v->'record_id','scope_id',v->'scope_id','scope_name',fabrik_task.scope_name((v->>'scope_id')::uuid),
  'kind',fabrik_task.kind(v->'payload'),'title',v->'title','version_id',v->'version_id','version_number',v->'version_number',
  'saved_at',v->'recorded_at','reason',v->'change_reason','payload',v->'payload',
  'links',(select coalesce(jsonb_agg(l-'link_id' order by (l->>'link_id')::uuid),'[]'::jsonb) from jsonb_array_elements(fabrik_task.version_links((v->>'version_id')::uuid)) l));
end $$;

-- A new record. Fields not given take their empty value; a new task's type is work.
create or replace function fabrik.fabrik_add_record(p_scope text, p_kind text, p_title text, p_reason text, p_fields jsonb default '{}',
 p_parent text default null, p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.add((fabrik_task.scope(p_scope)->>'scope_id')::uuid,p_kind,p_title,p_reason,p_fields,
  case when p_parent is not null then fabrik_task.record_id(p_parent) end,p_preview)
$$;

-- A new version with the given fields changed, and the title when one is given.
create or replace function fabrik.fabrik_change_record(p_record text, p_reason text, p_fields jsonb default '{}', p_title text default null,
 p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.change(fabrik_task.record_id(p_record),p_reason,p_fields,p_title,null,p_preview)
$$;

-- An activity's new state, with its completion note when one is given.
create or replace function fabrik.fabrik_set_state(p_record text, p_state text, p_reason text, p_note text default null,
 p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.change(fabrik_task.record_id(p_record),p_reason,
  jsonb_build_object('state',p_state)||case when p_note is not null then jsonb_build_object('completion_note',p_note) else '{}'::jsonb end,null,null,p_preview)
$$;

-- A link to the target's latest version. It replaces a link of the same relation to the same record,
-- and a parent replaces any other parent.
create or replace function fabrik.fabrik_link(p_record text, p_target text, p_relation text, p_reason text, p_note text default null,
 p_locator text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record);
begin
 return fabrik_task.change(rid,p_reason,'{}'::jsonb,null,
  fabrik_task.links_with(fabrik_task.latest(rid),fabrik_task.record_id(p_target),p_relation,p_note,p_locator),p_preview);
end $$;

-- A new version without the record's link of a relation to the target record.
create or replace function fabrik.fabrik_unlink(p_record text, p_target text, p_relation text, p_reason text,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); tid uuid:=fabrik_task.record_id(p_target); r jsonb:=fabrik_task.latest(rid);
 gone jsonb; links jsonb;
begin
 select coalesce(jsonb_agg(m->'link_id'),'[]'::jsonb) into gone from jsonb_array_elements(fabrik_task.version_links((r->'version'->>'version_id')::uuid)) m
 where m->>'relation'=p_relation and m->>'target_record_id'=tid::text;
 if jsonb_array_length(gone)=0 then raise exception 'The record has no % link to that record',p_relation using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',l->'target_version_id','relation',l->'relation','locator',l->'locator','note',l->'note'))
  order by (l->>'link_id')::uuid),'[]'::jsonb) into links
 from jsonb_array_elements(r->'links') l where not gone @> jsonb_build_array(l->'link_id');
 return fabrik_task.change(rid,p_reason,'{}'::jsonb,null,links,p_preview);
end $$;

-- A task's assignee, found by words of their name among the people who can read its scope; null removes it.
create or replace function fabrik.fabrik_assign(p_record text, p_person text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); s uuid:=(fabrik_task.latest(rid)->'version'->>'scope_id')::uuid; people jsonb; who jsonb;
begin
 if p_person is null then return fabrik_task.change(rid,p_reason,'{"assignee_actor_id":null}',null,null,p_preview); end if;
 people:=fabrik.fabrik_find_people(s,p_person)->'items';
 if jsonb_array_length(people)>1 then
  select coalesce(jsonb_agg(x),'[]'::jsonb) into who from jsonb_array_elements(people) x where lower(x->>'display_name')=lower(btrim(p_person));
  if jsonb_array_length(who)=1 then people:=who; end if;
 end if;
 if jsonb_array_length(people)=0 then
  raise exception 'No person who can read % has a name with "%". An administrator can give them read in the scope',fabrik_task.scope_name(s),p_person using errcode='22023';
 end if;
 if jsonb_array_length(people)>1 then
  raise exception 'More than one person fits "%": %',p_person,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
 end if;
 return fabrik_task.change(rid,p_reason,jsonb_build_object('assignee_actor_id',people->0->'actor_id'),null,null,p_preview);
end $$;

-- A blocker: its own task under the same plan, at the task's index with -B and the next number, with
-- its requirements: what clears it. The task depends on it and lists it in its blockers. Both saves
-- are made together.
create or replace function fabrik.fabrik_add_blocker(p_task text, p_title text, p_requirements text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare t jsonb:=fabrik_task.task(fabrik_task.record_id(p_task)); tv jsonb:=t->'record'->'version'; idx text; n int; fields jsonb; b jsonb; tl jsonb;
begin
 if tv->'payload' ? 'index' then
  select coalesce(max(substr(x#>>'{}',length(tv->'payload'->>'index')+3)::int),0)+1 into n from jsonb_array_elements(t->'indexes') x
  where starts_with(x#>>'{}',(tv->'payload'->>'index')||'-B') and substr(x#>>'{}',length(tv->'payload'->>'index')+3) ~ '^[0-9]{1,6}$';
  idx:=(tv->'payload'->>'index')||'-B'||n;
 end if;
 if btrim(coalesce(p_requirements,''))='' then raise exception 'Give the blocker''s requirements: what clears it' using errcode='22023'; end if;
 fields:=jsonb_build_object('task_type','blocker','completion_requirements',p_requirements)||case when idx is not null then jsonb_build_object('index',idx) else '{}'::jsonb end
  ||case when tv->'payload' ? 'owner_actor_id' then jsonb_build_object('owner_actor_id',tv->'payload'->'owner_actor_id') else '{}'::jsonb end;
 if coalesce(p_preview,false) then
  return jsonb_build_object('preview',true,'saves',jsonb_build_array(
   jsonb_build_object('new_record',p_title,'kind','activity','fields',fields,'parent',t->'plan_id'),
   jsonb_build_object('record',tv->'title','depends_on',p_title,'blockers_add',p_title)));
 end if;
 b:=fabrik_task.add((tv->>'scope_id')::uuid,'activity',p_title,p_reason,fields,(t->>'plan_id')::uuid,false);
 tl:=fabrik_task.request_links(t->'record')||jsonb_build_array(jsonb_build_object('target_version_id',b->'version_id','relation','depends_on'));
 return jsonb_build_object('blocker',b,'task',fabrik_task.change((tv->>'record_id')::uuid,p_reason,
  jsonb_build_object('blockers',(tv->'payload'->'blockers')||jsonb_build_array(jsonb_build_object('blocker_id',b->'record_id','description',p_title))),null,tl,false));
end $$;

-- A deliverable: its own task under the same plan, at the task's index and the next letter, with its
-- requirements. The task depends on it. Both saves are made together.
create or replace function fabrik.fabrik_add_deliverable(p_task text, p_title text, p_requirements text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare t jsonb:=fabrik_task.task(fabrik_task.record_id(p_task)); tv jsonb:=t->'record'->'version'; idx text; last text; fields jsonb; d jsonb; tl jsonb;
begin
 if tv->'payload' ? 'index' then
  select max(right(x#>>'{}',1)) into last from jsonb_array_elements(t->'indexes') x
  where length(x#>>'{}')=length(tv->'payload'->>'index')+1 and starts_with(x#>>'{}',tv->'payload'->>'index') and right(x#>>'{}',1) between 'a' and 'z';
  if last='z' then raise exception 'The task has deliverables a to z' using errcode='22023'; end if;
  idx:=(tv->'payload'->>'index')||coalesce(chr(ascii(last)+1),'a');
 end if;
 fields:=jsonb_build_object('task_type','deliverable','completion_requirements',coalesce(p_requirements,''))
  ||case when idx is not null then jsonb_build_object('index',idx) else '{}'::jsonb end
  ||case when tv->'payload' ? 'owner_actor_id' then jsonb_build_object('owner_actor_id',tv->'payload'->'owner_actor_id') else '{}'::jsonb end;
 if coalesce(p_preview,false) then
  return jsonb_build_object('preview',true,'saves',jsonb_build_array(
   jsonb_build_object('new_record',p_title,'kind','activity','fields',fields,'parent',t->'plan_id'),
   jsonb_build_object('record',tv->'title','depends_on',p_title)));
 end if;
 d:=fabrik_task.add((tv->>'scope_id')::uuid,'activity',p_title,p_reason,fields,(t->>'plan_id')::uuid,false);
 tl:=fabrik_task.request_links(t->'record')||jsonb_build_array(jsonb_build_object('target_version_id',d->'version_id','relation','depends_on'));
 return jsonb_build_object('deliverable',d,'task',fabrik_task.change((tv->>'record_id')::uuid,p_reason,'{}'::jsonb,null,tl,false));
end $$;

-- A blocker cleared: it is started if it has not been, then completed with the note and a supports
-- link to the evidence that it is cleared, and each task that lists it leaves it out of its blockers.
-- The saves are made together.
create or replace function fabrik.fabrik_clear_blocker(p_blocker text, p_note text, p_evidence text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare bid uuid:=fabrik_task.record_id(p_blocker); bv jsonb:=fabrik_task.latest(bid)->'version'; st text; tasks jsonb; x jsonb; saves jsonb:='[]'::jsonb;
 eid uuid; ev jsonb;
begin
 if bv->'payload'->>'task_type' is distinct from 'blocker' then raise exception 'Name a blocker' using errcode='22023'; end if;
 st:=case bv->'payload'->>'state' when 'planned' then 'pending' when 'active' then 'in_progress' when 'on_hold' then 'paused' else bv->'payload'->>'state' end;
 if st not in ('completed','cancelled') then
  if btrim(coalesce(p_note,''))='' then raise exception 'Give the completion note: how the blocker was cleared' using errcode='22023'; end if;
  eid:=fabrik_task.record_id(p_evidence);
  ev:=fabrik_task.latest(eid)->'version';
  if fabrik_task.kind(ev->'payload') is distinct from 'evidence' then raise exception 'Name the evidence that the blocker is cleared' using errcode='22023'; end if;
 end if;
 select coalesce(jsonb_agg(a order by a->>'record_id'),'[]'::jsonb) into tasks from jsonb_array_elements(fabrik_task.activities((bv->>'scope_id')::uuid)) a
  where a->'payload'->'blockers' @> jsonb_build_array(jsonb_build_object('blocker_id',bid::text));
 if coalesce(p_preview,false) then
  return jsonb_build_object('preview',true,'saves',
   case when st in ('pending','paused') then jsonb_build_array(jsonb_build_object('record',bv->'title','state','in_progress')) else '[]'::jsonb end
   ||case when st not in ('completed','cancelled') then jsonb_build_array(jsonb_build_object('record',bv->'title','state','completed','completion_note',p_note,'supports',ev->'title')) else '[]'::jsonb end
   ||coalesce((select jsonb_agg(jsonb_build_object('record',a->'title','blockers_remove',bv->'title')) from jsonb_array_elements(tasks) a),'[]'::jsonb));
 end if;
 if st in ('pending','paused') then saves:=saves||jsonb_build_array(fabrik_task.change(bid,p_reason,'{"state":"in_progress"}',null,null,false)); end if;
 if st not in ('completed','cancelled') then
  saves:=saves||jsonb_build_array(fabrik_task.change(bid,p_reason,jsonb_build_object('state','completed','completion_note',p_note),null,
   fabrik_task.links_with(fabrik_task.latest(bid),eid,'supports',null,null),false));
 end if;
 for x in select value from jsonb_array_elements(tasks) loop
  saves:=saves||jsonb_build_array(fabrik_task.change((x->>'record_id')::uuid,p_reason,
   jsonb_build_object('blockers',(select coalesce(jsonb_agg(k),'[]'::jsonb) from jsonb_array_elements(fabrik_task.latest((x->>'record_id')::uuid)->'version'->'payload'->'blockers') k
    where k->>'blocker_id'<>bid::text)),null,null,false));
 end loop;
 return jsonb_build_object('saves',saves);
end $$;
reset role;

revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on all functions in schema fabrik_task from public, anon;
grant execute on all functions in schema fabrik_task to authenticated;
revoke all on function fabrik.fabrik_show_record(text), fabrik.fabrik_add_record(text,text,text,text,jsonb,text,boolean),
 fabrik.fabrik_change_record(text,text,jsonb,text,boolean), fabrik.fabrik_set_state(text,text,text,text,boolean),
 fabrik.fabrik_link(text,text,text,text,text,text,boolean), fabrik.fabrik_unlink(text,text,text,text,boolean),
 fabrik.fabrik_assign(text,text,text,boolean), fabrik.fabrik_add_blocker(text,text,text,text,boolean),
 fabrik.fabrik_add_deliverable(text,text,text,text,boolean), fabrik.fabrik_clear_blocker(text,text,text,text,boolean) from public, anon;
grant execute on function fabrik.fabrik_show_record(text), fabrik.fabrik_add_record(text,text,text,text,jsonb,text,boolean),
 fabrik.fabrik_change_record(text,text,jsonb,text,boolean), fabrik.fabrik_set_state(text,text,text,text,boolean),
 fabrik.fabrik_link(text,text,text,text,text,text,boolean), fabrik.fabrik_unlink(text,text,text,text,boolean),
 fabrik.fabrik_assign(text,text,text,boolean), fabrik.fabrik_add_blocker(text,text,text,text,boolean),
 fabrik.fabrik_add_deliverable(text,text,text,text,boolean), fabrik.fabrik_clear_blocker(text,text,text,text,boolean) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 10. Reference data: the glossary and the data dictionary, in the reference scope.
-- ===================================================================
-- The glossary says what the business's words mean, for people and agents alike. Each term is a plain
-- term; a class, a kind of thing records and the file search graph are about, such as vendor or
-- property; or a relationship, which names the classes at its two ends, such as owns, from vendor
-- to property. The classes and relationships are the business's ontology. The data dictionary says
-- where each fact is stored: dictionary_table, one row per record kind, linked to its glossary
-- class; dictionary_column, one row per field, with its type, whether it is required and the
-- glossary term it holds; and dictionary_source, the system each field comes from, such as Loop.
-- Setup creates the tables with no rows. Each term and each record kind is a model record in the
-- reference scope, saved with fabrik_save_term or fabrik_save_dictionary under the actor's grant there,
-- as a new version that keeps the old one, and so in the audit log. The rows here are each such
-- record's latest version, kept by a trigger on record_version, so a save of an approved request
-- with fabrik_save_version keeps them too.
set role fabrik_owner;
create table if not exists fabrik.glossary_term (
 term text primary key check (length(term) between 1 and 100 and term=btrim(term)),
 kind text not null check (kind in ('term','class','relationship')),
 definition text not null check (length(btrim(definition)) between 1 and 1000),
 other_names text[] not null default '{}' check (cardinality(other_names)<=20),
 from_class text,
 to_class text,
 -- 'class' for a relationship, so each of its ends must be a glossary term of kind class.
 end_kind text generated always as (case when from_class is not null or to_class is not null then 'class' end) stored,
 record_id uuid not null unique references fabrik.record(record_id),
 version_id uuid not null references fabrik.record_version(version_id),
 unique (term, kind),
 constraint glossary_term_ends_check check (case when kind='relationship' then from_class is not null and to_class is not null
  else from_class is null and to_class is null end),
 constraint glossary_term_from_class_fkey foreign key (from_class, end_kind) references fabrik.glossary_term(term, kind),
 constraint glossary_term_to_class_fkey foreign key (to_class, end_kind) references fabrik.glossary_term(term, kind)
);
create unique index if not exists glossary_term_name_idx on fabrik.glossary_term(lower(term));
create index if not exists glossary_term_from_idx on fabrik.glossary_term(from_class, end_kind);
create index if not exists glossary_term_to_idx on fabrik.glossary_term(to_class, end_kind);
create index if not exists glossary_term_version_idx on fabrik.glossary_term(version_id);
create table if not exists fabrik.dictionary_table (
 table_name text primary key check (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
 class_term text not null,
 class_kind text not null default 'class' check (class_kind='class'),
 meaning text not null check (length(btrim(meaning)) between 1 and 1000),
 record_id uuid not null unique references fabrik.record(record_id),
 version_id uuid not null references fabrik.record_version(version_id),
 constraint dictionary_table_class_fkey foreign key (class_term, class_kind) references fabrik.glossary_term(term, kind)
);
create index if not exists dictionary_table_class_idx on fabrik.dictionary_table(class_term, class_kind);
create index if not exists dictionary_table_version_idx on fabrik.dictionary_table(version_id);
create table if not exists fabrik.dictionary_column (
 table_name text not null references fabrik.dictionary_table(table_name),
 column_name text not null check (column_name ~ '^[a-z][a-z0-9_]{0,62}$'),
 type text not null check (length(type) between 1 and 40),
 required boolean not null,
 term text references fabrik.glossary_term(term),
 meaning text not null check (length(btrim(meaning)) between 1 and 1000),
 version_id uuid not null references fabrik.record_version(version_id),
 primary key (table_name, column_name)
);
create index if not exists dictionary_column_term_idx on fabrik.dictionary_column(term);
create index if not exists dictionary_column_version_idx on fabrik.dictionary_column(version_id);
create table if not exists fabrik.dictionary_source (
 table_name text not null,
 column_name text not null,
 system text not null references fabrik.glossary_term(term),
 field text not null check (length(btrim(field)) between 1 and 200),
 version_id uuid not null references fabrik.record_version(version_id),
 primary key (table_name, column_name, system),
 foreign key (table_name, column_name) references fabrik.dictionary_column(table_name, column_name)
);
create index if not exists dictionary_source_system_idx on fabrik.dictionary_source(system);
create index if not exists dictionary_source_version_idx on fabrik.dictionary_source(version_id);
alter table fabrik.glossary_term enable row level security;
alter table fabrik.dictionary_table enable row level security;
alter table fabrik.dictionary_column enable row level security;
alter table fabrik.dictionary_source enable row level security;
revoke all on fabrik.glossary_term, fabrik.dictionary_table, fabrik.dictionary_column, fabrik.dictionary_source from public, anon, authenticated;
grant select on fabrik.glossary_term, fabrik.dictionary_table, fabrik.dictionary_column, fabrik.dictionary_source to fabrik_writer, fabrik_reader;
grant insert, update, delete on fabrik.glossary_term, fabrik.dictionary_table, fabrik.dictionary_column, fabrik.dictionary_source to fabrik_writer;
-- The functions below read and write these rows for their caller, after their own checks.
drop policy if exists glossary_term_internal on fabrik.glossary_term;
create policy glossary_term_internal on fabrik.glossary_term for all to fabrik_writer, fabrik_reader using (true) with check (true);
drop policy if exists relation_type_internal on fabrik.relation_type;
create policy relation_type_internal on fabrik.relation_type for all to fabrik_identity, fabrik_writer, fabrik_reader using (true) with check (true);
drop policy if exists dictionary_table_internal on fabrik.dictionary_table;
create policy dictionary_table_internal on fabrik.dictionary_table for all to fabrik_writer, fabrik_reader using (true) with check (true);
drop policy if exists dictionary_column_internal on fabrik.dictionary_column;
create policy dictionary_column_internal on fabrik.dictionary_column for all to fabrik_writer, fabrik_reader using (true) with check (true);
drop policy if exists dictionary_source_internal on fabrik.dictionary_source;
create policy dictionary_source_internal on fabrik.dictionary_source for all to fabrik_writer, fabrik_reader using (true) with check (true);
reset role;

grant create on schema fabrik_private to fabrik_identity, fabrik_reader, fabrik_writer;
grant create on schema fabrik to fabrik_reader;
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_reader;
reset role;

set role fabrik_identity;
-- Whether a record is a model record in the reference scope, where terms and record kinds are kept.
create or replace function fabrik_private.in_reference_scope(p_record uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.record r join fabrik.scope s on s.scope_id=r.scope_id
  where r.record_id=p_record and r.kind='model' and s.code='reference')
$$;
revoke all on function fabrik_private.in_reference_scope(uuid) from public, anon, authenticated;
grant execute on function fabrik_private.in_reference_scope(uuid) to fabrik_writer;
-- The reference scope's id, or an error when the setup has not created it.
create or replace function fabrik_private.reference_scope() returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare sid uuid;
begin
 select scope_id into sid from fabrik.scope where code='reference' and enabled;
 if sid is null then raise exception 'The reference scope is not set up' using errcode='42501'; end if;
 return sid;
end $$;
revoke all on function fabrik_private.reference_scope() from public, anon, authenticated;
grant execute on function fabrik_private.reference_scope() to fabrik_reader;
reset role;

set role fabrik_reader;

-- A glossary term, named in any case, as {term, kind, record_id, from_class, to_class, in_use_as_class},
-- or null. Needs read in the reference scope.
create or replace function fabrik_task.glossary_entry(p_term text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if not fabrik_private.can_read_scope(fabrik_private.reference_scope()) then raise exception 'Scope or record unavailable' using errcode='42501'; end if;
 return (select jsonb_build_object('term',g.term,'kind',g.kind,'record_id',g.record_id,'from_class',g.from_class,'to_class',g.to_class,
   'in_use_as_class',exists(select 1 from fabrik.glossary_term x where g.term in (x.from_class,x.to_class))
    or exists(select 1 from fabrik.dictionary_table t where t.class_term=g.term))
  from fabrik.glossary_term g where lower(g.term)=lower(btrim(coalesce(p_term,''))));
end $$;

-- A record kind of the data dictionary, as {table_name, class_term, record_id}, or null. Needs read
-- in the reference scope.
create or replace function fabrik_task.dictionary_entry(p_table text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if not fabrik_private.can_read_scope(fabrik_private.reference_scope()) then raise exception 'Scope or record unavailable' using errcode='42501'; end if;
 return (select jsonb_build_object('table_name',t.table_name,'class_term',t.class_term,'record_id',t.record_id)
  from fabrik.dictionary_table t where t.table_name=btrim(coalesce(p_table,'')));
end $$;

-- The glossary or the data dictionary as it stands, for an actor with read in the reference scope.
-- The glossary lists each term with its kind, definition and other names, and each relationship's
-- two classes. The data dictionary lists each record kind with its class, each field and each source.
create or replace function fabrik.fabrik_get_reference(p_part text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if p_part is null or p_part not in ('glossary','dictionary') then
  raise exception 'Name the glossary or the dictionary' using errcode='22023';
 end if;
 if not fabrik_private.can_read_scope(fabrik_private.reference_scope()) then raise exception 'Scope or record unavailable' using errcode='42501'; end if;
 if p_part='glossary' then
  return jsonb_build_object('part','glossary','rows',(select coalesce(jsonb_agg(jsonb_build_object('term',term,'kind',kind,'definition',definition,
    'other_names',to_jsonb(other_names),'from_class',from_class,'to_class',to_class,'record_id',record_id,'version_id',version_id)
    order by lower(term)),'[]'::jsonb) from fabrik.glossary_term));
 end if;
 return jsonb_build_object('part','dictionary',
  'tables',(select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'class',class_term,'meaning',meaning,'record_id',record_id,'version_id',version_id)
    order by table_name),'[]'::jsonb) from fabrik.dictionary_table),
  'columns',(select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',type,'required',required,'term',term,'meaning',meaning)
    order by table_name,column_name),'[]'::jsonb) from fabrik.dictionary_column),
  'sources',(select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'system',system,'field',field)
    order by table_name,column_name,system),'[]'::jsonb) from fabrik.dictionary_source));
end $$;

-- Saves a glossary term, class or relationship, named in any case, as a new version of its model
-- record in the reference scope, under the caller's grant there, or with p_preview returns the
-- request and grant it would save with. A relationship names a class at each end, from p_from_class
-- to p_to_class; a term or a class has no ends. A class at the end of a relationship or a record
-- kind stays a class. A term's name is fixed: a new name is a new term.
create or replace function fabrik_task.save_term(p_term text, p_kind text, p_definition text, p_reason text,
 p_other_names text[] default '{}', p_from_class text default null, p_to_class text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare sid uuid:=(fabrik_task.scope('reference')->>'scope_id')::uuid; t text:=btrim(coalesce(p_term,'')); e jsonb; f jsonb; g jsonb;
 names jsonb; payload jsonb; req jsonb; latest jsonb;
begin
 if length(t) not between 1 and 100 then raise exception 'A term is 1 to 100 characters' using errcode='22023'; end if;
 if p_kind is null or p_kind not in ('term','class','relationship') then raise exception 'A term''s kind is term, class or relationship' using errcode='22023'; end if;
 if length(btrim(coalesce(p_definition,''))) not between 1 and 1000 then raise exception 'A definition is 1 to 1000 characters' using errcode='22023'; end if;
 select coalesce(jsonb_agg(distinct btrim(n)),'[]'::jsonb) into names from unnest(coalesce(p_other_names,'{}')) n where btrim(n)<>'' and lower(btrim(n))<>lower(t);
 if jsonb_array_length(names)>20 then raise exception 'A term has at most 20 other names' using errcode='22023'; end if;
 if p_kind='relationship' then
  if p_from_class is null or p_to_class is null then
   raise exception 'A relationship names the class at each of its ends, as p_from_class and p_to_class' using errcode='22023';
  end if;
  f:=fabrik_task.glossary_entry(p_from_class); g:=fabrik_task.glossary_entry(p_to_class);
  if f is null or f->>'kind'<>'class' then
   raise exception 'A relationship''s ends are classes, and "%" is not a class in the glossary',btrim(p_from_class) using errcode='23514';
  end if;
  if g is null or g->>'kind'<>'class' then
   raise exception 'A relationship''s ends are classes, and "%" is not a class in the glossary',btrim(p_to_class) using errcode='23514';
  end if;
 elsif p_from_class is not null or p_to_class is not null then
  raise exception 'Only a relationship names classes at its ends' using errcode='22023';
 end if;
 e:=fabrik_task.glossary_entry(t);
 if e is not null and e->>'kind'='class' and p_kind<>'class' and (e->>'in_use_as_class')::boolean then
  raise exception '"%" is the class at the end of a relationship or of a record kind, so it stays a class',e->>'term' using errcode='23514';
 end if;
 if e is not null then t:=e->>'term'; end if;
 payload:=jsonb_build_object('model_kind','observed_current','source_version','fabrik_save_term','source_status','saved',
  'description',btrim(p_definition),'graph',jsonb_build_object('format_version',1,'nodes',jsonb_build_array(jsonb_build_object(
   'id','term','type',p_kind,'label',t,'attributes',jsonb_build_object('term',t,'kind',p_kind,'definition',btrim(p_definition),'other_names',names,
    'from_class',f->>'term','to_class',g->>'term'))),'edges','[]'::jsonb));
 if e is null then
  req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
   'expected_previous_version_id',null,'title','Glossary: '||t,'reason',p_reason,'payload',payload,'links','[]'::jsonb);
  return fabrik_task.save(req,array['create'],p_preview);
 end if;
 latest:=fabrik_task.latest((e->>'record_id')::uuid);
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',e->'record_id','scope_id',sid,'kind','model',
  'expected_previous_version_id',latest->'version'->'version_id','title','Glossary: '||t,'reason',p_reason,'payload',payload,
  'links',fabrik_task.request_links(latest));
 return fabrik_task.save(req,array['edit'],p_preview);
end $$;

-- Saves one record kind of the data dictionary, with its glossary class, its meaning and its fields,
-- as a new version of its model record in the reference scope, under the caller's grant there, or
-- with p_preview returns the request and grant it would save with. p_columns is
-- [{column, type, required, term, meaning, sources: [{system, field}]}]: term, when given, is a
-- glossary term, and each source's system is a glossary term, such as Loop. The fields given replace
-- the record kind's fields.
create or replace function fabrik_task.save_dictionary(p_table text, p_class text, p_meaning text, p_columns jsonb, p_reason text,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare sid uuid:=(fabrik_task.scope('reference')->>'scope_id')::uuid; t text:=btrim(coalesce(p_table,'')); e jsonb; c jsonb; x jsonb; s jsonb;
 nodes jsonb; payload jsonb; req jsonb; latest jsonb; col text; n int:=0;
begin
 if t !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'A record kind''s name is lower case letters, digits and underscores, starting with a letter' using errcode='22023'; end if;
 if length(btrim(coalesce(p_meaning,''))) not between 1 and 1000 then raise exception 'A record kind''s meaning is 1 to 1000 characters' using errcode='22023'; end if;
 c:=fabrik_task.glossary_entry(p_class);
 if c is null or c->>'kind'<>'class' then
  raise exception 'A record kind needs its glossary class, and "%" is not a class in the glossary',coalesce(btrim(p_class),'') using errcode='23514';
 end if;
 if jsonb_typeof(coalesce(p_columns,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_columns,'[]'::jsonb))>200 then
  raise exception 'The fields are a list of at most 200' using errcode='22023';
 end if;
 nodes:=jsonb_build_array(jsonb_build_object('id','table','type','table','label',t,
  'attributes',jsonb_build_object('table',t,'class',c->>'term','meaning',btrim(p_meaning))));
 for x in select value from jsonb_array_elements(coalesce(p_columns,'[]'::jsonb)) loop
  col:=btrim(coalesce(x->>'column',''));
  if col !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'A field''s name is lower case letters, digits and underscores, starting with a letter: "%"',col using errcode='22023'; end if;
  if nodes @> jsonb_build_array(jsonb_build_object('id','column:'||col)) then raise exception 'The field % is given twice',col using errcode='22023'; end if;
  if length(btrim(coalesce(x->>'type',''))) not between 1 and 40 then raise exception 'The field % has a type of 1 to 40 characters',col using errcode='22023'; end if;
  if jsonb_typeof(x->'required') is distinct from 'boolean' then raise exception 'The field % says whether it is required, true or false',col using errcode='22023'; end if;
  if length(btrim(coalesce(x->>'meaning',''))) not between 1 and 1000 then raise exception 'The field % has a meaning of 1 to 1000 characters',col using errcode='22023'; end if;
  e:=case when coalesce(btrim(x->>'term'),'')<>'' then fabrik_task.glossary_entry(x->>'term') end;
  if coalesce(btrim(x->>'term'),'')<>'' and e is null then
   raise exception 'The field % holds "%", which is not in the glossary',col,btrim(x->>'term') using errcode='23514';
  end if;
  nodes:=nodes||jsonb_build_array(jsonb_build_object('id','column:'||col,'type','column','label',col,'attributes',jsonb_build_object(
   'column',col,'type',btrim(x->>'type'),'required',x->'required','term',e->>'term','meaning',btrim(x->>'meaning'))));
  for s in select value from jsonb_array_elements(case when jsonb_typeof(x->'sources')='array' then x->'sources' else '[]'::jsonb end) loop
   e:=fabrik_task.glossary_entry(s->>'system');
   if e is null then raise exception 'The field % comes from "%", which is not in the glossary',col,coalesce(btrim(s->>'system'),'') using errcode='23514'; end if;
   if length(btrim(coalesce(s->>'field',''))) not between 1 and 200 then raise exception 'The field % names its field in % in 1 to 200 characters',col,e->>'term' using errcode='22023'; end if;
   n:=n+1;
   nodes:=nodes||jsonb_build_array(jsonb_build_object('id','source:'||n,'type','source','label',btrim(s->>'field'),'attributes',jsonb_build_object(
    'column',col,'system',e->>'term','field',btrim(s->>'field'))));
  end loop;
 end loop;
 payload:=jsonb_build_object('model_kind','observed_current','source_version','fabrik_save_dictionary','source_status','saved',
  'description',btrim(p_meaning),'graph',jsonb_build_object('format_version',1,'nodes',nodes,'edges','[]'::jsonb));
 e:=fabrik_task.dictionary_entry(t);
 if e is null then
  req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
   'expected_previous_version_id',null,'title','Data dictionary: '||t,'reason',p_reason,'payload',payload,'links','[]'::jsonb);
  return fabrik_task.save(req,array['create'],p_preview);
 end if;
 latest:=fabrik_task.latest((e->>'record_id')::uuid);
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',e->'record_id','scope_id',sid,'kind','model',
  'expected_previous_version_id',latest->'version'->'version_id','title','Data dictionary: '||t,'reason',p_reason,'payload',payload,
  'links',fabrik_task.request_links(latest));
 return fabrik_task.save(req,array['edit'],p_preview);
end $$;

-- Saves a link relation, a lower-case word with underscores, as a new version of its model record in
-- the reference scope, or with p_preview returns the request and grant it would save with. A new
-- code is a relation links may use from then on; an existing code changes its description. Whether a
-- relation allows one link from a version (single_parent) is fixed when it is seeded and cannot be
-- set here. Administrator only.
create or replace function fabrik_task.require_administrator() returns void
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if (fabrik_private.read_actor()).authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
end $$;

-- The record of a link relation, or null when the relation is seeded without one or is not on the list.
-- Administrator only.
create or replace function fabrik_task.relation_record(p_code text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_task.require_administrator();
 return (select t.record_id from fabrik.relation_type t where t.code=p_code);
end $$;

create or replace function fabrik_task.save_relation_type(p_code text, p_description text, p_reason text default null,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare sid uuid:=(fabrik_task.scope('reference')->>'scope_id')::uuid; c text:=btrim(coalesce(p_code,''));
 rid uuid; payload jsonb; req jsonb; latest jsonb; r text:=coalesce(nullif(btrim(p_reason),''),'Relation type '||btrim(coalesce(p_code,'')));
begin
 perform fabrik_task.require_administrator();
 if c !~ '^[a-z]+(_[a-z]+)*$' or length(c)>100 then
  raise exception 'A relation is lower-case words joined by underscores, such as depends_on' using errcode='22023';
 end if;
 if length(btrim(coalesce(p_description,''))) not between 1 and 1000 then raise exception 'A description is 1 to 1000 characters' using errcode='22023'; end if;
 payload:=jsonb_build_object('model_kind','observed_current','source_version','fabrik_save_relation_type','source_status','saved',
  'description',btrim(p_description),'graph',jsonb_build_object('format_version',1,'nodes',jsonb_build_array(jsonb_build_object(
   'id','relation','type','relation_type','label',c,'attributes',jsonb_build_object('code',c,'description',btrim(p_description)))),'edges','[]'::jsonb));
 rid:=fabrik_task.relation_record(c);
 if rid is null then
  -- A seeded relation has no record yet; saving it gives it one, and a new code makes its record.
  req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
   'expected_previous_version_id',null,'title','Relation: '||c,'reason',r,'payload',payload,'links','[]'::jsonb);
  return fabrik_task.save(req,array['create'],p_preview);
 end if;
 latest:=fabrik_task.latest(rid);
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',rid,'scope_id',sid,'kind','model',
  'expected_previous_version_id',latest->'version'->'version_id','title','Relation: '||c,'reason',r,'payload',payload,
  'links',fabrik_task.request_links(latest));
 return fabrik_task.save(req,array['edit'],p_preview);
end $$;

-- The link relations, each as {code, description, single_parent}. Any signed-in actor reads them.
create or replace function fabrik.fabrik_list_relation_types() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 return (select coalesce(jsonb_agg(jsonb_build_object('code',t.code,'description',t.description,'single_parent',t.single_parent) order by t.code),'[]'::jsonb)
  from fabrik.relation_type t);
end $$;

-- The functions actors call. Each runs its body; a change refused for want of permission is undone,
-- logged and answered {"refused": true, "problem": <fabrik's message>}, as every function that changes
-- data does (section 8t).
create or replace function fabrik.fabrik_save_term(p_term text, p_kind text, p_definition text, p_reason text,
 p_other_names text[] default '{}', p_from_class text default null, p_to_class text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_task.save_term(p_term,p_kind,p_definition,p_reason,p_other_names,p_from_class,p_to_class,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_task.refused('fabrik_save_term',m,'reference','model',null);
end $$;

create or replace function fabrik.fabrik_save_dictionary(p_table text, p_class text, p_meaning text, p_columns jsonb, p_reason text,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_task.save_dictionary(p_table,p_class,p_meaning,p_columns,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_task.refused('fabrik_save_dictionary',m,'reference','model',null);
end $$;

create or replace function fabrik.fabrik_save_relation_type(p_code text, p_description text, p_reason text default null,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_task.save_relation_type(p_code,p_description,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_task.refused('fabrik_save_relation_type',m,'reference','model',null);
end $$;
reset role;

set role fabrik_writer;
-- Keeps the glossary's and the data dictionary's rows at each term's and record kind's latest
-- version: runs after each saved version whose payload fabrik_save_term, fabrik_save_dictionary or fabrik_save_relation_type made,
-- and refuses one that breaks the rules above.
create or replace function fabrik_private.keep_reference() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare src text:=new.payload->>'source_version'; n jsonb; a jsonb; old_term text; x jsonb; t text;
begin
 if src is null or src not in ('fabrik_save_term','fabrik_save_dictionary','fabrik_save_relation_type') then return null; end if;
 if not fabrik_private.in_reference_scope(new.record_id) then
  raise exception 'A glossary term or a record kind is a model record in the reference scope' using errcode='23514';
 end if;
 n:=new.payload->'graph'->'nodes'->0; a:=n->'attributes';
 if src='fabrik_save_relation_type' then
  if jsonb_array_length(new.payload->'graph'->'nodes')<>1 or n->>'type' is distinct from 'relation_type' or n->>'label' is distinct from a->>'code' then
   raise exception 'A relation type''s record holds one node, the relation' using errcode='23514';
  end if;
  if exists(select 1 from fabrik.relation_type r where r.record_id=new.record_id and r.code<>a->>'code') then
   raise exception 'A relation''s code is fixed: save "%" as a new relation',a->>'code' using errcode='23514';
  end if;
  -- Every route that saves a relation's version, fabrik_save_version included, comes through here.
  if not exists(select 1 from fabrik.actor x where x.actor_id=new.executor_actor_id and x.authority_class='administrator') then
   raise exception 'Administrator authority required to save a relation' using errcode='42501';
  end if;
  if coalesce(a->>'code','') !~ '^[a-z]+(_[a-z]+)*$' or length(a->>'code')>100 or length(btrim(coalesce(a->>'description','')))=0 then
   raise exception 'A relation is lower-case words joined by underscores, such as depends_on, with a description' using errcode='22023';
  end if;
  -- A code belongs to one record. A seeded relation with no record yet takes the first record that names it.
  if exists(select 1 from fabrik.relation_type r where r.code=a->>'code' and r.record_id is not null and r.record_id<>new.record_id) then
   raise exception 'The relation "%" belongs to another record',a->>'code' using errcode='23514';
  end if;
  insert into fabrik.relation_type(code,description,record_id,version_id)
  values(a->>'code',a->>'description',new.record_id,new.version_id)
  on conflict (code) do update set description=excluded.description,record_id=excluded.record_id,version_id=excluded.version_id;
  return null;
 end if;
 if src='fabrik_save_term' then
  if jsonb_array_length(new.payload->'graph'->'nodes')<>1 or n->>'type' is distinct from a->>'kind' or n->>'label' is distinct from a->>'term' then
   raise exception 'A glossary term''s record holds one node, the term' using errcode='23514';
  end if;
  select term into old_term from fabrik.glossary_term where record_id=new.record_id;
  if old_term is not null and old_term<>a->>'term' then
   raise exception 'A term''s name is fixed: save "%" as a new term',a->>'term' using errcode='23514';
  end if;
  if a->>'kind'='relationship' then
   foreach t in array array[a->>'from_class',a->>'to_class'] loop
    if not exists(select 1 from fabrik.glossary_term g where g.term=t and g.kind='class') then
     raise exception 'A relationship''s ends are classes, and "%" is not a class in the glossary',t using errcode='23514';
    end if;
   end loop;
  end if;
  insert into fabrik.glossary_term(term,kind,definition,other_names,from_class,to_class,record_id,version_id)
  values(a->>'term',a->>'kind',a->>'definition',coalesce((select array_agg(v order by v) from jsonb_array_elements_text(a->'other_names') v),'{}'),
   a->>'from_class',a->>'to_class',new.record_id,new.version_id)
  on conflict (record_id) do update set kind=excluded.kind,definition=excluded.definition,other_names=excluded.other_names,
   from_class=excluded.from_class,to_class=excluded.to_class,version_id=excluded.version_id;
  return null;
 end if;
 if n->>'type' is distinct from 'table' then raise exception 'A record kind''s record starts with its table node' using errcode='23514'; end if;
 if exists(select 1 from fabrik.dictionary_table d where d.record_id=new.record_id and d.table_name<>a->>'table')
  or exists(select 1 from fabrik.dictionary_table d where d.table_name=a->>'table' and d.record_id<>new.record_id) then
  raise exception 'A record kind''s name is fixed: save "%" as a new record kind',a->>'table' using errcode='23514';
 end if;
 if not exists(select 1 from fabrik.glossary_term g where g.term=a->>'class' and g.kind='class') then
  raise exception 'A record kind needs its glossary class, and "%" is not a class in the glossary',coalesce(a->>'class','') using errcode='23514';
 end if;
 delete from fabrik.dictionary_source where table_name=a->>'table';
 delete from fabrik.dictionary_column where table_name=a->>'table';
 insert into fabrik.dictionary_table(table_name,class_term,meaning,record_id,version_id) values(a->>'table',a->>'class',a->>'meaning',new.record_id,new.version_id)
 on conflict (record_id) do update set class_term=excluded.class_term,meaning=excluded.meaning,version_id=excluded.version_id;
 for x in select value->'attributes' from jsonb_array_elements(new.payload->'graph'->'nodes') where value->>'type'='column' loop
  insert into fabrik.dictionary_column(table_name,column_name,type,required,term,meaning,version_id)
  values(a->>'table',x->>'column',x->>'type',(x->>'required')::boolean,x->>'term',x->>'meaning',new.version_id);
 end loop;
 for x in select value->'attributes' from jsonb_array_elements(new.payload->'graph'->'nodes') where value->>'type'='source' loop
  insert into fabrik.dictionary_source(table_name,column_name,system,field,version_id)
  values(a->>'table',x->>'column',x->>'system',x->>'field',new.version_id);
 end loop;
 return null;
end $$;

-- A deleted term or record kind leaves the glossary or the data dictionary. A term still in use,
-- as a relationship's end, a record kind's class, a field's term or a field's source, cannot be
-- deleted until what uses it changes.
create or replace function fabrik_private.forget_reference() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare t text;
begin
 if old.deleted_at is not null or new.deleted_at is null then return null; end if;
 select table_name into t from fabrik.dictionary_table where record_id=new.record_id;
 if t is not null then
  delete from fabrik.dictionary_source where table_name=t;
  delete from fabrik.dictionary_column where table_name=t;
  delete from fabrik.dictionary_table where table_name=t;
 end if;
 delete from fabrik.glossary_term where record_id=new.record_id;
 return null;
exception when foreign_key_violation then
 raise exception 'This term is still used by a relationship or the data dictionary: change those first, then delete it' using errcode='23503';
end $$;
revoke all on function fabrik_private.keep_reference(), fabrik_private.forget_reference() from public, anon, authenticated;
grant execute on function fabrik_private.keep_reference(), fabrik_private.forget_reference() to fabrik_owner;
reset role;
set role fabrik_owner;
create trigger reference_rows after insert on fabrik.record_version
 for each row execute function fabrik_private.keep_reference();
create trigger reference_rows_deleted after update of deleted_at on fabrik.record
 for each row execute function fabrik_private.forget_reference();
reset role;

revoke create on schema fabrik_private from fabrik_identity, fabrik_reader, fabrik_writer;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on function fabrik_task.glossary_entry(text), fabrik_task.dictionary_entry(text) from public, anon;
grant execute on function fabrik_task.glossary_entry(text), fabrik_task.dictionary_entry(text) to authenticated;
revoke all on function fabrik_task.save_term(text,text,text,text,text[],text,text,boolean),
 fabrik_task.save_dictionary(text,text,text,jsonb,text,boolean) from public, anon;
grant execute on function fabrik_task.save_term(text,text,text,text,text[],text,text,boolean),
 fabrik_task.save_dictionary(text,text,text,jsonb,text,boolean) to authenticated;
revoke all on function fabrik_task.save_relation_type(text,text,text,boolean), fabrik_task.require_administrator(), fabrik_task.relation_record(text) from public, anon;
grant execute on function fabrik_task.save_relation_type(text,text,text,boolean), fabrik_task.require_administrator(), fabrik_task.relation_record(text) to authenticated;
revoke all on function fabrik.fabrik_get_reference(text),
 fabrik.fabrik_save_term(text,text,text,text,text[],text,text,boolean),
 fabrik.fabrik_save_dictionary(text,text,text,jsonb,text,boolean),
 fabrik.fabrik_save_relation_type(text,text,text,boolean), fabrik.fabrik_list_relation_types() from public, anon;
grant execute on function fabrik.fabrik_get_reference(text),
 fabrik.fabrik_save_term(text,text,text,text,text[],text,text,boolean),
 fabrik.fabrik_save_dictionary(text,text,text,jsonb,text,boolean),
 fabrik.fabrik_save_relation_type(text,text,text,boolean), fabrik.fabrik_list_relation_types() to authenticated;
notify pgrst, 'reload schema';
-- ===================================================================
-- 8e. Moving records.
-- ===================================================================
-- A person who is an administrator moves a set of records to another scope. Versions and links
-- take their scope from the record, so the move changes each record's scope and nothing else.
-- Each record moved from one scope to another: who moved it, when, why, and who lost and who
-- gained read access to it. Append-only, written only by fabrik_private.move_records.
set role fabrik_owner;
create table if not exists fabrik.record_move (
 move_id uuid primary key default gen_random_uuid(),
 request_id uuid not null,
 record_id uuid not null references fabrik.record(record_id),
 kind text not null,
 from_scope_id uuid not null,
 to_scope_id uuid not null,
 executor_actor_id uuid not null references fabrik.actor(actor_id),
 reason text not null check (length(btrim(reason)) between 1 and 4000),
 moved_at timestamptz not null default clock_timestamp(),
 losing_access jsonb not null check (jsonb_typeof(losing_access)='array'),
 gaining_access jsonb not null check (jsonb_typeof(gaining_access)='array'),
 unique (request_id,record_id),
 check (from_scope_id<>to_scope_id)
);
create index if not exists record_move_record_idx on fabrik.record_move(record_id);
create index if not exists record_move_from_idx on fabrik.record_move(from_scope_id);
create index if not exists record_move_to_idx on fabrik.record_move(to_scope_id);
create index if not exists record_move_executor_idx on fabrik.record_move(executor_actor_id);
create index if not exists record_move_time_idx on fabrik.record_move(moved_at desc);
alter table fabrik.record_move enable row level security;
revoke all on fabrik.record_move from public;
grant select on fabrik.record_move to fabrik_identity, fabrik_writer, fabrik_reader;
-- The move refuses a record that holds a glossary term or a record kind of the data dictionary.
grant select on fabrik.glossary_term, fabrik.dictionary_table to fabrik_identity;
drop policy if exists glossary_term_identity_read on fabrik.glossary_term;
create policy glossary_term_identity_read on fabrik.glossary_term for select to fabrik_identity using (true);
drop policy if exists dictionary_table_identity_read on fabrik.dictionary_table;
create policy dictionary_table_identity_read on fabrik.dictionary_table for select to fabrik_identity using (true);
reset role;

grant create on schema fabrik_private to fabrik_identity;
grant create on schema fabrik to fabrik_writer, fabrik_reader;

set role fabrik_identity;
-- The records a move in this transaction is moving; set only by fabrik_private.move_records.
create or replace function fabrik_private.moving_records() returns uuid[]
language sql stable set search_path=pg_catalog as $$
 select coalesce(nullif(current_setting('fabrik.moving_records',true),'')::uuid[],array[]::uuid[])
$$;

-- The scope named by its id, then its code, then its name, in any case, among every scope.
create or replace function fabrik_private.named_scope(p_scope text) returns fabrik.scope
language plpgsql stable security definer set search_path=pg_catalog as $$
declare s text:=lower(btrim(coalesce(p_scope,''))); k text; n integer; sc fabrik.scope;
begin
 foreach k in array array['scope_id','code','display_name'] loop
  select count(*) into n from fabrik.scope x where lower(to_jsonb(x)->>k)=s;
  if n=1 then select * into sc from fabrik.scope x where lower(to_jsonb(x)->>k)=s; return sc; end if;
  if n>1 then
   raise exception 'More than one scope has the name "%": %',p_scope,(select string_agg(format('%s (code %s, id %s)',x.display_name,x.code,x.scope_id),'; ' order by x.code)
    from fabrik.scope x where lower(to_jsonb(x)->>k)=s) using errcode='22023';
  end if;
 end loop;
 raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
end $$;

-- The record named by its id, or by the exact title of its latest version in any case, among every
-- record that is not deleted.
create or replace function fabrik_private.named_record(p_record text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); hits uuid[];
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  if not exists(select 1 from fabrik.record where record_id=t::uuid) then raise exception 'Record unavailable: no record has the id %',t using errcode='42501'; end if;
  return t::uuid;
 end if;
 select array_agg(r.record_id order by r.record_id) into hits from fabrik.record r
  cross join lateral (select v.title from fabrik.record_version v where v.record_id=r.record_id order by v.change_no desc limit 1) lv
  where r.deleted_at is null and lower(btrim(lv.title))=lower(t);
 if cardinality(hits)=1 then return hits[1]; end if;
 if hits is null then raise exception 'Record unavailable: no record has the title "%"',t using errcode='42501'; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, id %s)',t,s.display_name,r.record_id),'; ' order by r.record_id)
   from fabrik.record r join fabrik.scope s using(scope_id) where r.record_id=any(hits)) using errcode='22023';
end $$;

-- What a move of p_records to p_to would do: the records, their scope, each link between one of
-- them and a record outside them, each record the move refuses and why, and each enabled actor
-- who would lose or gain read access to them. Every list is sorted, so two answers compare equal.
create or replace function fabrik_private.move_facts(p_records uuid[], p_to uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 with recs as (
  select r.record_id,r.kind,r.scope_id,r.deleted_at,
   (select v.title from fabrik.record_version v where v.record_id=r.record_id order by v.change_no desc limit 1) title
  from fabrik.record r where r.record_id=any(p_records)),
 mine as (select v.version_id,v.record_id from fabrik.record_version v where v.record_id in (select record_id from recs)),
 outside as (
  select distinct m.record_id,ov.record_id linked_record_id,l.relation,
   case when l.source_version_id=m.version_id then 'links_to' else 'linked_from' end direction
  from mine m join fabrik.version_link l on m.version_id in (l.source_version_id,l.target_version_id)
  join fabrik.record_version ov on ov.version_id=case when l.source_version_id=m.version_id then l.target_version_id else l.source_version_id end
  where ov.record_id not in (select record_id from recs)),
 refused as (
  select record_id,'The record was deleted' reason from recs where deleted_at is not null
  union all
  select record_id,'The record holds a glossary term or a record kind of the data dictionary' from recs
   where exists(select 1 from fabrik.glossary_term g where g.record_id=recs.record_id) or exists(select 1 from fabrik.dictionary_table d where d.record_id=recs.record_id)
  union all
  select record_id,'A live grant or an unused approval names the record: '||string_agg(z.authorisation_id::text,', ' order by z.authorisation_id)
  from recs join fabrik.authorisation z using(record_id)
  where z.revoked_at is null and (z.expires_at is null or z.expires_at>clock_timestamp())
   and z.consumed_version_id is null and z.consumed_deletion_id is null
  group by record_id),
 access as (
  select a.actor_id,a.display_name,r.record_id,
   fabrik_private.scope_read_for(a.actor_id,r.scope_id,r.kind,r.record_id) before,
   fabrik_private.scope_read_for(a.actor_id,p_to,r.kind,r.record_id) after
  from fabrik.actor a cross join recs r where a.enabled)
 select jsonb_build_object(
  'from_scope_id',case when (select count(distinct scope_id) from recs)=1 then (select min(scope_id::text) from recs)::uuid end,
  'from_scope_name',case when (select count(distinct scope_id) from recs)=1 then fabrik_private.scope_name((select min(scope_id::text) from recs)::uuid) end,
  'to_scope_name',fabrik_private.scope_name(p_to),
  'records',coalesce((select jsonb_agg(jsonb_build_object('record_id',record_id,'kind',kind,'title',title) order by record_id) from recs),'[]'::jsonb),
  'outside_links',coalesce((select jsonb_agg(jsonb_build_object('record_id',o.record_id,'linked_record_id',o.linked_record_id,
     'linked_title',(select v.title from fabrik.record_version v where v.record_id=o.linked_record_id order by v.change_no desc limit 1),
     'linked_scope_name',(select fabrik_private.scope_name(x.scope_id) from fabrik.record x where x.record_id=o.linked_record_id),
     'relation',o.relation,'direction',o.direction) order by o.record_id,o.linked_record_id,o.relation,o.direction) from outside o),'[]'::jsonb),
  'refused',coalesce((select jsonb_agg(jsonb_build_object('record_id',record_id,'reason',reason) order by record_id,reason) from refused),'[]'::jsonb),
  'losing_access',coalesce((select jsonb_agg(x order by x->>'actor_id') from (select jsonb_build_object('actor_id',actor_id,'name',display_name,
     'record_ids',jsonb_agg(record_id order by record_id)) x from access where before and not after group by actor_id,display_name) q),'[]'::jsonb),
  'gaining_access',coalesce((select jsonb_agg(x order by x->>'actor_id') from (select jsonb_build_object('actor_id',actor_id,'name',display_name,
     'record_ids',jsonb_agg(record_id order by record_id)) x from access where after and not before group by actor_id,display_name) q),'[]'::jsonb))
$$;

-- A move's result, from its log rows.
create or replace function fabrik_private.move_result(p_request_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('request_id',p_request_id,'from_scope_id',min(m.from_scope_id::text)::uuid,'to_scope_id',min(m.to_scope_id::text)::uuid,
  'from_scope_name',fabrik_private.scope_name(min(m.from_scope_id::text)::uuid),'to_scope_name',fabrik_private.scope_name(min(m.to_scope_id::text)::uuid),
  'moved_at',min(m.moved_at),'moved_by',fabrik_private.actor_name(min(m.executor_actor_id::text)::uuid),'reason',min(m.reason),
  'records',jsonb_agg(jsonb_build_object('record_id',m.record_id,'kind',m.kind,'move_id',m.move_id) order by m.record_id))
 from fabrik.record_move m where m.request_id=p_request_id
$$;
reset role;
revoke all on function fabrik_private.moving_records(), fabrik_private.named_scope(text), fabrik_private.named_record(text),
 fabrik_private.move_facts(uuid[],uuid), fabrik_private.move_result(uuid) from public, anon, authenticated;
grant execute on function fabrik_private.moving_records(), fabrik_private.named_scope(text), fabrik_private.named_record(text),
 fabrik_private.move_facts(uuid[],uuid), fabrik_private.move_result(uuid) to fabrik_owner, fabrik_writer, fabrik_reader;

set role fabrik_owner;
-- The move log takes a row only from move_records, for a record it is moving.
create or replace function fabrik_private.guard_record_move() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' and current_user='fabrik_owner' and new.record_id=any(fabrik_private.moving_records()) then return new; end if;
 raise exception 'Record moves are append-only; use fabrik_move_records' using errcode='23514';
end $$;
drop trigger if exists record_move_guard on fabrik.record_move;
create trigger record_move_guard before insert or update or delete on fabrik.record_move
 for each row execute function fabrik_private.guard_record_move();
drop trigger if exists record_move_immutable on fabrik.record_move;
create trigger record_move_immutable before truncate on fabrik.record_move
 for each statement execute function fabrik_private.guard_record_move();

drop policy if exists record_move_identity_read on fabrik.record_move;
create policy record_move_identity_read on fabrik.record_move for select to fabrik_identity using (true);
drop policy if exists record_move_writer_read on fabrik.record_move;
create policy record_move_writer_read on fabrik.record_move for select to fabrik_writer using (true);
drop policy if exists record_move_reader_read on fabrik.record_move;
create policy record_move_reader_read on fabrik.record_move for select to fabrik_reader
 using (fabrik_private.scope_read_for((select (fabrik_private.current_actor()).actor_id),from_scope_id,kind,record_id)
  or fabrik_private.scope_read_for((select (fabrik_private.current_actor()).actor_id),to_scope_id,kind,record_id));

-- Moves each record in p_request to its new scope and logs each move. fabrik_move_records calls it
-- after every check.
create or replace function fabrik_private.move_records(p_request jsonb, p_executor uuid, p_facts jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare ids uuid[]:=array(select (x->>'record_id')::uuid from jsonb_array_elements(p_request->'records') x order by 1);
 to_scope uuid:=(p_request->>'to_scope_id')::uuid; rid uuid;
begin
 perform 1 from fabrik.record where record_id=any(ids) for update;
 perform set_config('fabrik.moving_records',ids::text,true);
 insert into fabrik.record_move(request_id,record_id,kind,from_scope_id,to_scope_id,executor_actor_id,reason,losing_access,gaining_access)
 select (p_request->>'request_id')::uuid,r.record_id,r.kind,r.scope_id,to_scope,p_executor,p_request->>'reason',
  coalesce((select jsonb_agg(jsonb_build_object('actor_id',x->'actor_id','name',x->'name') order by x->>'actor_id')
   from jsonb_array_elements(p_facts->'losing_access') x where x->'record_ids' ? r.record_id::text),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('actor_id',x->'actor_id','name',x->'name') order by x->>'actor_id')
   from jsonb_array_elements(p_facts->'gaining_access') x where x->'record_ids' ? r.record_id::text),'[]'::jsonb)
 from fabrik.record r where r.record_id=any(ids);
 update fabrik.record set scope_id=to_scope where record_id=any(ids);
 perform set_config('fabrik.moving_records','',true);
 return fabrik_private.move_result((p_request->>'request_id')::uuid);
end $$;
reset role;
revoke all on function fabrik_private.guard_record_move(), fabrik_private.move_records(jsonb,uuid,jsonb) from public, anon, authenticated;
grant execute on function fabrik_private.move_records(jsonb,uuid,jsonb) to fabrik_writer;

set role fabrik_reader;
-- What moving the named records to the named scope would do, as the request fabrik_move_records takes.
-- Only a person who is an administrator previews a move.
create or replace function fabrik.fabrik_preview_move(p_records text[], p_to_scope text, p_reason text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor:=fabrik_private.read_actor(); ids uuid[]; t text; sc fabrik.scope; f jsonb;
begin
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator moves records' using errcode='42501';
 end if;
 if p_records is null or cardinality(p_records)=0 then raise exception 'Name the records to move' using errcode='22023'; end if;
 foreach t in array p_records loop ids:=ids||fabrik_private.named_record(t); end loop;
 ids:=array(select distinct x from unnest(ids) x order by 1);
 sc:=fabrik_private.named_scope(p_to_scope);
 if not sc.enabled then raise exception 'Scope unavailable: % is disabled',sc.display_name using errcode='42501'; end if;
 f:=fabrik_private.move_facts(ids,sc.scope_id);
 if f->'from_scope_id'='null'::jsonb then
  raise exception 'Every record in a move is in the same scope. These are in %',(select string_agg(distinct fabrik_private.scope_name(r.scope_id),', ')
   from fabrik.record r where r.record_id=any(ids)) using errcode='22023';
 end if;
 if (f->>'from_scope_id')::uuid=sc.scope_id then raise exception 'The records are already in %',sc.display_name using errcode='22023'; end if;
 return jsonb_build_object('operation','move','request_id',gen_random_uuid(),'from_scope_id',f->'from_scope_id','from_scope_name',f->'from_scope_name',
  'to_scope_id',sc.scope_id,'to_scope_name',f->'to_scope_name','records',f->'records','reason',p_reason,
  'outside_links',f->'outside_links','refused',f->'refused','losing_access',f->'losing_access','gaining_access',f->'gaining_access');
end $$;
reset role;

set role fabrik_writer;
-- Moves the records in a request from fabrik_preview_move, unchanged but for its reason. Refused when
-- anything the preview showed has changed.
create or replace function fabrik.fabrik_move_records(p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; f jsonb; ids uuid[]; to_scope fabrik.scope; k text; m fabrik.record_move;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator moves records' using errcode='42501';
 end if;
 perform fabrik_private.require_object(p_request,array['operation','request_id','from_scope_id','from_scope_name','to_scope_id','to_scope_name',
  'records','reason','outside_links','refused','losing_access','gaining_access']);
 if p_request->>'operation' is distinct from 'move' then raise exception 'A move request has operation move' using errcode='22023'; end if;
 foreach k in array array['request_id','from_scope_id','to_scope_id'] loop
  perform fabrik_private.require_text(p_request,k,false,36,true); perform (p_request->>k)::uuid;
 end loop;
 perform fabrik_private.require_array(p_request,'records',10000);
 ids:=array(select (x->>'record_id')::uuid from jsonb_array_elements(p_request->'records') x order by 1);
 select * into m from fabrik.record_move where request_id=(p_request->>'request_id')::uuid limit 1;
 if found then
  if m.executor_actor_id<>a.actor_id or ids is distinct from array(select record_id from fabrik.record_move where request_id=m.request_id order by 1) then
   raise exception 'Move retry unavailable or different' using errcode='42501';
  end if;
  return fabrik_private.move_result(m.request_id);
 end if;
 if jsonb_typeof(p_request->'reason') is distinct from 'string' or btrim(p_request->>'reason')='' then
  raise exception 'Give the reason for the move, as p_reason when previewing it' using errcode='22023';
 end if;
 perform fabrik_private.require_text(p_request,'reason',false,4000,true);
 if cardinality(ids)=0 then raise exception 'Name the records to move' using errcode='22023'; end if;
 select * into to_scope from fabrik.scope where scope_id=(p_request->>'to_scope_id')::uuid and enabled;
 if not found then raise exception 'Scope unavailable' using errcode='42501'; end if;
 -- The records wait for the saves under way on them and on records linking to them, and hold off new ones.
 perform fabrik_private.hold_records(ids,true);
 f:=fabrik_private.move_facts(ids,to_scope.scope_id);
 if f->'from_scope_id' is distinct from p_request->'from_scope_id' or f->'records' is distinct from p_request->'records'
  or f->'outside_links' is distinct from p_request->'outside_links' or f->'refused' is distinct from p_request->'refused'
  or f->'losing_access' is distinct from p_request->'losing_access' or f->'gaining_access' is distinct from p_request->'gaining_access' then
  raise exception 'The move has changed; preview it again' using errcode='23514';
 end if;
 if (f->>'from_scope_id')::uuid=to_scope.scope_id then raise exception 'The records are already in %',to_scope.display_name using errcode='22023'; end if;
 if jsonb_array_length(f->'outside_links')>0 then
  raise exception 'A record outside the move links to or from one in it. Add it to the move, or save a version without the link' using errcode='23514';
 end if;
 if jsonb_array_length(f->'refused')>0 then raise exception 'The preview refuses the move: %',f->'refused' using errcode='23514'; end if;
 return fabrik_private.move_records(p_request,a.actor_id,f);
end $$;
reset role;

revoke create on schema fabrik_private from fabrik_identity;
revoke create on schema fabrik from fabrik_writer, fabrik_reader;
revoke all on function fabrik.fabrik_preview_move(text[],text,text), fabrik.fabrik_move_records(jsonb) from public, anon;
grant execute on function fabrik.fabrik_preview_move(text[],text,text), fabrik.fabrik_move_records(jsonb) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8f. Renaming a scope.
-- ===================================================================
-- A person who is an administrator changes a scope's name or description. Its id, code and
-- bucket stay the same, and its records, grants and files stay with it.
-- Each change to a scope's name or description: the old and new value, who changed it, when and
-- why. One row for each field changed. Append-only, written only by fabrik_private.rename_scope.
set role fabrik_owner;
create table if not exists fabrik.scope_change (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 scope_id uuid not null,
 field text not null check (field in ('display_name','description')),
 old_value text not null,
 new_value text not null,
 changed_by_actor_id uuid not null references fabrik.actor(actor_id),
 reason text not null check (length(btrim(reason)) between 1 and 4000),
 check (old_value<>new_value)
);
create index if not exists scope_change_scope_idx on fabrik.scope_change(scope_id);
create index if not exists scope_change_actor_idx on fabrik.scope_change(changed_by_actor_id);
create index if not exists scope_change_time_idx on fabrik.scope_change(at desc);
alter table fabrik.scope_change enable row level security;
revoke all on fabrik.scope_change from public;
grant select on fabrik.scope_change to fabrik_identity, fabrik_writer, fabrik_reader;

-- The scope a rename in this transaction is changing; set only by fabrik_private.rename_scope.
create or replace function fabrik_private.renaming_scope() returns uuid
language sql stable set search_path=pg_catalog as $$
 select nullif(current_setting('fabrik.renaming_scope',true),'')::uuid
$$;

-- The scope change log takes a row only from rename_scope, for the scope it is renaming.
create or replace function fabrik_private.guard_scope_change() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' and current_user='fabrik_owner' and new.scope_id=fabrik_private.renaming_scope() then return new; end if;
 raise exception 'Scope changes are append-only; use fabrik_rename_scope' using errcode='23514';
end $$;
drop trigger if exists scope_change_guard on fabrik.scope_change;
create trigger scope_change_guard before insert or update or delete on fabrik.scope_change
 for each row execute function fabrik_private.guard_scope_change();
drop trigger if exists scope_change_immutable on fabrik.scope_change;
create trigger scope_change_immutable before truncate on fabrik.scope_change
 for each statement execute function fabrik_private.guard_scope_change();

drop policy if exists scope_change_identity_read on fabrik.scope_change;
create policy scope_change_identity_read on fabrik.scope_change for select to fabrik_identity using (true);
drop policy if exists scope_change_writer_read on fabrik.scope_change;
create policy scope_change_writer_read on fabrik.scope_change for select to fabrik_writer using (true);
drop policy if exists scope_change_reader_read on fabrik.scope_change;
create policy scope_change_reader_read on fabrik.scope_change for select to fabrik_reader
 using (fabrik_private.scope_read_for((select (fabrik_private.current_actor()).actor_id),scope_id,null,null));

-- Changes the scope's name, its description, or both, and logs each field changed.
-- fabrik_rename_scope calls it after every check. A null leaves that field as it is.
create or replace function fabrik_private.rename_scope(p_scope uuid, p_display_name text, p_description text, p_executor uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare o fabrik.scope; n fabrik.scope;
begin
 select * into o from fabrik.scope where scope_id=p_scope for update;
 perform set_config('fabrik.renaming_scope',p_scope::text,true);
 update fabrik.scope set display_name=coalesce(p_display_name,display_name),description=coalesce(p_description,description)
  where scope_id=p_scope returning * into n;
 insert into fabrik.scope_change(scope_id,field,old_value,new_value,changed_by_actor_id,reason)
 select p_scope,f.field,f.old_value,f.new_value,p_executor,p_reason
 from (values ('display_name',o.display_name,n.display_name),('description',o.description,n.description)) f(field,old_value,new_value)
 where f.old_value<>f.new_value;
 perform set_config('fabrik.renaming_scope','',true);
 return jsonb_build_object('scope_id',n.scope_id,'code',n.code,'old_name',o.display_name,'name',n.display_name,
  'old_description',o.description,'description',n.description,'changed_at',clock_timestamp(),
  'changed_by',fabrik_private.actor_name(p_executor),'reason',p_reason);
end $$;
reset role;
revoke all on function fabrik_private.renaming_scope(), fabrik_private.guard_scope_change(),
 fabrik_private.rename_scope(uuid,text,text,uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.renaming_scope() to fabrik_writer, fabrik_reader;
grant execute on function fabrik_private.rename_scope(uuid,text,text,uuid,text) to fabrik_writer;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
-- Changes a scope's name, its description, or both. The scope is named by its id, code or name.
-- Its id, code and files stay the same. Only a person who is an administrator renames a scope.
create or replace function fabrik.fabrik_rename_scope(p_scope text, p_display_name text default null, p_description text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; sc fabrik.scope; n text:=nullif(btrim(coalesce(p_display_name,'')),''); d text:=nullif(btrim(coalesce(p_description,'')),'');
 clash fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator renames a scope' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the change, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 sc:=fabrik_private.named_scope(p_scope);
 if n is null and d is null then raise exception 'Give the new name, as p_display_name, or the new description, as p_description' using errcode='22023'; end if;
 if length(n)>200 then raise exception 'A scope''s name is at most 200 characters' using errcode='22023'; end if;
 if length(d)>4000 then raise exception 'A scope''s description is at most 4000 characters' using errcode='22023'; end if;
 if n=sc.display_name then n:=null; end if;
 if d=sc.description then d:=null; end if;
 if n is null and d is null then raise exception 'The scope % already has that name and description',sc.display_name using errcode='22023'; end if;
 select * into clash from fabrik.scope x where x.scope_id<>sc.scope_id and lower(n) in (lower(btrim(x.display_name)),lower(x.code)) limit 1;
 if found then
  raise exception 'Another scope has the name or code "%": % (code %)',n,clash.display_name,clash.code using errcode='23505';
 end if;
 return fabrik_private.rename_scope(sc.scope_id,n,d,a.actor_id,btrim(p_reason));
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_rename_scope(text,text,text,text) from public, anon;
grant execute on function fabrik.fabrik_rename_scope(text,text,text,text) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8g. Deleting an empty scope.
-- ===================================================================
-- A person who is an administrator deletes a scope that holds no record and no file. Its grants and
-- bucket go with it. The history of its files, moves and renames stays, without a link to the scope,
-- and a version saved under one of its grants keeps that grant's id.
-- Each deleted scope: its id, code, name and description, a summary of the grants deleted with it,
-- who deleted it, when and why. Append-only, written only by fabrik_private.delete_scope.
set role fabrik_owner;
create table if not exists fabrik.scope_deletion (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 scope_id uuid not null,
 code text not null,
 display_name text not null,
 description text not null,
 grants_removed jsonb not null check (jsonb_typeof(grants_removed)='array'),
 deleted_by_actor_id uuid not null references fabrik.actor(actor_id),
 reason text not null check (length(btrim(reason)) between 1 and 4000)
);
create index if not exists scope_deletion_actor_idx on fabrik.scope_deletion(deleted_by_actor_id);
create index if not exists scope_deletion_time_idx on fabrik.scope_deletion(at desc);
alter table fabrik.scope_deletion enable row level security;
revoke all on fabrik.scope_deletion from public;
grant select on fabrik.scope_deletion to fabrik_identity, fabrik_writer, fabrik_reader;

-- The scope a deletion in this transaction is deleting; set only by fabrik_private.delete_scope.
create or replace function fabrik_private.deleting_scope() returns uuid
language sql stable set search_path=pg_catalog as $$
 select nullif(current_setting('fabrik.deleting_scope',true),'')::uuid
$$;

-- The scope deletion log takes a row only from delete_scope, for the scope it is deleting.
create or replace function fabrik_private.guard_scope_deletion() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' and current_user='fabrik_owner' and new.scope_id=fabrik_private.deleting_scope() then return new; end if;
 raise exception 'Scope deletions are append-only; use fabrik_delete_scope' using errcode='23514';
end $$;
drop trigger if exists scope_deletion_guard on fabrik.scope_deletion;
create trigger scope_deletion_guard before insert or update or delete on fabrik.scope_deletion
 for each row execute function fabrik_private.guard_scope_deletion();
drop trigger if exists scope_deletion_immutable on fabrik.scope_deletion;
create trigger scope_deletion_immutable before truncate on fabrik.scope_deletion
 for each statement execute function fabrik_private.guard_scope_deletion();

drop policy if exists scope_deletion_identity_read on fabrik.scope_deletion;
create policy scope_deletion_identity_read on fabrik.scope_deletion for select to fabrik_identity using (true);
drop policy if exists scope_deletion_writer_read on fabrik.scope_deletion;
create policy scope_deletion_writer_read on fabrik.scope_deletion for select to fabrik_writer using (true);
drop policy if exists scope_deletion_reader_read on fabrik.scope_deletion;
create policy scope_deletion_reader_read on fabrik.scope_deletion for select to fabrik_reader
 using ((select (fabrik_private.current_actor()).authority_class)='administrator');
reset role;

-- Deletes the empty bucket of a deleted scope. Owned by postgres, which may write storage.buckets;
-- fabrik_owner may not. Storage refuses a direct delete unless storage.allow_delete_query is true.
create or replace function fabrik_storage.delete_scope_bucket(p_code text) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare n bigint;
begin
 select count(*) into n from storage.objects where bucket_id=p_code;
 if n>0 then raise exception 'The scope holds % files; delete them first',n using errcode='23503'; end if;
 perform set_config('storage.allow_delete_query','true',true);
 delete from storage.buckets where id=p_code;
 perform set_config('storage.allow_delete_query','false',true);
end $$;
revoke all on function fabrik_storage.delete_scope_bucket(text) from public, anon, authenticated;
grant execute on function fabrik_storage.delete_scope_bucket(text) to fabrik_owner;

set role fabrik_owner;
-- Deletes an empty scope, its grants and its bucket, and logs it. fabrik_delete_scope calls it after
-- every check except the scope's emptiness, which it checks here under the scope's lock.
create or replace function fabrik_private.delete_scope(p_scope uuid, p_executor uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare s fabrik.scope; n bigint; k bigint; g jsonb;
begin
 select * into s from fabrik.scope where scope_id=p_scope for update;
 select count(*), count(*) filter (where deleted_at is not null) into n, k from fabrik.record where scope_id=p_scope;
 if n>0 then
  raise exception 'The scope % holds % records, % of them deleted; a scope is deleted only when it holds none',s.display_name,n,k using errcode='23503';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('authorisation_id',z.authorisation_id,'mode',z.mode,
   'executor',fabrik_private.actor_name(z.executor_actor_id),'accountable_human',fabrik_private.actor_name(z.accountable_human_id),
   'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds,'issued_at',z.issued_at,'revoked_at',z.revoked_at) order by z.issued_at,z.authorisation_id),'[]'::jsonb)
  into g from fabrik.authorisation z where z.scope_id=p_scope;
 perform set_config('fabrik.deleting_scope',p_scope::text,true);
 insert into fabrik.scope_deletion(scope_id,code,display_name,description,grants_removed,deleted_by_actor_id,reason)
 values (s.scope_id,s.code,s.display_name,s.description,g,p_executor,p_reason);
 delete from fabrik.authorisation where scope_id=p_scope;
 perform fabrik_storage.delete_scope_bucket(s.code);
 delete from fabrik.scope where scope_id=p_scope;
 perform set_config('fabrik.deleting_scope','',true);
 return jsonb_build_object('scope_id',s.scope_id,'code',s.code,'name',s.display_name,'description',s.description,
  'grants_removed',jsonb_array_length(g),'deleted_at',clock_timestamp(),
  'deleted_by',fabrik_private.actor_name(p_executor),'reason',p_reason);
end $$;
reset role;
revoke all on function fabrik_private.deleting_scope(), fabrik_private.guard_scope_deletion(),
 fabrik_private.delete_scope(uuid,uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.deleting_scope() to fabrik_writer, fabrik_reader;
grant execute on function fabrik_private.delete_scope(uuid,uuid,text) to fabrik_writer;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
-- Deletes a scope that holds no record and no file, with its grants and bucket. The scope is named
-- by its id, code or name. Only a person who is an administrator deletes a scope.
create or replace function fabrik.fabrik_delete_scope(p_scope text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; sc fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator deletes a scope' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the deletion, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 sc:=fabrik_private.named_scope(p_scope);
 if sc.code in ('general','routines','reference','administration') then
  raise exception 'The scope % is part of fabrik''s setup and is not deleted',sc.display_name using errcode='42501';
 end if;
 return fabrik_private.delete_scope(sc.scope_id,a.actor_id,btrim(p_reason));
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_delete_scope(text,text) from public, anon;
grant execute on function fabrik.fabrik_delete_scope(text,text) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8n. Activity owners.
-- ===================================================================
-- Every activity has one owner, the person accountable for it: an enabled person who can read
-- activities in its scope. A save names the owner by actor id, and fabrik writes the owner's name.
grant create on schema fabrik_private to fabrik_identity;
set role fabrik_identity;
-- Whether p_owner may own the activity p_record in p_scope: an enabled person who can read it. A
-- record not saved yet will be the saver's own, so a person whose read covers only their own
-- records may own it when they answer for the saver.
create or replace function fabrik_private.owner_ok(p_owner uuid, p_scope uuid, p_record uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select p_owner is not null
  and exists(select 1 from fabrik.actor x where x.actor_id=p_owner and x.actor_kind='human' and x.enabled)
  and (fabrik_private.scope_read_for(p_owner,p_scope,'activity',p_record)
   or (not exists(select 1 from fabrik.record r where r.record_id=p_record)
    and p_owner=(fabrik_private.current_actor()).accountable_human_id
    and exists(select 1 from fabrik.scope s join fabrik.authorisation z on z.scope_id=s.scope_id
     where s.scope_id=p_scope and s.enabled and z.executor_actor_id=p_owner and z.own_records and z.mode='standing_permission'
      and 'read'=any(z.allowed_actions) and 'activity'=any(z.record_kinds) and fabrik_private.authority_live(z.authorisation_id))))
$$;
-- A save request with its activity's owner_label set to the owner's name. A save hashes the request
-- as sent, and stores the payload with this name.
create or replace function fabrik_private.with_owner_label(p jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if p->>'kind' is distinct from 'activity' or jsonb_typeof(p->'payload') is distinct from 'object' then
  return p;
 end if;
 if coalesce(p->'payload'->>'owner_actor_id','') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
  p:=jsonb_set(p,'{payload,owner_label}',to_jsonb(fabrik_private.actor_name((p->'payload'->>'owner_actor_id')::uuid)));
 end if;
 return p;
end $$;
revoke all on function fabrik_private.owner_ok(uuid,uuid,uuid), fabrik_private.with_owner_label(jsonb) from public, anon, authenticated;
grant execute on function fabrik_private.owner_ok(uuid,uuid,uuid), fabrik_private.with_owner_label(jsonb) to fabrik_owner, fabrik_writer, fabrik_reader;
reset role;
revoke create on schema fabrik_private from fabrik_identity;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- The activities in a scope the caller may read whose latest version has no owner, or an owner who
-- is not an enabled person who can read activities in the scope. An actor who cannot read the
-- scope gets none.
create or replace function fabrik.fabrik_find_unowned(p_scope_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if p_scope_id is null or not fabrik_private.can_read_scope(p_scope_id) then return jsonb_build_object('items','[]'::jsonb); end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('record_id',l.record_id,'index',l.payload->>'index','title',l.title,
   'activity_kind',l.payload->>'activity_kind','owner_actor_id',l.payload->>'owner_actor_id','owner_label',l.payload->>'owner_label')
   order by l.payload->>'index' nulls last,l.title,l.record_id)
  from (select distinct on(v.record_id) v.* from fabrik.record_version v join fabrik.record r using(record_id)
   where r.kind='activity' and r.scope_id=p_scope_id and r.deleted_at is null and r.record_id in (select fabrik_private.readable_records())
   order by v.record_id,v.change_no desc) l
  where not fabrik_private.owner_ok(case when coalesce(l.payload->>'owner_actor_id','') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (l.payload->>'owner_actor_id')::uuid end,
   p_scope_id,l.record_id)),'[]'::jsonb));
end $$;

-- An activity's owner, found by words of their name among the people who can read its scope.
create or replace function fabrik.fabrik_set_owner(p_record text, p_person text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); r jsonb:=fabrik_task.latest(rid); s uuid:=(r->'version'->>'scope_id')::uuid; people jsonb; who jsonb;
begin
 if fabrik_task.kind(r->'version'->'payload') is distinct from 'activity' then raise exception 'Only an activity has an owner' using errcode='22023'; end if;
 if btrim(coalesce(p_person,''))='' then raise exception 'Name the person who owns the activity' using errcode='22023'; end if;
 people:=fabrik.fabrik_find_people(s,p_person)->'items';
 if jsonb_array_length(people)>1 then
  select coalesce(jsonb_agg(x),'[]'::jsonb) into who from jsonb_array_elements(people) x where lower(x->>'display_name')=lower(btrim(p_person));
  if jsonb_array_length(who)=1 then people:=who; end if;
 end if;
 if jsonb_array_length(people)=0 then
  raise exception 'No person who can read % has a name with "%". An administrator can give them read in the scope',fabrik_task.scope_name(s),p_person using errcode='22023';
 end if;
 if jsonb_array_length(people)>1 then
  raise exception 'More than one person fits "%": %',p_person,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
 end if;
 return fabrik_task.change(rid,p_reason,jsonb_build_object('owner_actor_id',people->0->'actor_id'),null,null,p_preview);
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_find_unowned(uuid), fabrik.fabrik_set_owner(text,text,text,boolean) from public, anon;
grant execute on function fabrik.fabrik_find_unowned(uuid), fabrik.fabrik_set_owner(text,text,text,boolean) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8p. Graph retrieval in file search.
-- ===================================================================
-- The graph's entity types are the glossary's classes, and its relation names the glossary's
-- relationships, so each fact links up under one name.
-- The chunks of a scope's files whose graph no agent has saved yet, for the caller's agent to read
-- and extract, with the glossary's classes and relationships to extract them with. Needs read in
-- the scope. Owned by postgres, which owns file search: the scope's bucket is checked here with
-- fabrik's storage rules, and file search lists its chunks.
create or replace function fabrik.fabrik_get_unextracted(p_scope text, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare sc fabrik.scope;
begin
 perform fabrik_private.read_actor();
 begin
  sc:=fabrik_private.named_scope(p_scope);
 exception when insufficient_privilege then sc:=null;
 end;
 if sc.code is null or sc.code not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
 end if;
 if to_regprocedure('file_search.unextracted(text,integer)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 return jsonb_build_object('scope',sc.display_name,'code',sc.code,
  'classes',(select coalesce(jsonb_agg(term order by lower(term)),'[]'::jsonb) from fabrik.glossary_term where kind='class'),
  'relationships',(select coalesce(jsonb_agg(jsonb_build_object('relationship',term,'from_class',from_class,'to_class',to_class) order by lower(term)),'[]'::jsonb)
   from fabrik.glossary_term where kind='relationship'))||file_search.unextracted(sc.code,p_limit);
end $$;

-- Saves the entities and relations the caller's agent read in one chunk, once. Needs read and
-- create in the chunk's scope. Each entity's type is a glossary class, named in any case, and is
-- saved as the glossary names it. Each relation names a glossary relationship, as relationship,
-- from an entity of its from class to one of its to class, and keeps the relationship's name among
-- its keywords. Each entity merges by its normalised name and type, and the save names the caller
-- as the actor who saved it. With p_replace, the actor who saved the chunk's extraction, or an
-- administrator, replaces it.
create or replace function fabrik.fabrik_save_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb default '[]', p_replace boolean default false) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; b text; saver uuid; x jsonb; cls text; rel fabrik.glossary_term; types jsonb:='{}'::jsonb;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb; src text; tgt text;
begin
 a:=fabrik_private.current_actor();
 if to_regprocedure('file_search.save_extraction(uuid,jsonb,jsonb,uuid,text,boolean)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 select v.bucket_id into b from file_search.chunk c join file_search.file_version v on v.version_id=c.version_id where c.chunk_id=p_chunk;
 if b is null or not exists(select 1 from fabrik.scope where code=b) or b not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Chunk unavailable: no chunk with the id "%" in a scope you may read',p_chunk using errcode='42501';
 end if;
 if b not in (select fabrik_storage.usable_buckets('create')) then
  raise exception 'Saving a chunk''s entities and relations needs create permission in its scope' using errcode='42501';
 end if;
 if coalesce(p_replace,false) then
  select x.saved_by into saver from file_search.chunk_extraction x where x.chunk_id=p_chunk;
  if saver is not null and saver<>a.actor_id and a.authority_class<>'administrator' then
   raise exception 'Only the actor who saved this chunk''s entities and relations, or an administrator, may replace them: %',fabrik_private.actor_name(saver) using errcode='42501';
  end if;
 end if;
 if jsonb_typeof(coalesce(p_entities,'[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_relations,'[]'::jsonb))<>'array' then
  raise exception 'Entities and relations are each a list' using errcode='22023';
 end if;
 for x in select value from jsonb_array_elements(coalesce(p_entities,'[]'::jsonb)) loop
  cls:=(select g.term from fabrik.glossary_term g where g.kind='class' and lower(g.term)=lower(btrim(coalesce(x->>'type',''))));
  if cls is null then
   raise exception 'The entity "%" has the type "%", which is not a class in the glossary. An entity''s type is one of the classes fabrik_get_unextracted lists',
    x->>'name',coalesce(x->>'type','') using errcode='23514';
  end if;
  ents:=ents||jsonb_build_array(x||jsonb_build_object('type',cls));
  types:=types||jsonb_build_object(file_search.graph_key(x->>'name'),cls);
 end loop;
 for x in select value from jsonb_array_elements(coalesce(p_relations,'[]'::jsonb)) loop
  select g.* into rel from fabrik.glossary_term g where g.kind='relationship' and lower(g.term)=lower(btrim(coalesce(x->>'relationship','')));
  if rel.term is null then
   raise exception 'The relation from "%" to "%" names "%", which is not a relationship in the glossary. A relation names one of the relationships fabrik_get_unextracted lists',
    x->>'source',x->>'target',coalesce(x->>'relationship','') using errcode='23514';
  end if;
  src:=types->>file_search.graph_key(x->>'source'); tgt:=types->>file_search.graph_key(x->>'target');
  if src is not null and tgt is not null and (src<>rel.from_class or tgt<>rel.to_class) then
   raise exception 'The relationship "%" goes from a % to a %, and "%" is a % and "%" a %',rel.term,rel.from_class,rel.to_class,
    x->>'source',src,x->>'target',tgt using errcode='23514';
  end if;
  rels:=rels||jsonb_build_array(x||jsonb_build_object('keywords',jsonb_build_array(rel.term)||case jsonb_typeof(x->'keywords') when 'array' then x->'keywords'
   when 'string' then to_jsonb(string_to_array(x->>'keywords',',')) else '[]'::jsonb end));
 end loop;
 return file_search.save_extraction(p_chunk,ents,rels,a.actor_id,a.display_name,coalesce(p_replace,false));
end $$;
revoke all on function fabrik.fabrik_get_unextracted(text,integer), fabrik.fabrik_save_extraction(uuid,jsonb,jsonb,boolean) from public, anon;
grant execute on function fabrik.fabrik_get_unextracted(text,integer), fabrik.fabrik_save_extraction(uuid,jsonb,jsonb,boolean) to authenticated;
notify pgrst, 'reload schema';


-- ===================================================================
-- 8q. Links through a change of state.
-- ===================================================================
-- A supports link from evidence to a version of a record still counts for the record's later
-- versions whose only changes are its state, its assignee or its completion note. The completion
-- check and the progress read take it so, and an agent links evidence once.
grant create on schema fabrik_private to fabrik_identity;
set role fabrik_identity;
-- A version's payload without the fields a change of state alters, and without the owner's name,
-- which fabrik sets from the owner at each save and a rename changes.
create or replace function fabrik_private.without_state(p_payload jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select p_payload-array['state','assignee_actor_id','completion_note','owner_label']
$$;
-- Each evidence record, not deleted, whose latest version within the cutoff links supports to a
-- version of p_record with the given title and the same payload apart from its state, and that
-- version of the evidence. A null cutoff reads every change.
create or replace function fabrik_private.evidence_through_state(p_record uuid, p_title text, p_payload jsonb, p_cutoff bigint)
returns table(record_id uuid, version_id uuid)
language sql stable security definer set search_path=pg_catalog as $$
 select distinct ev.record_id,ev.version_id
 from fabrik.record_version tv
 join fabrik.version_link vl on vl.target_version_id=tv.version_id and vl.relation='supports'
 join fabrik.record_version ev on ev.version_id=vl.source_version_id
 join fabrik.record er on er.record_id=ev.record_id and er.kind='evidence' and er.deleted_at is null
 where tv.record_id=p_record and (p_cutoff is null or tv.change_no<=p_cutoff) and tv.title=p_title
  and fabrik_private.without_state(tv.payload)=fabrik_private.without_state(p_payload)
  and ev.change_no=(select max(x.change_no) from fabrik.record_version x where x.record_id=ev.record_id and (p_cutoff is null or x.change_no<=p_cutoff))
$$;
revoke all on function fabrik_private.without_state(jsonb), fabrik_private.evidence_through_state(uuid,text,jsonb,bigint) from public, anon, authenticated;
grant execute on function fabrik_private.without_state(jsonb), fabrik_private.evidence_through_state(uuid,text,jsonb,bigint) to fabrik_owner, fabrik_writer, fabrik_reader;
reset role;
revoke create on schema fabrik_private from fabrik_identity;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8r. Fast permission checks.
-- ===================================================================
-- An actor's live read grants are found once, as a set. Each read finds the actor's readable
-- records once, from them; the audit log passes its dates into that check, and a scope's
-- unowned activities their scope. A save's checks read without per-row
-- security, and still check the record and each link target against the actor's grants. Who may
-- read and save is unchanged.

-- Each standing permission an actor holds, by executor and scope.
set role fabrik_owner;
create index if not exists authorisation_standing_idx on fabrik.authorisation(executor_actor_id,scope_id)
 where mode='standing_permission' and revoked_at is null;
reset role;

grant create on schema fabrik_private to fabrik_identity;
set role fabrik_identity;
-- The actor's live read grants: each scope, with its record kinds and record, or null for every
-- one, and whether the grant is limited to the actor's own records. An administrator has every
-- scope. An actor that is not enabled, or answers to no enabled person, has none.
create or replace function fabrik_private.read_grants(p_actor uuid)
returns table(actor_id uuid, scope_id uuid, record_kinds text[], record_id uuid, own_records boolean)
language sql stable security definer set search_path=pg_catalog rows 20 as $$
 select a.actor_id,s.scope_id,null::text[],null::uuid,false
 from fabrik.actor a join fabrik.actor h on h.actor_id=a.accountable_human_id cross join fabrik.scope s
 where a.actor_id=p_actor and a.enabled and h.enabled and h.actor_kind='human' and a.authority_class='administrator'
 union all
 select a.actor_id,z.scope_id,z.record_kinds,z.record_id,z.own_records
 from fabrik.actor a join fabrik.actor h on h.actor_id=a.accountable_human_id
 join fabrik.authorisation z on z.executor_actor_id=a.actor_id and z.accountable_human_id=h.actor_id
  and z.mode='standing_permission' and z.revoked_at is null and 'read'=any(z.allowed_actions)
  and (z.expires_at is null or z.expires_at>clock_timestamp())
 join fabrik.scope s on s.scope_id=z.scope_id and s.enabled
 join fabrik.actor i on i.actor_id=z.issued_by_actor_id and i.enabled and i.authority_class='administrator'
 join fabrik.actor ih on ih.actor_id=i.accountable_human_id and ih.enabled and ih.actor_kind='human'
 where a.actor_id=p_actor and a.enabled and h.enabled and h.actor_kind='human' and a.authority_class<>'administrator'
$$;

-- The current actor's live read grants.
create or replace function fabrik_private.read_grants()
returns table(actor_id uuid, scope_id uuid, record_kinds text[], record_id uuid, own_records boolean)
language sql stable security definer set search_path=pg_catalog rows 20 as $$
 select * from fabrik_private.read_grants((fabrik_private.current_actor()).actor_id)
$$;

-- Whether the actor may read a record of the kind in the scope, or the scope as a whole when the
-- record is null. A grant limited to the actor's own records is checked against the record only.
create or replace function fabrik_private.scope_read_for(p_actor uuid, p_scope uuid, p_kind text, p_record uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik_private.read_grants(p_actor) g where g.scope_id=p_scope
  and (p_kind is null or g.record_kinds is null or p_kind=any(g.record_kinds))
  and (g.record_id is null or g.record_id=p_record)
  and case when g.own_records then p_record is not null and fabrik_private.is_own_record(p_actor,p_record) else true end)
$$;

-- Whether the current actor can read the scope as a whole. A grant limited to the actor's own
-- records does not make the scope readable as a whole.
create or replace function fabrik_private.can_read_scope(p_scope uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik_private.read_grants() g where g.scope_id=p_scope and not g.own_records)
$$;

-- Whether the current actor can see that the scope exists: any live read grant, limited or not.
create or replace function fabrik_private.can_see_scope(p_scope uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik_private.read_grants() g where g.scope_id=p_scope)
$$;

-- The records the current actor may read, as can_read_record checks each, found as a set. Each
-- argument that is not null narrows them: the scope, the kind, words that all appear in one of the
-- record's titles, in any case, and a version saved from p_from until p_to.
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

-- The records the current actor may read.
create or replace function fabrik_private.readable_records() returns setof uuid
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.readable_records(null,null,null,null,null)
$$;

-- The versions saved from p_from until p_to whose record the current actor may read, with each
-- record's kind and scope. Only the records with a version in the period are checked.
create or replace function fabrik_private.audit_versions(p_from timestamptz, p_to timestamptz)
returns table(recorded_at timestamptz, version_id uuid, record_id uuid, title text, change_reason text, executor_actor_id uuid,
 version_number integer, authorisation_id uuid, accountable_human_id uuid, kind text, scope_id uuid)
language sql stable security definer set search_path=pg_catalog as $$
 select v.recorded_at,v.version_id,v.record_id,v.title,v.change_reason,v.executor_actor_id,v.version_number,v.authorisation_id,v.accountable_human_id,r.kind,r.scope_id
 from fabrik.record_version v join fabrik.record r on r.record_id=v.record_id
 where v.recorded_at>=p_from and v.recorded_at<p_to and r.record_id in (select fabrik_private.readable_records(null,null,null,p_from,p_to))
$$;

-- The records a save request links to, read without per-row security, for hold_records.
create or replace function fabrik_private.link_targets(p_request jsonb) returns uuid[]
language sql stable security definer set search_path=pg_catalog as $$
 select array(select tv.record_id from fabrik.record_version tv
  where tv.version_id in (select (lnk->>'target_version_id')::uuid from jsonb_array_elements(p_request->'links') lnk))
$$;

-- Whether a link from p_source to p_target is in one scope and the current actor reads both
-- records. Each record is checked once.
create or replace function fabrik_private.can_link(p_source uuid,p_target uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.record_version sv join fabrik.record sr on sr.record_id=sv.record_id
  join fabrik.record_version tv on tv.version_id=p_target join fabrik.record tr on tr.record_id=tv.record_id
  where sv.version_id=p_source and sr.scope_id=tr.scope_id)
 and fabrik_private.can_read_record((select record_id from fabrik.record_version where version_id=p_source))
 and fabrik_private.can_read_record((select record_id from fabrik.record_version where version_id=p_target))
$$;

revoke all on function fabrik_private.read_grants(uuid), fabrik_private.read_grants(),
 fabrik_private.readable_records(uuid,text,text,timestamptz,timestamptz), fabrik_private.link_targets(jsonb) from public, anon, authenticated;
grant execute on function fabrik_private.read_grants(uuid), fabrik_private.read_grants() to fabrik_owner, fabrik_writer, fabrik_reader;
grant execute on function fabrik_private.readable_records(uuid,text,text,timestamptz,timestamptz) to fabrik_owner, fabrik_reader;
grant execute on function fabrik_private.link_targets(jsonb) to fabrik_writer;

reset role;

-- check_version reads as fabrik_identity and calls what validate_version calls.
grant execute on function fabrik_private.validate_shape(jsonb), fabrik_private.require_object(jsonb,text[],text[]),
 fabrik_private.require_text(jsonb,text,boolean,integer,boolean), fabrik_private.require_array(jsonb,text,integer),
 fabrik_private.iso_time(jsonb,text), fabrik_private.validate_reference(text,text),
 fabrik_private.owner_ok(uuid,uuid,uuid), fabrik_private.with_owner_label(jsonb), fabrik_private.evidence_through_state(uuid,text,jsonb,bigint) to fabrik_identity;
set role fabrik_identity;
-- A save request's checks, run as fabrik_identity, without per-row security. Each check of the
-- record and each link target against the actor's grants stays.
CREATE OR REPLACE FUNCTION fabrik_private.check_version(p jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare oldv fabrik.record_version; b jsonb:=p->'payload'; link_item jsonb; target_row record; rid uuid:=(p->>'record_id')::uuid;
 actions text[]; oldstate text; newstate text; k text; added uuid[]; problems text[];
begin
 perform fabrik_private.validate_shape(p);
 perform fabrik_private.assert_request_scope(p,(fabrik_private.current_actor()).actor_id);
 select * into oldv from fabrik.record_version where record_id=rid order by change_no desc limit 1;
 -- A save from an older version is refused before its checks. save_version checks again just before it
 -- writes, after every lock a save waits for.
 if oldv.version_id is distinct from (p->>'expected_previous_version_id')::uuid then
  raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
 end if;
 if oldv.version_id is null then
  if exists(select 1 from fabrik.record where record_id=rid) then raise exception 'Record has no saved version' using errcode='23514'; end if;
  actions:=array['create'];
 else
  if (select kind from fabrik.record where record_id=rid)<>p->>'kind' then raise exception 'Record kind is fixed' using errcode='23514'; end if;
  actions:=array['edit'];
 end if;
 if p->>'kind'='activity' then
  newstate:=b->>'state'; oldstate:=fabrik_private.activity_state(oldv.payload->>'state');
  if oldv.version_id is null and newstate<>'pending' then raise exception 'New activity starts pending' using errcode='23514'; end if;
  if oldv.version_id is not null then
   -- The baseline may change, in any state, and the version's reason says why.
   if b->>'activity_kind'<>oldv.payload->>'activity_kind' then raise exception 'Activity kind is fixed' using errcode='23514'; end if;
   if oldstate<>newstate then
    if not ((oldstate='pending' and newstate in ('in_progress','cancelled')) or (oldstate='in_progress' and newstate in ('paused','completed','cancelled')) or
      (oldstate='paused' and newstate in ('in_progress','cancelled')) or (oldstate='completed' and newstate='in_progress')) then
     raise exception 'Invalid activity state transition' using errcode='23514';
    end if;
    actions:=actions||case when newstate='in_progress' and oldstate='completed' then 'reopen' when newstate='in_progress' then 'start'
      when newstate='paused' then 'hold' when newstate='completed' then 'complete' else 'cancel' end;
   end if;
   if oldstate='completed' and b->'completion_requirements' is distinct from oldv.payload->'completion_requirements' and newstate<>'in_progress' then
    raise exception 'Changed completion requirements must reopen the activity' using errcode='23514';
   end if;
  end if;
  -- A new assignee is an enabled person who can read activities in the scope.
  if b->>'assignee_actor_id' is not null and b->'assignee_actor_id' is distinct from oldv.payload->'assignee_actor_id' and (
    not exists(select 1 from fabrik.actor x where x.actor_id=(b->>'assignee_actor_id')::uuid and x.actor_kind='human' and x.enabled)
    or not fabrik_private.scope_read_for((b->>'assignee_actor_id')::uuid,(p->>'scope_id')::uuid,'activity',rid)) then
   raise exception 'Assignee is not a person who can read this scope' using errcode='23514';
  end if;
  -- Every activity's owner is an enabled person who can read activities in the scope.
  if not fabrik_private.owner_ok((b->>'owner_actor_id')::uuid,(p->>'scope_id')::uuid,rid) then
   raise exception 'Owner is not a person who can read this scope' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_array_elements(b->'blockers') n join fabrik.record_version v on v.record_id=rid
    cross join lateral jsonb_array_elements(v.payload->'blockers') prev
    where n->>'blocker_id'=prev->>'blocker_id' and n->>'description'<>prev->>'description') then
   raise exception 'Blocker IDs cannot be reused for different descriptions' using errcode='23514';
  end if;
  -- Supporting evidence: a supports link from this version to evidence, or from evidence to a version
  -- of this record that differs from this one only in its state.
  if newstate='completed' and (length(btrim(b->>'completion_requirements'))=0 or length(btrim(b->>'completion_note'))=0 or jsonb_array_length(b->'blockers')<>0 or
    (not exists(select 1 from jsonb_array_elements(p->'links') z join fabrik.record_version v on v.version_id=(z->>'target_version_id')::uuid
      join fabrik.record r on r.record_id=v.record_id where z->>'relation'='supports' and r.kind='evidence')
     and not exists(select 1 from fabrik_private.evidence_through_state(rid,p->>'title',fabrik_private.with_owner_label(p)->'payload',null)))) then
   raise exception 'Completion requires requirements, note, no blockers and supporting evidence' using errcode='23514';
  end if;
 elsif p->>'kind'='decision' then
  if (oldv.version_id is null and b->>'decision'<>'') or (oldv.version_id is not null and b->'decision' is distinct from oldv.payload->'decision') then actions:=actions||'decide'::text; end if;
 end if;
 for link_item in select value from jsonb_array_elements(p->'links') loop
  select v.*,r.kind,r.scope_id into target_row from fabrik.record_version v join fabrik.record r using(record_id) where v.version_id=(link_item->>'target_version_id')::uuid;
  if not found or target_row.scope_id<>(p->>'scope_id')::uuid or not fabrik_private.can_read_record(target_row.record_id) then raise exception 'Link target unavailable' using errcode='42501'; end if;
  if link_item->>'relation' in ('parent','depends_on') then
   if p->>'kind'<>'activity' or target_row.kind<>'activity' or target_row.record_id=rid then raise exception 'Invalid activity link' using errcode='23514'; end if;
   if link_item->>'relation'='parent' and target_row.payload->>'activity_kind'<>'plan' then raise exception 'Parent must be a plan' using errcode='23514'; end if;
  end if;
 end loop;
 select z->>'relation' into k from jsonb_array_elements(p->'links') z join fabrik.relation_type rt on rt.code=z->>'relation'
  where rt.single_parent group by 1 having count(*)>1 limit 1;
 if k is not null then raise exception 'Only one % is allowed',k using errcode='23514'; end if;
 -- A link that adds a target record can close a loop: walk from each added target.
 foreach k in array array['depends_on','parent'] loop
  added:=array(select distinct t.record_id from jsonb_array_elements(p->'links') z join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
   where z->>'relation'=k and t.record_id not in (select pt.record_id from fabrik.version_link pl join fabrik.record_version pt on pt.version_id=pl.target_version_id
    where pl.source_version_id=oldv.version_id and pl.relation=k));
  if cardinality(added)>0 then
   -- Saves that add a parent or a dependency wait for each other, so two of them never close a loop together.
   perform pg_advisory_xact_lock(19483,31002);
   if fabrik_private.activity_loop(rid,k,added) then raise exception 'Circular activity relationship' using errcode='23514'; end if;
  end if;
 end loop;
 -- No activity finishes before what it contains or waits on.
 if p->>'kind'='activity' then
  -- Only a save that changes a finish, a task type, a parent or a dependency can break the order.
  -- Those saves wait for each other, so two of them never break it together.
  if oldv.version_id is null or coalesce(b->>'forecast_finish_at',b->>'baseline_finish_at')::timestamptz
    is distinct from coalesce(oldv.payload->>'forecast_finish_at',oldv.payload->>'baseline_finish_at')::timestamptz
   or b->>'task_type' is distinct from oldv.payload->>'task_type'
   or array(select z->>'relation'||' '||t.record_id from jsonb_array_elements(p->'links') z join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
     where z->>'relation' in ('parent','depends_on') order by 1)
    is distinct from array(select pl.relation||' '||pt.record_id from fabrik.version_link pl join fabrik.record_version pt on pt.version_id=pl.target_version_id
     where pl.source_version_id=oldv.version_id and pl.relation in ('parent','depends_on') order by 1) then
   perform pg_advisory_xact_lock(19483,31003);
   problems:=fabrik_private.finish_order_problems(p);
   if cardinality(problems)>0 then
    raise exception 'This finish cannot be saved: %.',array_to_string(problems,'; ') using errcode='23514';
   end if;
  end if;
 end if;
 return actions;
end $function$
;
revoke all on function fabrik_private.check_version(jsonb) from public, anon, authenticated;
grant execute on function fabrik_private.check_version(jsonb) to fabrik_writer;
reset role;
revoke create on schema fabrik_private from fabrik_identity;

grant create on schema fabrik, fabrik_private to fabrik_writer;
set role fabrik_writer;
-- A save request's checks, and the actions it takes: check_version's.
create or replace function fabrik_private.validate_version(p jsonb) returns text[]
language sql set search_path=pg_catalog as $$
 select fabrik_private.check_version(p)
$$;

reset role;
revoke create on schema fabrik, fabrik_private from fabrik_writer;

-- Who may read which file events: an administrator every one, others those in the scopes where they
-- hold read of the scope as a whole.
drop policy if exists file_event_reader_read on fabrik.file_event;
create policy file_event_reader_read on fabrik.file_event for select to fabrik_reader
 using (scope_id in (select g.scope_id from fabrik_private.read_grants() g where g.record_id is null and not g.own_records));

set role fabrik_owner;
-- The record named by its id, or by its exact title in any case among the records the caller may
-- read, in p_scope when it is given. Only the records whose title holds each word are read.
create or replace function fabrik_task.record_id(p_record text, p_scope uuid) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); page jsonb; cut bigint; cur bigint; hits jsonb:='[]'::jsonb;
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return t::uuid; end if;
 loop
  page:=fabrik.fabrik_find_records(null,p_scope,t,cut,cur,100);
  cut:=(page->>'cutoff')::bigint;
  hits:=hits||coalesce((select jsonb_agg(x) from jsonb_array_elements(page->'items') x where lower(btrim(x->>'title'))=lower(t)),'[]'::jsonb);
  cur:=(page->>'next_cursor')::bigint;
  exit when cur is null;
 end loop;
 if jsonb_array_length(hits)=1 then return (hits->0->>'record_id')::uuid; end if;
 if jsonb_array_length(hits)=0 then raise exception 'Record unavailable: no record you can read has the title "%"',t using errcode='42501'; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, saved %s, id %s)',x->>'title',fabrik_task.scope_name((x->>'scope_id')::uuid),x->>'saved_at',x->>'record_id'),'; ')
   from jsonb_array_elements(hits) x) using errcode='22023';
end $$;

-- The record named by its id, or by its exact title in any case among the records the caller may read.
create or replace function fabrik_task.record_id(p_record text) returns uuid
language sql stable set search_path=pg_catalog as $$
 select fabrik_task.record_id(p_record,null::uuid)
$$;
revoke all on function fabrik_task.record_id(text,uuid) from public, anon;
grant execute on function fabrik_task.record_id(text,uuid) to authenticated;
reset role;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- A new record. Fields not given take their empty value; a new task's type is work.
create or replace function fabrik.fabrik_add_record(p_scope text, p_kind text, p_title text, p_reason text, p_fields jsonb default '{}',
 p_parent text default null, p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.add((fabrik_task.scope(p_scope)->>'scope_id')::uuid,p_kind,p_title,p_reason,p_fields,
  case when p_parent is not null then fabrik_task.record_id(p_parent,(fabrik_task.scope(p_scope)->>'scope_id')::uuid) end,p_preview)
$$;

-- The activities in a scope the caller may read whose latest version has no owner, or an owner who
-- is not an enabled person who can read activities in the scope. An actor who cannot read the
-- scope gets none.
create or replace function fabrik.fabrik_find_unowned(p_scope_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if p_scope_id is null or not fabrik_private.can_read_scope(p_scope_id) then return jsonb_build_object('items','[]'::jsonb); end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('record_id',l.record_id,'index',l.payload->>'index','title',l.title,
   'activity_kind',l.payload->>'activity_kind','owner_actor_id',l.payload->>'owner_actor_id','owner_label',l.payload->>'owner_label')
   order by l.payload->>'index' nulls last,l.title,l.record_id)
  from (select distinct on(v.record_id) v.* from fabrik.record_version v join fabrik.record r using(record_id)
   where r.kind='activity' and r.scope_id=p_scope_id and r.deleted_at is null and r.record_id in (select fabrik_private.readable_records(p_scope_id,'activity',null,null,null))
   order by v.record_id,v.change_no desc) l
  where not fabrik_private.owner_ok(case when coalesce(l.payload->>'owner_actor_id','') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (l.payload->>'owner_actor_id')::uuid end,
   p_scope_id,l.record_id)),'[]'::jsonb));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8s. Private scopes.
-- ===================================================================
-- A scope can be private, with an owner: the person who made it, or the person an administrator
-- made it for. Only the owner and the people the owner grants read or change anything in it, and
-- administrator authority grants nothing there. The owner gives and ends its grants, and approves
-- each change, deletion and move in it. An administrator sees that it exists, its name and its
-- owner. Its privacy is fixed when it is made. Its owner hands it to another person, who then
-- holds the grants in it alone.
set role fabrik_owner;
alter table fabrik.scope add column if not exists is_private boolean not null default false;
alter table fabrik.scope add column if not exists owner_actor_id uuid references fabrik.actor(actor_id);
alter table fabrik.scope drop constraint if exists scope_private_owner_check;
alter table fabrik.scope add constraint scope_private_owner_check check (not is_private or owner_actor_id is not null);
create index if not exists scope_owner_idx on fabrik.scope(owner_actor_id);
alter table fabrik.scope_change drop constraint if exists scope_change_field_check;
alter table fabrik.scope_change add constraint scope_change_field_check check (field in ('display_name','description','owner_actor_id'));
alter table fabrik.scope_deletion add column if not exists is_private boolean not null default false;

-- The private scope a making or a handing on in this transaction opens to its owner; set only by
-- fabrik_private.open_scope_for.
create or replace function fabrik_private.opening_scope() returns uuid
language sql stable set search_path=pg_catalog as $$
 select nullif(current_setting('fabrik.opening_scope',true),'')::uuid
$$;

-- The private scope a handing on in this transaction is changing; set only by
-- fabrik_private.hand_on_scope.
create or replace function fabrik_private.handing_on_scope() returns uuid
language sql stable set search_path=pg_catalog as $$
 select nullif(current_setting('fabrik.handing_on_scope',true),'')::uuid
$$;
reset role;
revoke all on function fabrik_private.opening_scope(), fabrik_private.handing_on_scope() from public, anon, authenticated;
grant execute on function fabrik_private.opening_scope(), fabrik_private.handing_on_scope() to fabrik_writer, fabrik_reader;

grant create on schema fabrik_private to fabrik_identity;
set role fabrik_owner;
grant create on schema fabrik_storage to fabrik_identity;
reset role;
set role fabrik_identity;
-- A private scope's owner, or null for a scope that is not private.
create or replace function fabrik_private.scope_owner(p_scope uuid) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select owner_actor_id from fabrik.scope where scope_id=p_scope and is_private
$$;

-- Whether a grant or approval is live. In a private scope, its owner issued it; elsewhere, an
-- administrator.
create or replace function fabrik_private.authority_live(p_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.authorisation z
 join fabrik.scope s on s.scope_id=z.scope_id and s.enabled
 join fabrik.actor e on e.actor_id=z.executor_actor_id
 join fabrik.actor h on h.actor_id=z.accountable_human_id
 join fabrik.actor i on i.actor_id=z.issued_by_actor_id
 join fabrik.actor ih on ih.actor_id=i.accountable_human_id
 where z.authorisation_id=p_id and z.revoked_at is null and (z.expires_at is null or z.expires_at>clock_timestamp())
 and e.enabled and h.enabled and i.enabled and ih.enabled and h.actor_kind='human' and ih.actor_kind='human'
 and e.accountable_human_id=h.actor_id
 and case when s.is_private then z.issued_by_actor_id=s.owner_actor_id else i.authority_class='administrator' end)
$$;

-- The actor's live read grants: each scope, with its record kinds and record, or null for every
-- one, and whether the grant is limited to the actor's own records. An administrator has every
-- scope that is not private. In a private scope, every actor has only the grants its owner gave.
-- An actor that is not enabled, or answers to no enabled person, has none.
create or replace function fabrik_private.read_grants(p_actor uuid)
returns table(actor_id uuid, scope_id uuid, record_kinds text[], record_id uuid, own_records boolean)
language sql stable security definer set search_path=pg_catalog rows 20 as $$
 select a.actor_id,s.scope_id,null::text[],null::uuid,false
 from fabrik.actor a join fabrik.actor h on h.actor_id=a.accountable_human_id cross join fabrik.scope s
 where a.actor_id=p_actor and a.enabled and h.enabled and h.actor_kind='human' and a.authority_class='administrator' and not s.is_private
 union all
 select a.actor_id,z.scope_id,z.record_kinds,z.record_id,z.own_records
 from fabrik.actor a join fabrik.actor h on h.actor_id=a.accountable_human_id
 join fabrik.authorisation z on z.executor_actor_id=a.actor_id and z.accountable_human_id=h.actor_id
  and z.mode='standing_permission' and z.revoked_at is null and 'read'=any(z.allowed_actions)
  and (z.expires_at is null or z.expires_at>clock_timestamp())
 join fabrik.scope s on s.scope_id=z.scope_id and s.enabled
 join fabrik.actor i on i.actor_id=z.issued_by_actor_id and i.enabled
  and case when s.is_private then i.actor_id=s.owner_actor_id else i.authority_class='administrator' end
 join fabrik.actor ih on ih.actor_id=i.accountable_human_id and ih.enabled and ih.actor_kind='human'
 where a.actor_id=p_actor and a.enabled and h.enabled and h.actor_kind='human' and (a.authority_class<>'administrator' or s.is_private)
$$;

-- The scopes where the acting actor gives grants and approvals: each private scope they own, and,
-- for an administrator, every scope that is not private.
create or replace function fabrik_private.granting_scopes() returns setof uuid
language sql stable security definer set search_path=pg_catalog as $$
 select s.scope_id from fabrik.scope s, lateral (select fabrik_private.acting_actor() a) x
 where case when s.is_private then s.owner_actor_id=(x.a).actor_id else (x.a).authority_class='administrator' end
$$;

-- Whether the actor may move records from p_from to p_to: a person who owns each private scope of
-- the two, and is an administrator where either is not private.
create or replace function fabrik_private.can_move(p_actor uuid, p_from uuid, p_to uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from fabrik.actor a join fabrik.scope f on f.scope_id=p_from join fabrik.scope t on t.scope_id=p_to
  where a.actor_id=p_actor and a.actor_kind='human'
   and case when f.is_private then f.owner_actor_id=a.actor_id else a.authority_class='administrator' end
   and case when t.is_private then t.owner_actor_id=a.actor_id else a.authority_class='administrator' end)
$$;

-- The scopes the current actor sees, as fabrik_get_scopes lists them: each scope they hold a read grant
-- in, and, for an administrator, each private scope with its name and owner and no description.
create or replace function fabrik_private.read_scopes(p_cursor uuid, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 with g as materialized (select distinct x.scope_id from fabrik_private.read_grants() x),
 page as (select s.scope_id,s.code,s.display_name,case when s.scope_id in (select scope_id from g) then s.description end description,
   s.enabled,s.is_private,s.owner_actor_id,fabrik_private.actor_name(s.owner_actor_id) owner_name
  from fabrik.scope s
  where (s.scope_id in (select scope_id from g) or (s.is_private and a.authority_class='administrator'))
   and (p_cursor is null or s.scope_id>p_cursor) order by s.scope_id limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(page) order by scope_id),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(scope_id order by scope_id desc))[1] end) into result from page;
 return result;
end $$;

-- The people in p_people, a list of objects with actor_id and display_name, that p_name names: by
-- actor id, or by words that all appear in the name, in any case. Of several, the one whose whole
-- name it is.
create or replace function fabrik_private.named_people(p_people jsonb, p_name text) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 with hits as (select x from jsonb_array_elements(p_people) x
  where x->>'actor_id'=lower(btrim(coalesce(p_name,'')))
   or (btrim(coalesce(p_name,''))<>'' and not exists(select 1 from regexp_split_to_table(btrim(p_name),'\s+') w
    where w<>'' and strpos(lower(x->>'display_name'),lower(w))=0))),
 whole as (select x from hits where lower(x->>'display_name')=lower(btrim(p_name)))
 select case when (select count(*) from hits)>1 and (select count(*) from whole)=1 then (select jsonb_agg(x) from whole)
  else coalesce((select jsonb_agg(x order by x->>'display_name',x->>'actor_id') from hits),'[]'::jsonb) end
$$;

-- The enabled actors p_name names, for an administrator or the owner of a private scope to name the
-- actor they grant. An administrator finds any actor; anyone else finds a person, or an agent or
-- application they answer for.
create or replace function fabrik_private.find_actors(p_name text) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.named_people(coalesce(jsonb_agg(jsonb_build_object('actor_id',x.actor_id,'display_name',x.display_name,'actor_kind',x.actor_kind,
   'accountable_human_id',x.accountable_human_id,'accountable_human_name',h.display_name)),'[]'::jsonb),p_name)
 from fabrik.actor x join fabrik.actor h on h.actor_id=x.accountable_human_id
 cross join lateral (select fabrik_private.current_actor() a) me
 where x.enabled and h.enabled
  and ((me.a).authority_class='administrator' or x.actor_kind='human' or x.accountable_human_id=(me.a).accountable_human_id)
$$;

-- The scope named by its id, then its code, then its name, in any case, among the scopes the current
-- actor sees, as fabrik_get_scopes lists them.
create or replace function fabrik_private.named_scope(p_scope text) returns fabrik.scope
language plpgsql stable security definer set search_path=pg_catalog as $$
declare s text:=lower(btrim(coalesce(p_scope,''))); k text; n integer; sc fabrik.scope; admin boolean:=(fabrik_private.current_actor()).authority_class='administrator';
begin
 foreach k in array array['scope_id','code','display_name'] loop
  select count(*) into n from fabrik.scope x where lower(to_jsonb(x)->>k)=s and (fabrik_private.can_see_scope(x.scope_id) or (admin and x.is_private));
  if n=1 then select * into sc from fabrik.scope x where lower(to_jsonb(x)->>k)=s and (fabrik_private.can_see_scope(x.scope_id) or (admin and x.is_private)); return sc; end if;
  if n>1 then
   raise exception 'More than one scope has the name "%": %',p_scope,(select string_agg(format('%s (code %s, id %s)',x.display_name,x.code,x.scope_id),'; ' order by x.code)
    from fabrik.scope x where lower(to_jsonb(x)->>k)=s and (fabrik_private.can_see_scope(x.scope_id) or (admin and x.is_private))) using errcode='22023';
  end if;
 end loop;
 raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
end $$;

-- The record named by its id, or by the exact title of its latest version in any case, among every
-- record the current actor may read that is not deleted.
create or replace function fabrik_private.named_record(p_record text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); hits uuid[];
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  if not exists(select 1 from fabrik.record where record_id=t::uuid) or not fabrik_private.can_read_record(t::uuid) then
   raise exception 'Record unavailable: no record has the id %',t using errcode='42501';
  end if;
  return t::uuid;
 end if;
 select array_agg(r.record_id order by r.record_id) into hits from fabrik.record r
  cross join lateral (select v.title from fabrik.record_version v where v.record_id=r.record_id order by v.change_no desc limit 1) lv
  where r.deleted_at is null and lower(btrim(lv.title))=lower(t) and fabrik_private.can_read_record(r.record_id);
 if cardinality(hits)=1 then return hits[1]; end if;
 if hits is null then raise exception 'Record unavailable: no record has the title "%"',t using errcode='42501'; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, id %s)',t,s.display_name,r.record_id),'; ' order by r.record_id)
   from fabrik.record r join fabrik.scope s using(scope_id) where r.record_id=any(hits)) using errcode='22023';
end $$;
reset role;

set role fabrik_identity;
-- Every bucket the signed-in actor may take an action in: each scope where they hold a live grant
-- of that action for the whole scope, and, for an administrator, every scope that is not private.
create or replace function fabrik_storage.usable_buckets(p_action text) returns setof text
language sql stable security definer set search_path=pg_catalog as $$
 select s.code from fabrik.actor x
  join fabrik.actor h on h.actor_id=x.accountable_human_id
  join fabrik.scope s on s.enabled
  where x.auth_user_id=fabrik_private.request_auth_uid()
   and x.enabled and h.enabled and h.actor_kind='human'
   and ((x.authority_class='administrator' and not s.is_private)
    or exists(select 1 from fabrik.authorisation z
     where z.executor_actor_id=x.actor_id and z.scope_id=s.scope_id and z.mode='standing_permission'
      and z.record_id is null and not z.own_records and p_action=any(z.allowed_actions)
      and fabrik_private.authority_live(z.authorisation_id)))
$$;
reset role;
set role fabrik_owner;
revoke create on schema fabrik_storage from fabrik_identity;
reset role;
revoke create on schema fabrik_private from fabrik_identity;
revoke all on function fabrik_private.scope_owner(uuid), fabrik_private.granting_scopes(), fabrik_private.can_move(uuid,uuid,uuid),
 fabrik_private.read_scopes(uuid,integer), fabrik_private.find_actors(text) from public, anon, authenticated;
grant execute on function fabrik_private.scope_owner(uuid), fabrik_private.granting_scopes(), fabrik_private.can_move(uuid,uuid,uuid)
 to fabrik_owner, fabrik_writer, fabrik_reader;
grant execute on function fabrik_private.read_scopes(uuid,integer), fabrik_private.find_actors(text) to fabrik_owner, fabrik_reader;
revoke all on function fabrik_private.named_people(jsonb,text) from public, anon, authenticated;
grant execute on function fabrik_private.named_people(jsonb,text) to fabrik_owner, fabrik_writer, fabrik_reader;

-- Who may read which deleted scopes: an administrator, and the person who deleted a private one.
drop policy if exists scope_deletion_reader_read on fabrik.scope_deletion;
create policy scope_deletion_reader_read on fabrik.scope_deletion for select to fabrik_reader
 using ((select (fabrik_private.current_actor()).authority_class)='administrator'
  or deleted_by_actor_id=(select (fabrik_private.current_actor()).actor_id));

-- Who may read which grants and approvals: the actor each names, and whoever gives them in its scope.
drop policy if exists authorisation_reader_read on fabrik.authorisation;
create policy authorisation_reader_read on fabrik.authorisation for select to fabrik_reader
 using (executor_actor_id=(select (fabrik_private.acting_actor()).actor_id)
  or scope_id in (select fabrik_private.granting_scopes()));

set role fabrik_owner;
create or replace function fabrik_private.guard_scope() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 perform fabrik_private.lock_writes();
 if tg_op='DELETE' then
  if current_user='fabrik_owner' and old.scope_id=fabrik_private.deleting_scope() then return old; end if;
  raise exception 'Disable scopes; delete only an empty one, with fabrik_delete_scope' using errcode='23514';
 end if;
 if tg_op='UPDATE' and row(new.scope_id,new.code,new.created_by,new.created_at,new.created_reason,new.is_private) is distinct from row(old.scope_id,old.code,old.created_by,old.created_at,old.created_reason,old.is_private) then
  raise exception 'Scope identity is fixed' using errcode='23514';
 end if;
 if tg_op='UPDATE' and new.owner_actor_id is distinct from old.owner_actor_id
  and not (current_user='fabrik_owner' and new.scope_id=fabrik_private.handing_on_scope()) then
  raise exception 'A private scope changes owner only when its owner hands it on, with fabrik_hand_on_scope' using errcode='23514';
 end if;
 return new;
end $$;

create or replace function fabrik_private.guard_authorisation() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare a fabrik.actor; own uuid;
begin
 -- Deleting an empty scope deletes its grants and approvals, only from fabrik_private.delete_scope.
 if tg_op='DELETE' and current_user='fabrik_owner' and old.scope_id=fabrik_private.deleting_scope() then return old; end if;
 -- A deletion empties the approval requests that carried its record's content.
 if tg_op='UPDATE' and current_user='fabrik_owner' and fabrik_private.deleting_record() is not null then
  if old.mode='explicit_approval' and fabrik_private.carries_record(old.request_payload,fabrik_private.deleting_record())
   and (to_jsonb(new)-array['request_payload','reason'])=(to_jsonb(old)-array['request_payload','reason'])
   and new.request_payload=fabrik_private.erased_request(old.request_payload,fabrik_private.deleting_record())
   and new.reason=(case when old.request_payload->>'record_id'=fabrik_private.deleting_record()::text then 'Deleted' else old.reason end) then
   return new;
  end if;
  raise exception 'A deletion empties only the approvals that carry its record' using errcode='42501';
 end if;
 -- Handing a private scope on ends each grant and unused approval its old owner gave there, only
 -- from fabrik_private.hand_on_scope.
 if tg_op='UPDATE' and current_user='fabrik_owner' and old.scope_id=fabrik_private.handing_on_scope() then
  if old.revoked_at is null and new.revoked_at is not null and new.revoked_by_actor_id=old.issued_by_actor_id
   and (to_jsonb(new)-array['revoked_at','revoked_by_actor_id','revocation_reason'])=(to_jsonb(old)-array['revoked_at','revoked_by_actor_id','revocation_reason']) then
   return new;
  end if;
  raise exception 'Handing a scope on ends only the grants its old owner gave' using errcode='42501';
 end if;
 -- A private scope opens to its owner with one full grant, issued in their own name, only from
 -- fabrik_private.open_scope_for.
 if tg_op='INSERT' and current_user='fabrik_owner' and new.scope_id=fabrik_private.opening_scope() then
  if new.issued_by_actor_id=fabrik_private.scope_owner(new.scope_id) and new.executor_actor_id=new.issued_by_actor_id
   and new.accountable_human_id=new.issued_by_actor_id and new.mode='standing_permission' and new.record_id is null
   and not new.own_records and new.expires_at is null then
   return new;
  end if;
  raise exception 'A private scope opens with one full grant to its owner' using errcode='42501';
 end if;
 if current_user<>'fabrik_writer' then raise exception 'Use authority functions' using errcode='42501'; end if;
 a:=fabrik_private.acting_actor();
 if tg_op='DELETE' then raise exception 'Authorisations are retained' using errcode='23514'; end if;
 -- In a private scope, its owner gives and ends every grant and approval; elsewhere, an administrator.
 own:=fabrik_private.scope_owner(new.scope_id);
 if tg_op='INSERT' then
  if new.issued_by_actor_id<>a.actor_id or (own is null and a.authority_class<>'administrator') or (own is not null and a.actor_id<>own) then
   raise exception '%',case when own is null then 'Administrator issuer required' else 'Only the scope''s owner gives grants and approvals in a private scope' end using errcode='42501';
  end if;
  if not exists(select 1 from fabrik.actor e join fabrik.actor h on h.actor_id=e.accountable_human_id
   where e.actor_id=new.executor_actor_id and h.actor_id=new.accountable_human_id and h.actor_kind='human' and e.enabled and h.enabled) then
   raise exception 'Invalid executor or accountable human' using errcode='23514';
  end if;
  if new.expires_at is null and new.mode='explicit_approval' then
   raise exception 'Exact approval requires expiry' using errcode='23514';
  end if;
  return new;
 end if;
 if (to_jsonb(new)-array['revoked_at','revoked_by_actor_id','revocation_reason','consumed_version_id','consumed_deletion_id'])
   is distinct from (to_jsonb(old)-array['revoked_at','revoked_by_actor_id','revocation_reason','consumed_version_id','consumed_deletion_id']) then
  raise exception 'Authority scope is immutable; revoke and issue another grant' using errcode='23514';
 end if;
 if row(new.revoked_at,new.revoked_by_actor_id,new.revocation_reason) is distinct from row(old.revoked_at,old.revoked_by_actor_id,old.revocation_reason) then
  if (own is null and a.authority_class<>'administrator') or (own is not null and a.actor_id<>own)
   or old.revoked_at is not null or new.revoked_at is null or new.revoked_by_actor_id<>a.actor_id then
   raise exception 'Invalid revocation' using errcode='42501';
  end if;
 end if;
 if new.consumed_version_id is distinct from old.consumed_version_id then
  if old.consumed_version_id is not null or new.consumed_version_id is null or old.mode<>'explicit_approval'
    or new.executor_actor_id<>a.actor_id or not fabrik_private.authority_live(new.authorisation_id)
    or not exists(select 1 from fabrik.record_version where version_id=new.consumed_version_id and authorisation_id=new.authorisation_id and executor_actor_id=a.actor_id) then
   raise exception 'Invalid approval consumption' using errcode='42501';
  end if;
 end if;
 if new.consumed_deletion_id is distinct from old.consumed_deletion_id then
  if old.consumed_deletion_id is not null or old.consumed_version_id is not null or new.consumed_deletion_id is null or old.mode<>'explicit_approval'
    or new.executor_actor_id<>a.actor_id or not fabrik_private.authority_live(new.authorisation_id)
    or not exists(select 1 from fabrik.record_deletion where deletion_id=new.consumed_deletion_id and authorisation_id=new.authorisation_id and executor_actor_id=a.actor_id) then
   raise exception 'Invalid approval consumption' using errcode='42501';
  end if;
 end if;
 return new;
end $$;

-- Opens a private scope to its owner: one full grant, issued in their own name. Called only by
-- add_scope and hand_on_scope.
create or replace function fabrik_private.open_scope_for(p_scope uuid, p_owner uuid) returns uuid
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare kinds text[]:=array['activity','decision','model','evidence']; actions text[]:=array['read','create','edit','start','hold','complete','reopen','cancel','decide','delete'];
 req jsonb; g uuid;
begin
 req:=jsonb_build_object('scope_id',p_scope,'operation','grant','executor',p_owner,'kinds',kinds,'record',null,'actions',actions,'expiry',null,'reason','Owner of the private scope');
 perform set_config('fabrik.opening_scope',p_scope::text,true);
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,own_records,expires_at,reason)
 values(p_scope,p_owner,p_owner,p_owner,'standing_permission',gen_random_uuid(),
  encode(sha256(convert_to(jsonb_build_object('format',1,'request',req,'executor',p_owner,'human',p_owner)::text,'UTF8')),'hex'),
  kinds,null,actions,false,null,'Owner of the private scope') returning authorisation_id into g;
 perform set_config('fabrik.opening_scope','',true);
 return g;
end $$;

-- Adds a scope, with its bucket, and opens a private one to its owner. The audit log shows it as
-- scope_created, with who added it, when and why. fabrik_add_scope calls it after every check.
create or replace function fabrik_private.add_scope(p_code text, p_display_name text, p_description text, p_private boolean, p_owner uuid, p_creator uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare s fabrik.scope; g uuid;
begin
 insert into fabrik.scope(code,display_name,description,created_by,created_reason,is_private,owner_actor_id)
 values(p_code,p_display_name,p_description,p_creator,p_reason,p_private,case when p_private then p_owner end) returning * into s;
 if p_private then g:=fabrik_private.open_scope_for(s.scope_id,p_owner); end if;
 return jsonb_build_object('scope_id',s.scope_id,'code',s.code,'name',s.display_name,'description',s.description,
  'created_at',s.created_at,'created_by',fabrik_private.actor_name(p_creator),'reason',p_reason,
  'is_private',s.is_private,'owner_actor_id',s.owner_actor_id,'owner_name',fabrik_private.actor_name(s.owner_actor_id),'owner_grant_id',g);
end $$;

-- Hands a private scope to p_owner, logs it, ends each grant and unused approval the old owner gave
-- there, and opens it to the new owner. fabrik_hand_on_scope calls it after every check.
create or replace function fabrik_private.hand_on_scope(p_scope uuid, p_owner uuid, p_executor uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare o fabrik.scope; n fabrik.scope; g uuid;
begin
 select * into o from fabrik.scope where scope_id=p_scope for update;
 if not o.is_private or o.owner_actor_id is distinct from p_executor then raise exception 'Only the scope''s owner hands it on' using errcode='42501'; end if;
 perform set_config('fabrik.handing_on_scope',p_scope::text,true);
 update fabrik.scope set owner_actor_id=p_owner where scope_id=p_scope returning * into n;
 update fabrik.authorisation set revoked_at=clock_timestamp(),revoked_by_actor_id=p_executor,revocation_reason='The scope was handed on: '||p_reason
 where scope_id=p_scope and issued_by_actor_id=o.owner_actor_id and revoked_at is null and consumed_version_id is null and consumed_deletion_id is null;
 perform set_config('fabrik.handing_on_scope','',true);
 perform set_config('fabrik.renaming_scope',p_scope::text,true);
 insert into fabrik.scope_change(scope_id,field,old_value,new_value,changed_by_actor_id,reason)
 values(p_scope,'owner_actor_id',o.owner_actor_id::text,p_owner::text,p_executor,p_reason);
 perform set_config('fabrik.renaming_scope','',true);
 g:=fabrik_private.open_scope_for(p_scope,p_owner);
 return jsonb_build_object('scope_id',n.scope_id,'code',n.code,'name',n.display_name,
  'old_owner_actor_id',o.owner_actor_id,'old_owner_name',fabrik_private.actor_name(o.owner_actor_id),
  'owner_actor_id',n.owner_actor_id,'owner_name',fabrik_private.actor_name(n.owner_actor_id),'owner_grant_id',g,
  'changed_at',clock_timestamp(),'reason',p_reason);
end $$;

-- Deletes an empty scope, its grants and its bucket, and logs it. fabrik_delete_scope calls it after
-- every check except the scope's emptiness, which it checks here under the scope's lock.
create or replace function fabrik_private.delete_scope(p_scope uuid, p_executor uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare s fabrik.scope; n bigint; k bigint; g jsonb;
begin
 select * into s from fabrik.scope where scope_id=p_scope for update;
 select count(*), count(*) filter (where deleted_at is not null) into n, k from fabrik.record where scope_id=p_scope;
 if n>0 then
  raise exception 'The scope % holds % records, % of them deleted; a scope is deleted only when it holds none',s.display_name,n,k using errcode='23503';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('authorisation_id',z.authorisation_id,'mode',z.mode,
   'executor',fabrik_private.actor_name(z.executor_actor_id),'accountable_human',fabrik_private.actor_name(z.accountable_human_id),
   'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds,'issued_at',z.issued_at,'revoked_at',z.revoked_at) order by z.issued_at,z.authorisation_id),'[]'::jsonb)
  into g from fabrik.authorisation z where z.scope_id=p_scope;
 perform set_config('fabrik.deleting_scope',p_scope::text,true);
 insert into fabrik.scope_deletion(scope_id,code,display_name,description,grants_removed,deleted_by_actor_id,reason,is_private)
 values (s.scope_id,s.code,s.display_name,s.description,g,p_executor,p_reason,s.is_private);
 delete from fabrik.authorisation where scope_id=p_scope;
 perform fabrik_storage.delete_scope_bucket(s.code);
 delete from fabrik.scope where scope_id=p_scope;
 perform set_config('fabrik.deleting_scope','',true);
 return jsonb_build_object('scope_id',s.scope_id,'code',s.code,'name',s.display_name,'description',s.description,
  'grants_removed',jsonb_array_length(g),'deleted_at',clock_timestamp(),
  'deleted_by',fabrik_private.actor_name(p_executor),'reason',p_reason);
end $$;

-- The grant to save a request with: none for a person who is an administrator, outside a private
-- scope, or for an actor whose every save needs an approval; otherwise the caller's live standing
-- grant in the request's scope that covers its kind, its record and every action, soonest expiry first.
create or replace function fabrik_task.grant_for(p_request jsonb, p_actions text[]) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare me jsonb:=fabrik.fabrik_get_actor(); page jsonb; cur uuid; acc jsonb:='[]'::jsonb; g uuid; private boolean;
begin
 if (me->>'requires_human_approval')::boolean then return null; end if;
 if me->>'actor_kind'='human' and me->>'authority_class'='administrator' then
  private:=coalesce((select (x->>'is_private')::boolean from jsonb_array_elements(fabrik_task.scopes()) x where x->>'scope_id'=p_request->>'scope_id'),false);
  if not private then return null; end if;
 end if;
 loop
  page:=fabrik.fabrik_get_authorisations((me->>'actor_id')::uuid,cur,100);
  acc:=acc||(page->'items');
  cur:=(page->>'next_cursor')::uuid;
  exit when cur is null;
 end loop;
 select (z->>'authorisation_id')::uuid into g from jsonb_array_elements(acc) z
 where z->>'mode'='standing_permission' and z->>'revoked_at' is null
  and (z->>'expires_at' is null or (z->>'expires_at')::timestamptz>clock_timestamp())
  and z->>'scope_id'=p_request->>'scope_id'
  and (z->'record_kinds') ? (p_request->>'kind')
  and (z->>'record_id' is null or z->>'record_id'=p_request->>'record_id')
  and (select coalesce(bool_and((z->'allowed_actions') ? x),true) from unnest(p_actions) x)
 order by (z->>'own_records')::boolean,(z->>'expires_at')::timestamptz nulls last,z->>'authorisation_id' limit 1;
 if g is null then
  private:=coalesce(private,(select (x->>'is_private')::boolean from jsonb_array_elements(fabrik_task.scopes()) x where x->>'scope_id'=p_request->>'scope_id'),false);
  raise exception 'No grant of yours covers % on % records in %. %',
   array_to_string(p_actions,', '),p_request->>'kind',fabrik_task.scope_name((p_request->>'scope_id')::uuid),
   case when private then 'Its owner can grant it, or approve this exact change' else 'An administrator can grant it, or approve this exact change' end using errcode='42501';
 end if;
 return g;
end $$;
reset role;
revoke all on function fabrik_private.open_scope_for(uuid,uuid), fabrik_private.add_scope(text,text,text,boolean,uuid,uuid,text),
 fabrik_private.hand_on_scope(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.add_scope(text,text,text,boolean,uuid,uuid,text), fabrik_private.hand_on_scope(uuid,uuid,uuid,text) to fabrik_writer;

grant create on schema fabrik, fabrik_private to fabrik_writer;
set role fabrik_writer;
-- Administrator provisioning, run in the SQL Editor by the postgres login only. A private scope's
-- grants are its owner's to give.
CREATE OR REPLACE FUNCTION fabrik_private.provision_grant(p_approver_actor_id uuid, p_issuance_request_id uuid, p_executor_id uuid, p_scope_id uuid, p_record_kinds text[], p_record_id uuid, p_actions text[], p_expires_at timestamp with time zone, p_reason text, p_own_records boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare previous_actor text; a fabrik.actor; e fabrik.actor; z fabrik.authorisation; h text; req jsonb;
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_approver_actor_id is null then raise exception 'Administrator approver required' using errcode='22023'; end if;
 if fabrik_private.scope_owner(p_scope_id) is not null then
  raise exception 'A private scope''s grants are given by its owner, with fabrik_grant_permission' using errcode='42501';
 end if;
 previous_actor:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',p_approver_actor_id::text,true);
 perform fabrik_private.lock_writes(); a:=fabrik_private.acting_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 select * into e from fabrik.actor where actor_id=p_executor_id and enabled;
 if not found then raise exception 'Executor unavailable' using errcode='22023'; end if;
 if p_scope_id is null or not exists(select 1 from fabrik.scope where scope_id=p_scope_id and enabled) then raise exception 'Scope unavailable' using errcode='22023'; end if;
 req:=jsonb_build_object('scope_id',p_scope_id,'operation','grant','executor',p_executor_id,'kinds',p_record_kinds,'record',p_record_id,'actions',p_actions,'expiry',p_expires_at,'reason',p_reason)
  ||case when coalesce(p_own_records,false) then jsonb_build_object('own_records',true) else '{}'::jsonb end;
 h:=fabrik_private.canonical_request_hash(req,a.actor_id,e.accountable_human_id);
 select * into z from fabrik.authorisation where issued_by_actor_id=a.actor_id and issuance_request_id=p_issuance_request_id;
 if found then
  if z.issuance_hash<>h then raise exception 'Issuance retry differs' using errcode='22023'; end if;
  perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z);
 end if;
 if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at<=clock_timestamp()) then raise exception 'Expiry must be in the future' using errcode='22023'; end if;
 if p_record_id is not null and not exists(select 1 from fabrik.record where record_id=p_record_id and scope_id=p_scope_id and kind=any(p_record_kinds)) then
  raise exception 'Record scope does not match kinds' using errcode='22023';
 end if;
 if coalesce(p_own_records,false) then
  if p_record_id is not null then raise exception 'A grant limited to own records covers no single record' using errcode='22023'; end if;
  if p_actions is null or 'delete'=any(p_actions) then raise exception 'A grant limited to own records does not carry delete' using errcode='22023'; end if;
  if not 'read'=any(p_actions) then raise exception 'A grant limited to own records carries read' using errcode='22023'; end if;
 end if;
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,own_records,expires_at,reason)
 values(p_scope_id,e.actor_id,e.accountable_human_id,a.actor_id,'standing_permission',p_issuance_request_id,h,p_record_kinds,p_record_id,p_actions,coalesce(p_own_records,false),p_expires_at,p_reason) returning * into z;
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z);
exception when others then
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 raise;
end $function$
;

CREATE OR REPLACE FUNCTION fabrik_private.provision_revocation(p_approver_actor_id uuid, p_authorisation_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare previous_actor text; a fabrik.actor; z fabrik.authorisation;
begin
 if fabrik_private.request_auth_uid() is not null or not pg_has_role(session_user,'fabrik_owner','MEMBER') then
  raise exception 'Provisioning requires the administrator login without an Auth identity' using errcode='42501';
 end if;
 if p_approver_actor_id is null then raise exception 'Administrator approver required' using errcode='22023'; end if;
 if fabrik_private.scope_owner((select scope_id from fabrik.authorisation where authorisation_id=p_authorisation_id)) is not null then
  raise exception 'A private scope''s grants are ended by its owner, with fabrik_revoke_authorisation' using errcode='42501';
 end if;
 previous_actor:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',p_approver_actor_id::text,true);
 perform fabrik_private.lock_writes(); a:=fabrik_private.acting_actor();
 if a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then raise exception 'Revocation reason required' using errcode='22023'; end if;
 select * into z from fabrik.authorisation where authorisation_id=p_authorisation_id;
 if not found then raise exception 'Authorisation unavailable' using errcode='22023'; end if;
 if z.revoked_at is not null then perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z); end if;
 update fabrik.authorisation set revoked_at=clock_timestamp(),revoked_by_actor_id=a.actor_id,revocation_reason=p_reason
 where authorisation_id=p_authorisation_id returning * into z;
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true); return to_jsonb(z);
exception when others then
 perform set_config('fabrik.provisioning_actor',coalesce(previous_actor,''),true);
 raise;
end $function$
;

reset role;
revoke create on schema fabrik, fabrik_private from fabrik_writer;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- Each grant and approval the caller may read, with p_executor_id the ones it names: an
-- administrator's, or a private scope's owner's, of anyone; anyone else's, their own.
create or replace function fabrik.fabrik_get_authorisations(p_executor_id uuid default null,p_cursor uuid default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if a.authority_class<>'administrator' and p_executor_id is not null and p_executor_id<>a.actor_id
  and not exists(select 1 from fabrik_private.granting_scopes()) then return jsonb_build_object('items','[]'::jsonb,'next_cursor',null); end if;
 with page as (select * from fabrik.authorisation where (p_executor_id is null or executor_actor_id=p_executor_id)
  and (p_cursor is null or authorisation_id>p_cursor) order by authorisation_id limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(page) order by authorisation_id),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(authorisation_id order by authorisation_id desc))[1] end) into result from page;
 return result;
end $$;

create or replace function fabrik.fabrik_get_scopes(p_cursor uuid default null,p_limit integer default 100) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.read_scopes(p_cursor,p_limit)
$$;

-- The enabled actors whose names hold every word given, for an administrator or the owner of a
-- private scope, to name the actor they grant.
create or replace function fabrik.fabrik_find_actors(p_name text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor:=fabrik_private.read_actor();
begin
 if a.actor_kind<>'human' or (a.authority_class<>'administrator' and not exists(select 1 from fabrik_private.granting_scopes())) then
  raise exception 'Only an administrator, or the owner of a private scope, finds people to grant' using errcode='42501';
 end if;
 if btrim(coalesce(p_name,''))='' then raise exception 'Give words of the name, as p_name' using errcode='22023'; end if;
 return jsonb_build_object('items',fabrik_private.find_actors(p_name));
end $$;

-- What moving the named records to the named scope would do, as the request fabrik_move_records takes.
-- A person who owns each private scope of the two previews it, and is an administrator where either
-- is not private.
create or replace function fabrik.fabrik_preview_move(p_records text[], p_to_scope text, p_reason text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor:=fabrik_private.read_actor(); ids uuid[]; t text; sc fabrik.scope; f jsonb;
begin
 if a.actor_kind<>'human' or (a.authority_class<>'administrator' and not exists(select 1 from fabrik_private.granting_scopes())) then
  raise exception 'Only a person who is an administrator moves records' using errcode='42501';
 end if;
 if p_records is null or cardinality(p_records)=0 then raise exception 'Name the records to move' using errcode='22023'; end if;
 foreach t in array p_records loop ids:=ids||fabrik_private.named_record(t); end loop;
 ids:=array(select distinct x from unnest(ids) x order by 1);
 sc:=fabrik_private.named_scope(p_to_scope);
 if not sc.enabled then raise exception 'Scope unavailable: % is disabled',sc.display_name using errcode='42501'; end if;
 f:=fabrik_private.move_facts(ids,sc.scope_id);
 if f->'from_scope_id'='null'::jsonb then
  raise exception 'Every record in a move is in the same scope. These are in %',(select string_agg(distinct fabrik_private.scope_name(r.scope_id),', ')
   from fabrik.record r where r.record_id=any(ids)) using errcode='22023';
 end if;
 if not fabrik_private.can_move(a.actor_id,(f->>'from_scope_id')::uuid,sc.scope_id) then
  raise exception 'Only the owner of a private scope moves records into or out of it, and only an administrator moves them elsewhere' using errcode='42501';
 end if;
 if (f->>'from_scope_id')::uuid=sc.scope_id then raise exception 'The records are already in %',sc.display_name using errcode='22023'; end if;
 return jsonb_build_object('operation','move','request_id',gen_random_uuid(),'from_scope_id',f->'from_scope_id','from_scope_name',f->'from_scope_name',
  'to_scope_id',sc.scope_id,'to_scope_name',f->'to_scope_name','records',f->'records','reason',p_reason,
  'outside_links',f->'outside_links','refused',f->'refused','losing_access',f->'losing_access','gaining_access',f->'gaining_access');
end $$;

reset role;
revoke create on schema fabrik from fabrik_reader;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8t. Refused changes are logged.
-- ===================================================================
-- Each change fabrik refuses for want of permission: when, the actor, the function, the scope, the
-- record's kind and id where the call names them, and fabrik's message. Append-only, written only by
-- fabrik_private.log_refusal.
set role fabrik_owner;
create table if not exists fabrik.refusal_event (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 actor_id uuid references fabrik.actor(actor_id),
 auth_user_id uuid,
 function_name text not null,
 scope_id uuid,
 kind text,
 record_id uuid,
 problem text not null
);
create index if not exists refusal_event_time_idx on fabrik.refusal_event(at desc);
create index if not exists refusal_event_scope_time_idx on fabrik.refusal_event(scope_id,at desc);
create index if not exists refusal_event_actor_idx on fabrik.refusal_event(actor_id);
alter table fabrik.refusal_event enable row level security;
revoke all on fabrik.refusal_event from public;
grant select on fabrik.refusal_event to fabrik_reader;

create or replace function fabrik_private.guard_refusal_event()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 raise exception 'The refusal log is append-only' using errcode='23514';
end $$;
revoke all on function fabrik_private.guard_refusal_event() from public, anon, authenticated;
drop trigger if exists refusal_event_immutable on fabrik.refusal_event;
create trigger refusal_event_immutable before update or delete on fabrik.refusal_event
 for each row execute function fabrik_private.guard_refusal_event();
drop trigger if exists refusal_event_no_truncate on fabrik.refusal_event;
create trigger refusal_event_no_truncate before truncate on fabrik.refusal_event
 for each statement execute function fabrik_private.guard_refusal_event();

-- Logs a refusal as the signed-in actor, and gives the answer a refused call returns. The scope is
-- named by its id, code or name, and the record by its id. Where only the record is named, its scope
-- and kind are those of a record the actor may read. An actor fabrik refuses as disabled is named by
-- their sign-in.
create or replace function fabrik_private.log_refusal(p_function text, p_problem text, p_scope text, p_kind text, p_record text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; sid uuid; rid uuid; k text:=left(nullif(btrim(coalesce(p_kind,'')),''),200); s text:=lower(btrim(coalesce(p_scope,'')));
 known boolean:=true; uuid_shape text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
 begin a:=fabrik_private.current_actor();
 exception when others then
  known:=false;
  select * into a from fabrik.actor where auth_user_id=fabrik_private.request_auth_uid() limit 1;
 end;
 if s ~ uuid_shape then
  select scope_id into sid from fabrik.scope where scope_id=s::uuid;
 elsif s<>'' then
  select min(scope_id::text)::uuid into sid from fabrik.scope where code=s or lower(btrim(display_name))=s having count(*)=1;
 end if;
 if lower(btrim(coalesce(p_record,''))) ~ uuid_shape then
  rid:=lower(btrim(p_record))::uuid;
  if (sid is null or k is null) and known and fabrik_private.can_read_record(rid) then
   select coalesce(sid,r.scope_id),coalesce(k,r.kind) into sid,k from fabrik.record r where r.record_id=rid;
  end if;
 end if;
 insert into fabrik.refusal_event(actor_id,auth_user_id,function_name,scope_id,kind,record_id,problem)
 values(a.actor_id,fabrik_private.request_auth_uid(),p_function,sid,k,rid,coalesce(p_problem,'Refused'));
 return jsonb_build_object('refused',true,'problem',coalesce(p_problem,'Refused'));
end $$;
reset role;
revoke all on function fabrik_private.log_refusal(text,text,text,text,text) from public, anon, authenticated;
grant execute on function fabrik_private.log_refusal(text,text,text,text,text) to fabrik_writer;

-- Who may read which refusals: the refused actor their own, an administrator each one outside a
-- private scope, and a private scope's owner those in it.
drop policy if exists refusal_event_reader_read on fabrik.refusal_event;
create policy refusal_event_reader_read on fabrik.refusal_event for select to fabrik_reader
 using (actor_id=(select (fabrik_private.current_actor()).actor_id)
 or ((select (fabrik_private.current_actor()).authority_class)='administrator' and (scope_id is null or fabrik_private.scope_owner(scope_id) is null))
 or (scope_id is not null and fabrik_private.scope_owner(scope_id)=(select (fabrik_private.current_actor()).actor_id)));

-- The bodies of the functions that change data, as they were, each under its name without fabrik_. A
-- body that calls another calls its body, so a refusal there still undoes the whole call.
grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
CREATE OR REPLACE FUNCTION fabrik_private.grant_permission(p_issuance_request_id uuid, p_executor_id uuid, p_scope_id uuid, p_record_kinds text[], p_record_id uuid, p_actions text[], p_expires_at timestamp with time zone, p_reason text, p_own_records boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; e fabrik.actor; z fabrik.authorisation; h text; req jsonb; own uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 -- In a private scope, its owner gives every grant; elsewhere, an administrator.
 own:=fabrik_private.scope_owner(p_scope_id);
 if own is not null then
  if a.actor_id<>own then raise exception 'Only the scope''s owner gives grants in a private scope' using errcode='42501'; end if;
 elsif a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 select * into e from fabrik.actor where actor_id=p_executor_id and enabled;
 if not found then raise exception 'Executor unavailable' using errcode='22023'; end if;
 if p_scope_id is null or not exists(select 1 from fabrik.scope where scope_id=p_scope_id and enabled) then raise exception 'Scope unavailable' using errcode='22023'; end if;
 req:=jsonb_build_object('scope_id',p_scope_id,'operation','grant','executor',p_executor_id,'kinds',p_record_kinds,'record',p_record_id,'actions',p_actions,'expiry',p_expires_at,'reason',p_reason)
  ||case when coalesce(p_own_records,false) then jsonb_build_object('own_records',true) else '{}'::jsonb end;
 h:=fabrik_private.canonical_request_hash(req,a.actor_id,e.accountable_human_id);
 select * into z from fabrik.authorisation where issued_by_actor_id=a.actor_id and issuance_request_id=p_issuance_request_id;
 if found then
  if z.issuance_hash<>h then raise exception 'Issuance retry differs' using errcode='22023'; end if;
  return to_jsonb(z);
 end if;
 if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at<=clock_timestamp()) then raise exception 'Expiry must be in the future' using errcode='22023'; end if;
 if p_record_id is not null and not exists(select 1 from fabrik.record where record_id=p_record_id and scope_id=p_scope_id and kind=any(p_record_kinds)) then
  raise exception 'Record scope does not match kinds' using errcode='22023';
 end if;
 if coalesce(p_own_records,false) then
  if p_record_id is not null then raise exception 'A grant limited to own records covers no single record' using errcode='22023'; end if;
  if p_actions is null or 'delete'=any(p_actions) then raise exception 'A grant limited to own records does not carry delete' using errcode='22023'; end if;
  if not 'read'=any(p_actions) then raise exception 'A grant limited to own records carries read' using errcode='22023'; end if;
 end if;
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,own_records,expires_at,reason)
 values(p_scope_id,e.actor_id,e.accountable_human_id,a.actor_id,'standing_permission',p_issuance_request_id,h,p_record_kinds,p_record_id,p_actions,coalesce(p_own_records,false),p_expires_at,p_reason) returning * into z;
 return to_jsonb(z);
end $function$
;

create or replace function fabrik_private.grant_permission(p_issuance_request_id uuid,p_executor_id uuid,p_record_kinds text[],p_record_id uuid,p_actions text[],p_expires_at timestamptz,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin raise exception 'scope_id is required; use the scoped grant function' using errcode='22023'; end $$;

CREATE OR REPLACE FUNCTION fabrik_private.approve_change(p_issuance_request_id uuid, p_executor_id uuid, p_request jsonb, p_expires_at timestamp with time zone, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; e fabrik.actor; z fabrik.authorisation; ih text; rh text; actions text[]; existing_id uuid; own uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 -- In a private scope, its owner approves every change; elsewhere, an administrator.
 own:=fabrik_private.scope_owner(case when p_request->>'scope_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p_request->>'scope_id')::uuid end);
 if own is not null then
  if a.actor_id<>own then raise exception 'Only the scope''s owner approves changes in a private scope' using errcode='42501'; end if;
 elsif a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 if p_request ? 'operation' then
  if a.actor_kind<>'human' then raise exception 'Record deletion needs a human administrator''s approval' using errcode='42501'; end if;
 else
  perform fabrik_private.validate_shape(p_request);
 end if;
 select * into e from fabrik.actor where actor_id=p_executor_id and enabled;
 if not found then raise exception 'Executor unavailable' using errcode='22023'; end if;
 if e.requires_human_approval and a.actor_kind<>'human' then raise exception 'Executor requires human-issued approval' using errcode='42501'; end if;
 perform fabrik_private.assert_request_scope(p_request,e.actor_id);
 rh:=fabrik_private.canonical_request_hash(p_request,e.actor_id,e.accountable_human_id);
 ih:=fabrik_private.canonical_request_hash(jsonb_build_object('operation','approve','request',p_request,'executor',p_executor_id,'expiry',p_expires_at,'reason',p_reason),a.actor_id,e.accountable_human_id);
 select * into z from fabrik.authorisation where issued_by_actor_id=a.actor_id and issuance_request_id=p_issuance_request_id;
 if found then
  if z.issuance_hash<>ih then raise exception 'Issuance retry differs' using errcode='22023'; end if;
  return to_jsonb(z);
 end if;
 if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at<=clock_timestamp() then raise exception 'Exact approval needs future expiry' using errcode='22023'; end if;
 actions:=case when p_request ? 'operation' then fabrik_private.validate_deletion(p_request) else fabrik_private.validate_version(p_request) end;
 select record_id into existing_id from fabrik.record where record_id=(p_request->>'record_id')::uuid;
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,request_id,request_payload,request_hash,expires_at,reason)
 values((p_request->>'scope_id')::uuid,e.actor_id,e.accountable_human_id,a.actor_id,'explicit_approval',p_issuance_request_id,ih,array[p_request->>'kind'],existing_id,actions,
  (p_request->>'request_id')::uuid,p_request,rh,p_expires_at,p_reason) returning * into z;
 return to_jsonb(z);
end $function$
;

create or replace function fabrik_private.revoke_authorisation(p_authorisation_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; z fabrik.authorisation; own uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 select * into z from fabrik.authorisation where authorisation_id=p_authorisation_id;
 -- In a private scope, its owner ends every grant; elsewhere, an administrator.
 own:=fabrik_private.scope_owner(z.scope_id);
 if own is not null then
  if a.actor_id<>own then raise exception 'Only the scope''s owner ends grants in a private scope' using errcode='42501'; end if;
 elsif a.authority_class<>'administrator' then raise exception 'Administrator authority required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then raise exception 'Revocation reason required' using errcode='22023'; end if;
 if z.authorisation_id is null then raise exception 'Authorisation unavailable' using errcode='22023'; end if;
 if z.revoked_at is not null then return to_jsonb(z); end if;
 update fabrik.authorisation set revoked_at=clock_timestamp(),revoked_by_actor_id=a.actor_id,revocation_reason=p_reason
 where authorisation_id=p_authorisation_id returning * into z;
 return to_jsonb(z);
end $$;

CREATE OR REPLACE FUNCTION fabrik_private.save_version(p_request jsonb, p_authorisation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; z fabrik.authorisation; v fabrik.record_version; oldv fabrik.record_version;
 h text; actions text[]; aid uuid:=p_authorisation_id; l jsonb; rid uuid; vnum integer; vid uuid; t timestamptz; w jsonb:='[]'::jsonb; k text; own uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 perform fabrik_private.validate_shape(p_request);
 rid:=(p_request->>'record_id')::uuid;
 -- The record and each record it links to stay as they are until the save ends: a deletion or a
 -- move waits. Other saves go on.
 perform fabrik_private.hold_records(rid||fabrik_private.link_targets(p_request),false);
 perform fabrik_private.assert_request_scope(p_request,a.actor_id);
 h:=fabrik_private.canonical_request_hash(p_request,a.actor_id,a.accountable_human_id);
 select * into v from fabrik.record_version where request_id=(p_request->>'request_id')::uuid;
 if found then
  if v.executor_actor_id<>a.actor_id or v.request_hash<>h or not fabrik_private.can_read_record(v.record_id) then
   raise exception 'Save retry unavailable or different' using errcode='42501';
  end if;
  return to_jsonb(v)||jsonb_build_object('scope_id',(p_request->>'scope_id')::uuid,'warnings',w);
 end if;
 actions:=fabrik_private.validate_version(p_request);
 if aid is null then
  -- A person approves their own change where they approve others': as an administrator outside a
  -- private scope, or as a private scope's owner in it.
  own:=fabrik_private.scope_owner((p_request->>'scope_id')::uuid);
  if a.actor_kind<>'human' or (own is null and a.authority_class<>'administrator') or (own is not null and a.actor_id<>own) then
   raise exception 'Supply the id of a grant or approval that covers this change' using errcode='42501';
  end if;
  aid:=(fabrik_private.approve_change((p_request->>'request_id')::uuid,a.actor_id,p_request,clock_timestamp()+interval '5 minutes',p_request->>'reason')->>'authorisation_id')::uuid;
 end if;
 perform fabrik_private.hold_approval(aid);
 z:=fabrik_private.assert_authority(p_request,aid,actions);
 select * into oldv from fabrik.record_version where record_id=rid order by change_no desc limit 1;
 -- check_version refused a save from an older version. A save of the same record kept since, while this
 -- one waited for a lock, is refused here.
 if oldv.version_id is distinct from (p_request->>'expected_previous_version_id')::uuid then
  raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
 end if;
 t:=clock_timestamp(); vid:=gen_random_uuid(); vnum:=coalesce(oldv.version_number,0)+1;
 begin
  if oldv.version_id is null then
   insert into fabrik.record(record_id,kind,scope_id,created_by,created_at) values(rid,p_request->>'kind',(p_request->>'scope_id')::uuid,a.actor_id,t);
  end if;
  insert into fabrik.record_version(version_id,record_id,version_number,previous_version_id,change_no,request_id,request_hash,recorded_at,
   executor_actor_id,accountable_human_id,authority_mode,authorisation_id,title,change_reason,payload)
  values(vid,rid,vnum,oldv.version_id,nextval('fabrik.change_no_seq'::regclass),(p_request->>'request_id')::uuid,h,t,
   a.actor_id,a.accountable_human_id,z.mode,z.authorisation_id,p_request->>'title',p_request->>'reason',fabrik_private.with_owner_label(p_request)->'payload') returning * into v;
 exception when unique_violation then
  -- Another save of the same record, or of the same request, finished first.
  get stacked diagnostics k=constraint_name;
  if k in ('record_pkey','record_version_record_id_version_number_key','record_version_request_id_key') then
   raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
  end if;
  raise;
 end;
 perform set_config('fabrik.saving_version',vid::text,true);
 for l in select value from jsonb_array_elements(p_request->'links') loop
  insert into fabrik.version_link(source_version_id,target_version_id,relation,locator,note)
   values(vid,(l->>'target_version_id')::uuid,l->>'relation',l->>'locator',l->>'note');
 end loop;
 perform set_config('fabrik.saving_version','',true);
 if z.mode='explicit_approval' then
  update fabrik.authorisation set consumed_version_id=vid where authorisation_id=z.authorisation_id;
 end if;
 return to_jsonb(v)||jsonb_build_object('scope_id',(p_request->>'scope_id')::uuid,'warnings',w);
end $function$
;

-- Deletes a record's content under an exact approval, used once: a human administrator's, or, in a
-- private scope, its owner's. The actor needs a live grant with delete for the record's kind, unless
-- an administrator outside a private scope.
create or replace function fabrik_private.delete_record(p_request jsonb, p_authorisation_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; z fabrik.authorisation; d fabrik.record_deletion; actions text[]; own uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if jsonb_typeof(p_request) is distinct from 'object' or p_request->>'operation' is distinct from 'delete' then
  raise exception 'A deletion request has operation delete' using errcode='22023';
 end if;
 select * into d from fabrik.record_deletion where request_id=(p_request->>'request_id')::uuid;
 if found then
  if d.executor_actor_id<>a.actor_id or d.record_id::text is distinct from p_request->>'record_id' then
   raise exception 'Deletion retry unavailable or different' using errcode='42501';
  end if;
  return to_jsonb(d);
 end if;
 -- The record waits for the saves under way on it and on records linking to it, and holds off new ones.
 perform fabrik_private.hold_records(array[(p_request->>'record_id')::uuid],true);
 perform fabrik_private.assert_request_scope(p_request,a.actor_id);
 actions:=fabrik_private.validate_deletion(p_request);
 if p_authorisation_id is null then raise exception 'Record deletion needs an approval' using errcode='42501'; end if;
 perform fabrik_private.hold_approval(p_authorisation_id);
 z:=fabrik_private.assert_authority(p_request,p_authorisation_id,actions);
 own:=fabrik_private.scope_owner((p_request->>'scope_id')::uuid);
 if own is not null then
  if z.mode<>'explicit_approval' or z.issued_by_actor_id<>own then
   raise exception 'Record deletion in a private scope needs its owner''s approval' using errcode='42501';
  end if;
 elsif z.mode<>'explicit_approval' or not exists(select 1 from fabrik.actor where actor_id=z.issued_by_actor_id and actor_kind='human' and authority_class='administrator') then
  raise exception 'Record deletion needs a human administrator''s approval' using errcode='42501';
 end if;
 if (own is not null or a.authority_class<>'administrator') and not exists(select 1 from fabrik.authorisation g where g.executor_actor_id=a.actor_id
   and g.scope_id=(p_request->>'scope_id')::uuid and g.mode='standing_permission' and 'delete'=any(g.allowed_actions)
   and p_request->>'kind'=any(g.record_kinds) and (g.record_id is null or g.record_id=(p_request->>'record_id')::uuid)
   and fabrik_private.authority_live(g.authorisation_id)) then
  raise exception 'Action outside authority scope' using errcode='42501';
 end if;
 d:=fabrik_private.erase_record(p_request,z.authorisation_id,a.actor_id,a.accountable_human_id);
 update fabrik.authorisation set consumed_deletion_id=d.deletion_id where authorisation_id=z.authorisation_id;
 return to_jsonb(d);
end $$;

-- Moves the records in a request from fabrik_preview_move, unchanged but for its reason. Refused when
-- anything the preview showed has changed. A person who owns each private scope of the two moves
-- them, and is an administrator where either is not private.
create or replace function fabrik_private.move_records(p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; f jsonb; ids uuid[]; to_scope fabrik.scope; k text; m fabrik.record_move;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or (a.authority_class<>'administrator' and not exists(select 1 from fabrik_private.granting_scopes())) then
  raise exception 'Only a person who is an administrator moves records' using errcode='42501';
 end if;
 perform fabrik_private.require_object(p_request,array['operation','request_id','from_scope_id','from_scope_name','to_scope_id','to_scope_name',
  'records','reason','outside_links','refused','losing_access','gaining_access']);
 if p_request->>'operation' is distinct from 'move' then raise exception 'A move request has operation move' using errcode='22023'; end if;
 foreach k in array array['request_id','from_scope_id','to_scope_id'] loop
  perform fabrik_private.require_text(p_request,k,false,36,true); perform (p_request->>k)::uuid;
 end loop;
 perform fabrik_private.require_array(p_request,'records',10000);
 ids:=array(select (x->>'record_id')::uuid from jsonb_array_elements(p_request->'records') x order by 1);
 select * into m from fabrik.record_move where request_id=(p_request->>'request_id')::uuid limit 1;
 if found then
  if m.executor_actor_id<>a.actor_id or ids is distinct from array(select record_id from fabrik.record_move where request_id=m.request_id order by 1) then
   raise exception 'Move retry unavailable or different' using errcode='42501';
  end if;
  return fabrik_private.move_result(m.request_id);
 end if;
 if jsonb_typeof(p_request->'reason') is distinct from 'string' or btrim(p_request->>'reason')='' then
  raise exception 'Give the reason for the move, as p_reason when previewing it' using errcode='22023';
 end if;
 perform fabrik_private.require_text(p_request,'reason',false,4000,true);
 if cardinality(ids)=0 then raise exception 'Name the records to move' using errcode='22023'; end if;
 select * into to_scope from fabrik.scope where scope_id=(p_request->>'to_scope_id')::uuid and enabled;
 if not found then raise exception 'Scope unavailable' using errcode='42501'; end if;
 -- The records wait for the saves under way on them and on records linking to them, and hold off new ones.
 perform fabrik_private.hold_records(ids,true);
 f:=fabrik_private.move_facts(ids,to_scope.scope_id);
 if not fabrik_private.can_move(a.actor_id,(f->>'from_scope_id')::uuid,to_scope.scope_id) then
  raise exception 'Only the owner of a private scope moves records into or out of it, and only an administrator moves them elsewhere' using errcode='42501';
 end if;
 if f->'from_scope_id' is distinct from p_request->'from_scope_id' or f->'records' is distinct from p_request->'records'
  or f->'outside_links' is distinct from p_request->'outside_links' or f->'refused' is distinct from p_request->'refused'
  or f->'losing_access' is distinct from p_request->'losing_access' or f->'gaining_access' is distinct from p_request->'gaining_access' then
  raise exception 'The move has changed; preview it again' using errcode='23514';
 end if;
 if (f->>'from_scope_id')::uuid=to_scope.scope_id then raise exception 'The records are already in %',to_scope.display_name using errcode='22023'; end if;
 if jsonb_array_length(f->'outside_links')>0 then
  raise exception 'A record outside the move links to or from one in it. Add it to the move, or save a version without the link' using errcode='23514';
 end if;
 if jsonb_array_length(f->'refused')>0 then raise exception 'The preview refuses the move: %',f->'refused' using errcode='23514'; end if;
 return fabrik_private.move_records(p_request,a.actor_id,f);
end $$;

-- Changes a scope's name, its description, or both. The scope is named by its id, code or name.
-- Its id, code and files stay the same. A person who is an administrator renames a scope that is
-- not private, and its owner renames a private one.
create or replace function fabrik_private.rename_scope(p_scope text, p_display_name text default null, p_description text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; sc fabrik.scope; n text:=nullif(btrim(coalesce(p_display_name,'')),''); d text:=nullif(btrim(coalesce(p_description,'')),'');
 clash fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or (a.authority_class<>'administrator' and not exists(select 1 from fabrik_private.granting_scopes())) then
  raise exception 'Only a person who is an administrator renames a scope' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the change, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 sc:=fabrik_private.named_scope(p_scope);
 if sc.is_private then
  if a.actor_id<>sc.owner_actor_id then raise exception 'Only the scope''s owner renames a private scope' using errcode='42501'; end if;
 elsif a.authority_class<>'administrator' then raise exception 'Only a person who is an administrator renames a scope' using errcode='42501'; end if;
 if n is null and d is null then raise exception 'Give the new name, as p_display_name, or the new description, as p_description' using errcode='22023'; end if;
 if length(n)>200 then raise exception 'A scope''s name is at most 200 characters' using errcode='22023'; end if;
 if length(d)>4000 then raise exception 'A scope''s description is at most 4000 characters' using errcode='22023'; end if;
 if n=sc.display_name then n:=null; end if;
 if d=sc.description then d:=null; end if;
 if n is null and d is null then raise exception 'The scope % already has that name and description',sc.display_name using errcode='22023'; end if;
 select * into clash from fabrik.scope x where x.scope_id<>sc.scope_id and lower(n) in (lower(btrim(x.display_name)),lower(x.code)) limit 1;
 if found then
  raise exception 'Another scope has the name or code "%": % (code %)',n,clash.display_name,clash.code using errcode='23505';
 end if;
 return fabrik_private.rename_scope(sc.scope_id,n,d,a.actor_id,btrim(p_reason));
end $$;

-- Deletes a scope that holds no record and no file, with its grants and bucket. The scope is named
-- by its id, code or name. A person who is an administrator deletes a scope that is not private,
-- and its owner deletes a private one.
create or replace function fabrik_private.delete_scope(p_scope text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; sc fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or (a.authority_class<>'administrator' and not exists(select 1 from fabrik_private.granting_scopes())) then
  raise exception 'Only a person who is an administrator deletes a scope' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the deletion, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 sc:=fabrik_private.named_scope(p_scope);
 if sc.is_private then
  if a.actor_id<>sc.owner_actor_id then raise exception 'Only the scope''s owner deletes a private scope' using errcode='42501'; end if;
 elsif a.authority_class<>'administrator' then raise exception 'Only a person who is an administrator deletes a scope' using errcode='42501'; end if;
 if sc.code in ('general','routines','reference','administration') then
  raise exception 'The scope % is part of fabrik''s setup and is not deleted',sc.display_name using errcode='42501';
 end if;
 return fabrik_private.delete_scope(sc.scope_id,a.actor_id,btrim(p_reason));
end $$;

create or replace function fabrik_private.add_scope(p_code text, p_display_name text, p_description text, p_reason text default null,
 p_private boolean default false, p_owner text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; c text:=btrim(coalesce(p_code,'')); n text:=btrim(coalesce(p_display_name,'')); d text:=btrim(coalesce(p_description,''));
 private boolean:=coalesce(p_private,false); o uuid; people jsonb; clash fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator adds a scope' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the change, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 if not private and p_owner is not null then raise exception 'Only a private scope has an owner' using errcode='22023'; end if;
 if c !~ '^[a-z][a-z0-9_]{0,62}$' then
  raise exception 'A scope''s code is lower case letters, digits and underscores, starting with a letter, at most 63 characters' using errcode='22023';
 end if;
 if private and (c in ('general','routines','reference') or starts_with(c,'sessions_')) then
  raise exception 'The code % is kept for fabrik''s own scopes',c using errcode='22023';
 end if;
 if n='' or length(n)>200 then raise exception 'Give the scope''s name, at most 200 characters, as p_display_name' using errcode='22023'; end if;
 if d='' or length(d)>4000 then raise exception 'Give what the scope covers, at most 4000 characters, as p_description' using errcode='22023'; end if;
 select * into clash from fabrik.scope x where c=x.code or lower(n) in (lower(btrim(x.display_name)),lower(x.code)) limit 1;
 if found then
  raise exception 'Another scope has the name or code "%": % (code %)',case when c=clash.code then c else n end,clash.display_name,clash.code using errcode='23505';
 end if;
 if private then
  if p_owner is null then
   o:=a.actor_id;
  else
   people:=fabrik_private.named_people((select coalesce(jsonb_agg(jsonb_build_object('actor_id',x.actor_id,'display_name',x.display_name)),'[]'::jsonb)
    from fabrik.actor x where x.actor_kind='human' and x.enabled),p_owner);
   if jsonb_array_length(people)=0 then raise exception 'No enabled person has a name with "%"',p_owner using errcode='22023'; end if;
   if jsonb_array_length(people)>1 then
    raise exception 'More than one person fits "%": %',p_owner,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
   end if;
   o:=(people->0->>'actor_id')::uuid;
  end if;
 end if;
 return fabrik_private.add_scope(c,n,d,private,o,a.actor_id,btrim(p_reason));
end $$;

-- Hands a private scope to another person, named by words of their name among the people who can
-- read the whole scope. Only its owner hands it on. Each grant the old owner gave there ends, their
-- own among them, and the new owner holds a full grant.
create or replace function fabrik_private.hand_on_scope(p_scope text, p_person text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; sc fabrik.scope; people jsonb;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for handing the scope on, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 sc:=fabrik_private.named_scope(p_scope);
 if not sc.is_private then raise exception 'Only a private scope is handed on' using errcode='22023'; end if;
 if a.actor_id is distinct from sc.owner_actor_id then raise exception 'Only the scope''s owner hands it on' using errcode='42501'; end if;
 if btrim(coalesce(p_person,''))='' then raise exception 'Name the person to hand the scope to, as p_person' using errcode='22023'; end if;
 people:=fabrik_private.named_people((select coalesce(jsonb_agg(jsonb_build_object('actor_id',x.actor_id,'display_name',x.display_name)),'[]'::jsonb)
  from fabrik.actor x where x.actor_kind='human' and x.enabled and x.actor_id<>a.actor_id
   and fabrik_private.scope_read_for(x.actor_id,sc.scope_id,null,null)),p_person);
 if jsonb_array_length(people)=0 then
  raise exception 'No other person who can read % has a name with "%". Give them read in the scope first, with fabrik_grant_permission',sc.display_name,p_person using errcode='22023';
 end if;
 if jsonb_array_length(people)>1 then
  raise exception 'More than one person fits "%": %',p_person,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
 end if;
 return fabrik_private.hand_on_scope(sc.scope_id,(people->0->>'actor_id')::uuid,a.actor_id,btrim(p_reason));
end $$;

reset role;
revoke create on schema fabrik_private from fabrik_writer;
create or replace function fabrik_private.save_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb default '[]', p_replace boolean default false) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; b text; saver uuid; x jsonb; cls text; rel fabrik.glossary_term; types jsonb:='{}'::jsonb;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb; src text; tgt text;
begin
 a:=fabrik_private.current_actor();
 if to_regprocedure('file_search.save_extraction(uuid,jsonb,jsonb,uuid,text,boolean)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 select v.bucket_id into b from file_search.chunk c join file_search.file_version v on v.version_id=c.version_id where c.chunk_id=p_chunk;
 if b is null or not exists(select 1 from fabrik.scope where code=b) or b not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Chunk unavailable: no chunk with the id "%" in a scope you may read',p_chunk using errcode='42501';
 end if;
 if b not in (select fabrik_storage.usable_buckets('create')) then
  raise exception 'Saving a chunk''s entities and relations needs create permission in its scope' using errcode='42501';
 end if;
 if coalesce(p_replace,false) then
  select x.saved_by into saver from file_search.chunk_extraction x where x.chunk_id=p_chunk;
  if saver is not null and saver<>a.actor_id and a.authority_class<>'administrator' then
   raise exception 'Only the actor who saved this chunk''s entities and relations, or an administrator, may replace them: %',fabrik_private.actor_name(saver) using errcode='42501';
  end if;
 end if;
 if jsonb_typeof(coalesce(p_entities,'[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_relations,'[]'::jsonb))<>'array' then
  raise exception 'Entities and relations are each a list' using errcode='22023';
 end if;
 for x in select value from jsonb_array_elements(coalesce(p_entities,'[]'::jsonb)) loop
  cls:=(select g.term from fabrik.glossary_term g where g.kind='class' and lower(g.term)=lower(btrim(coalesce(x->>'type',''))));
  if cls is null then
   raise exception 'The entity "%" has the type "%", which is not a class in the glossary. An entity''s type is one of the classes fabrik_get_unextracted lists',
    x->>'name',coalesce(x->>'type','') using errcode='23514';
  end if;
  ents:=ents||jsonb_build_array(x||jsonb_build_object('type',cls));
  types:=types||jsonb_build_object(file_search.graph_key(x->>'name'),cls);
 end loop;
 for x in select value from jsonb_array_elements(coalesce(p_relations,'[]'::jsonb)) loop
  select g.* into rel from fabrik.glossary_term g where g.kind='relationship' and lower(g.term)=lower(btrim(coalesce(x->>'relationship','')));
  if rel.term is null then
   raise exception 'The relation from "%" to "%" names "%", which is not a relationship in the glossary. A relation names one of the relationships fabrik_get_unextracted lists',
    x->>'source',x->>'target',coalesce(x->>'relationship','') using errcode='23514';
  end if;
  src:=types->>file_search.graph_key(x->>'source'); tgt:=types->>file_search.graph_key(x->>'target');
  if src is not null and tgt is not null and (src<>rel.from_class or tgt<>rel.to_class) then
   raise exception 'The relationship "%" goes from a % to a %, and "%" is a % and "%" a %',rel.term,rel.from_class,rel.to_class,
    x->>'source',src,x->>'target',tgt using errcode='23514';
  end if;
  rels:=rels||jsonb_build_array(x||jsonb_build_object('keywords',jsonb_build_array(rel.term)||case jsonb_typeof(x->'keywords') when 'array' then x->'keywords'
   when 'string' then to_jsonb(string_to_array(x->>'keywords',',')) else '[]'::jsonb end));
 end loop;
 return file_search.save_extraction(p_chunk,ents,rels,a.actor_id,a.display_name,coalesce(p_replace,false));
end $$;
revoke all on function fabrik_private.grant_permission(uuid,uuid,uuid,text[],uuid,text[],timestamptz,text,boolean),
 fabrik_private.grant_permission(uuid,uuid,text[],uuid,text[],timestamptz,text),
 fabrik_private.approve_change(uuid,uuid,jsonb,timestamptz,text),
 fabrik_private.revoke_authorisation(uuid,text),
 fabrik_private.save_version(jsonb,uuid),
 fabrik_private.delete_record(jsonb,uuid),
 fabrik_private.move_records(jsonb),
 fabrik_private.rename_scope(text,text,text,text),
 fabrik_private.delete_scope(text,text),
 fabrik_private.add_scope(text,text,text,text,boolean,text),
 fabrik_private.hand_on_scope(text,text,text),
 fabrik_private.save_extraction(uuid,jsonb,jsonb,boolean) from public, anon, authenticated;

-- Each function that changes data runs its body. On a permission refusal, the body's work is
-- undone, the refusal is logged, and the call answers {"refused": true, "problem": <fabrik's message>}
-- in place of the error. Any other error is raised as before.
grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
CREATE OR REPLACE FUNCTION fabrik.fabrik_grant_permission(p_issuance_request_id uuid, p_executor_id uuid, p_scope_id uuid, p_record_kinds text[], p_record_id uuid, p_actions text[], p_expires_at timestamp with time zone, p_reason text, p_own_records boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare m text; c text;
begin
 return fabrik_private.grant_permission(p_issuance_request_id,p_executor_id,p_scope_id,p_record_kinds,p_record_id,p_actions,p_expires_at,p_reason,p_own_records);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_grant_permission',m,p_scope_id::text,array_to_string(p_record_kinds,', '),p_record_id::text);
end $function$
;

create or replace function fabrik.fabrik_grant_permission(p_issuance_request_id uuid,p_executor_id uuid,p_record_kinds text[],p_record_id uuid,p_actions text[],p_expires_at timestamptz,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_private.grant_permission(p_issuance_request_id,p_executor_id,p_record_kinds,p_record_id,p_actions,p_expires_at,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_grant_permission',m,null,array_to_string(p_record_kinds,', '),p_record_id::text);
end $$;

CREATE OR REPLACE FUNCTION fabrik.fabrik_approve_change(p_issuance_request_id uuid, p_executor_id uuid, p_request jsonb, p_expires_at timestamp with time zone, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare m text; c text;
begin
 return fabrik_private.approve_change(p_issuance_request_id,p_executor_id,p_request,p_expires_at,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_approve_change',m,p_request->>'scope_id',p_request->>'kind',p_request->>'record_id');
end $function$
;

create or replace function fabrik.fabrik_revoke_authorisation(p_authorisation_id uuid,p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_private.revoke_authorisation(p_authorisation_id,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_revoke_authorisation',m,(select z.scope_id::text from fabrik.authorisation z where z.authorisation_id=p_authorisation_id),null,null);
end $$;

CREATE OR REPLACE FUNCTION fabrik.fabrik_save_version(p_request jsonb, p_authorisation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare m text; c text;
begin
 return fabrik_private.save_version(p_request,p_authorisation_id);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_save_version',m,p_request->>'scope_id',p_request->>'kind',p_request->>'record_id');
end $function$
;

create or replace function fabrik.fabrik_delete_record(p_request jsonb, p_authorisation_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.delete_record(p_request,p_authorisation_id);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_delete_record',m,p_request->>'scope_id',p_request->>'kind',p_request->>'record_id');
end $$;

create or replace function fabrik.fabrik_move_records(p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.move_records(p_request);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_move_records',m,p_request->>'from_scope_id',null,null);
end $$;

create or replace function fabrik.fabrik_rename_scope(p_scope text, p_display_name text default null, p_description text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.rename_scope(p_scope,p_display_name,p_description,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_rename_scope',m,p_scope,null,null);
end $$;

create or replace function fabrik.fabrik_delete_scope(p_scope text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.delete_scope(p_scope,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_delete_scope',m,p_scope,null,null);
end $$;

-- Adds a scope, with its private bucket for files. Only a person who is an administrator adds one,
-- giving the reason. The code is lower case letters, digits and underscores, starting with a letter;
-- no other scope may have the same code or name. A private scope's owner is the person named as
-- p_owner, by their id or words of their name, or the administrator themselves; it opens to its
-- owner with a full grant.
create or replace function fabrik.fabrik_add_scope(p_code text, p_display_name text, p_description text, p_reason text default null,
 p_private boolean default false, p_owner text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.add_scope(p_code,p_display_name,p_description,p_reason,p_private,p_owner);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_add_scope',m,null,null,null);
end $$;

create or replace function fabrik.fabrik_hand_on_scope(p_scope text, p_person text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.hand_on_scope(p_scope,p_person,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_hand_on_scope',m,p_scope,null,null);
end $$;

reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_add_scope(text,text,text,text,boolean,text), fabrik.fabrik_hand_on_scope(text,text,text), fabrik.fabrik_find_actors(text) from public, anon;
grant execute on function fabrik.fabrik_add_scope(text,text,text,text,boolean,text), fabrik.fabrik_hand_on_scope(text,text,text), fabrik.fabrik_find_actors(text) to authenticated;
create or replace function fabrik.fabrik_save_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb default '[]', p_replace boolean default false) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_private.save_extraction(p_chunk,p_entities,p_relations,p_replace);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_save_extraction',m,(select v.bucket_id from file_search.chunk c join file_search.file_version v on v.version_id=c.version_id where c.chunk_id=p_chunk),null,null);
end $$;

-- The task functions' bodies, as they were, each under its name without fabrik_. A task function saves
-- through save_version's body, so a refusal raises and undoes all of the task function's saves, and
-- the task function's wrapper alone logs it.
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_writer;
reset role;
set role fabrik_writer;
create or replace function fabrik_task.save_version(p_request jsonb, p_authorisation_id uuid) returns jsonb
language sql volatile security definer set search_path=pg_catalog as $$
 select fabrik_private.save_version(p_request,p_authorisation_id)
$$;
reset role;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_writer;
grant create on schema fabrik_task to fabrik_reader;
create or replace function fabrik_task.save(p_request jsonb, p_actions text[], p_preview boolean) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare g uuid:=fabrik_task.grant_for(p_request,p_actions);
begin
 if coalesce(p_preview,false) then
  perform fabrik_task.check_shape(p_request);
  return jsonb_build_object('preview',true,'request',p_request,'authorisation_id',g,'actions',to_jsonb(p_actions));
 end if;
 if (fabrik.fabrik_get_actor()->>'requires_human_approval')::boolean then
  raise exception 'Every save by this actor needs a person''s approval. Save the preview''s request with an approval, as the fabrik:records skill''s section 5 describes'
   using errcode='42501';
 end if;
 return fabrik_task.save_version(p_request,g);
end $$;

-- Logs a task function's refusal as the signed-in actor.
create or replace function fabrik_task.refused(p_function text, p_problem text, p_scope text, p_kind text, p_record text) returns jsonb
language sql volatile security definer set search_path=pg_catalog as $$
 select fabrik_private.log_refusal(p_function,p_problem,p_scope,p_kind,p_record)
$$;
reset role;
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
create or replace function fabrik_task.add_record(p_scope text, p_kind text, p_title text, p_reason text, p_fields jsonb default '{}',
 p_parent text default null, p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.add((fabrik_task.scope(p_scope)->>'scope_id')::uuid,p_kind,p_title,p_reason,p_fields,
  case when p_parent is not null then fabrik_task.record_id(p_parent,(fabrik_task.scope(p_scope)->>'scope_id')::uuid) end,p_preview)
$$;

create or replace function fabrik_task.change_record(p_record text, p_reason text, p_fields jsonb default '{}', p_title text default null,
 p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.change(fabrik_task.record_id(p_record),p_reason,p_fields,p_title,null,p_preview)
$$;

create or replace function fabrik_task.set_state(p_record text, p_state text, p_reason text, p_note text default null,
 p_preview boolean default false) returns jsonb
language sql set search_path=pg_catalog as $$
 select fabrik_task.change(fabrik_task.record_id(p_record),p_reason,
  jsonb_build_object('state',p_state)||case when p_note is not null then jsonb_build_object('completion_note',p_note) else '{}'::jsonb end,null,null,p_preview)
$$;

create or replace function fabrik_task.link(p_record text, p_target text, p_relation text, p_reason text, p_note text default null,
 p_locator text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record);
begin
 return fabrik_task.change(rid,p_reason,'{}'::jsonb,null,
  fabrik_task.links_with(fabrik_task.latest(rid),fabrik_task.record_id(p_target),p_relation,p_note,p_locator),p_preview);
end $$;

create or replace function fabrik_task.unlink(p_record text, p_target text, p_relation text, p_reason text,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); tid uuid:=fabrik_task.record_id(p_target); r jsonb:=fabrik_task.latest(rid);
 gone jsonb; links jsonb;
begin
 select coalesce(jsonb_agg(m->'link_id'),'[]'::jsonb) into gone from jsonb_array_elements(fabrik_task.version_links((r->'version'->>'version_id')::uuid)) m
 where m->>'relation'=p_relation and m->>'target_record_id'=tid::text;
 if jsonb_array_length(gone)=0 then raise exception 'The record has no % link to that record',p_relation using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',l->'target_version_id','relation',l->'relation','locator',l->'locator','note',l->'note'))
  order by (l->>'link_id')::uuid),'[]'::jsonb) into links
 from jsonb_array_elements(r->'links') l where not gone @> jsonb_build_array(l->'link_id');
 return fabrik_task.change(rid,p_reason,'{}'::jsonb,null,links,p_preview);
end $$;

create or replace function fabrik_task.assign(p_record text, p_person text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); s uuid:=(fabrik_task.latest(rid)->'version'->>'scope_id')::uuid; people jsonb; who jsonb;
begin
 if p_person is null then return fabrik_task.change(rid,p_reason,'{"assignee_actor_id":null}',null,null,p_preview); end if;
 people:=fabrik.fabrik_find_people(s,p_person)->'items';
 if jsonb_array_length(people)>1 then
  select coalesce(jsonb_agg(x),'[]'::jsonb) into who from jsonb_array_elements(people) x where lower(x->>'display_name')=lower(btrim(p_person));
  if jsonb_array_length(who)=1 then people:=who; end if;
 end if;
 if jsonb_array_length(people)=0 then
  raise exception 'No person who can read % has a name with "%". An administrator can give them read in the scope',fabrik_task.scope_name(s),p_person using errcode='22023';
 end if;
 if jsonb_array_length(people)>1 then
  raise exception 'More than one person fits "%": %',p_person,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
 end if;
 return fabrik_task.change(rid,p_reason,jsonb_build_object('assignee_actor_id',people->0->'actor_id'),null,null,p_preview);
end $$;

create or replace function fabrik_task.add_blocker(p_task text, p_title text, p_requirements text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare t jsonb:=fabrik_task.task(fabrik_task.record_id(p_task)); tv jsonb:=t->'record'->'version'; idx text; n int; fields jsonb; b jsonb; tl jsonb;
begin
 if tv->'payload' ? 'index' then
  select coalesce(max(substr(x#>>'{}',length(tv->'payload'->>'index')+3)::int),0)+1 into n from jsonb_array_elements(t->'indexes') x
  where starts_with(x#>>'{}',(tv->'payload'->>'index')||'-B') and substr(x#>>'{}',length(tv->'payload'->>'index')+3) ~ '^[0-9]{1,6}$';
  idx:=(tv->'payload'->>'index')||'-B'||n;
 end if;
 if btrim(coalesce(p_requirements,''))='' then raise exception 'Give the blocker''s requirements: what clears it' using errcode='22023'; end if;
 fields:=jsonb_build_object('task_type','blocker','completion_requirements',p_requirements)||case when idx is not null then jsonb_build_object('index',idx) else '{}'::jsonb end
  ||case when tv->'payload' ? 'owner_actor_id' then jsonb_build_object('owner_actor_id',tv->'payload'->'owner_actor_id') else '{}'::jsonb end;
 if coalesce(p_preview,false) then
  return jsonb_build_object('preview',true,'saves',jsonb_build_array(
   jsonb_build_object('new_record',p_title,'kind','activity','fields',fields,'parent',t->'plan_id'),
   jsonb_build_object('record',tv->'title','depends_on',p_title,'blockers_add',p_title)));
 end if;
 b:=fabrik_task.add((tv->>'scope_id')::uuid,'activity',p_title,p_reason,fields,(t->>'plan_id')::uuid,false);
 tl:=fabrik_task.request_links(t->'record')||jsonb_build_array(jsonb_build_object('target_version_id',b->'version_id','relation','depends_on'));
 return jsonb_build_object('blocker',b,'task',fabrik_task.change((tv->>'record_id')::uuid,p_reason,
  jsonb_build_object('blockers',(tv->'payload'->'blockers')||jsonb_build_array(jsonb_build_object('blocker_id',b->'record_id','description',p_title))),null,tl,false));
end $$;

create or replace function fabrik_task.add_deliverable(p_task text, p_title text, p_requirements text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare t jsonb:=fabrik_task.task(fabrik_task.record_id(p_task)); tv jsonb:=t->'record'->'version'; idx text; last text; fields jsonb; d jsonb; tl jsonb;
begin
 if tv->'payload' ? 'index' then
  select max(right(x#>>'{}',1)) into last from jsonb_array_elements(t->'indexes') x
  where length(x#>>'{}')=length(tv->'payload'->>'index')+1 and starts_with(x#>>'{}',tv->'payload'->>'index') and right(x#>>'{}',1) between 'a' and 'z';
  if last='z' then raise exception 'The task has deliverables a to z' using errcode='22023'; end if;
  idx:=(tv->'payload'->>'index')||coalesce(chr(ascii(last)+1),'a');
 end if;
 fields:=jsonb_build_object('task_type','deliverable','completion_requirements',coalesce(p_requirements,''))
  ||case when idx is not null then jsonb_build_object('index',idx) else '{}'::jsonb end
  ||case when tv->'payload' ? 'owner_actor_id' then jsonb_build_object('owner_actor_id',tv->'payload'->'owner_actor_id') else '{}'::jsonb end;
 if coalesce(p_preview,false) then
  return jsonb_build_object('preview',true,'saves',jsonb_build_array(
   jsonb_build_object('new_record',p_title,'kind','activity','fields',fields,'parent',t->'plan_id'),
   jsonb_build_object('record',tv->'title','depends_on',p_title)));
 end if;
 d:=fabrik_task.add((tv->>'scope_id')::uuid,'activity',p_title,p_reason,fields,(t->>'plan_id')::uuid,false);
 tl:=fabrik_task.request_links(t->'record')||jsonb_build_array(jsonb_build_object('target_version_id',d->'version_id','relation','depends_on'));
 return jsonb_build_object('deliverable',d,'task',fabrik_task.change((tv->>'record_id')::uuid,p_reason,'{}'::jsonb,null,tl,false));
end $$;

create or replace function fabrik_task.clear_blocker(p_blocker text, p_note text, p_evidence text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare bid uuid:=fabrik_task.record_id(p_blocker); bv jsonb:=fabrik_task.latest(bid)->'version'; st text; tasks jsonb; x jsonb; saves jsonb:='[]'::jsonb;
 eid uuid; ev jsonb;
begin
 if bv->'payload'->>'task_type' is distinct from 'blocker' then raise exception 'Name a blocker' using errcode='22023'; end if;
 st:=case bv->'payload'->>'state' when 'planned' then 'pending' when 'active' then 'in_progress' when 'on_hold' then 'paused' else bv->'payload'->>'state' end;
 if st not in ('completed','cancelled') then
  if btrim(coalesce(p_note,''))='' then raise exception 'Give the completion note: how the blocker was cleared' using errcode='22023'; end if;
  eid:=fabrik_task.record_id(p_evidence);
  ev:=fabrik_task.latest(eid)->'version';
  if fabrik_task.kind(ev->'payload') is distinct from 'evidence' then raise exception 'Name the evidence that the blocker is cleared' using errcode='22023'; end if;
 end if;
 select coalesce(jsonb_agg(a order by a->>'record_id'),'[]'::jsonb) into tasks from jsonb_array_elements(fabrik_task.activities((bv->>'scope_id')::uuid)) a
  where a->'payload'->'blockers' @> jsonb_build_array(jsonb_build_object('blocker_id',bid::text));
 if coalesce(p_preview,false) then
  return jsonb_build_object('preview',true,'saves',
   case when st in ('pending','paused') then jsonb_build_array(jsonb_build_object('record',bv->'title','state','in_progress')) else '[]'::jsonb end
   ||case when st not in ('completed','cancelled') then jsonb_build_array(jsonb_build_object('record',bv->'title','state','completed','completion_note',p_note,'supports',ev->'title')) else '[]'::jsonb end
   ||coalesce((select jsonb_agg(jsonb_build_object('record',a->'title','blockers_remove',bv->'title')) from jsonb_array_elements(tasks) a),'[]'::jsonb));
 end if;
 if st in ('pending','paused') then saves:=saves||jsonb_build_array(fabrik_task.change(bid,p_reason,'{"state":"in_progress"}',null,null,false)); end if;
 if st not in ('completed','cancelled') then
  saves:=saves||jsonb_build_array(fabrik_task.change(bid,p_reason,jsonb_build_object('state','completed','completion_note',p_note),null,
   fabrik_task.links_with(fabrik_task.latest(bid),eid,'supports',null,null),false));
 end if;
 for x in select value from jsonb_array_elements(tasks) loop
  saves:=saves||jsonb_build_array(fabrik_task.change((x->>'record_id')::uuid,p_reason,
   jsonb_build_object('blockers',(select coalesce(jsonb_agg(k),'[]'::jsonb) from jsonb_array_elements(fabrik_task.latest((x->>'record_id')::uuid)->'version'->'payload'->'blockers') k
    where k->>'blocker_id'<>bid::text)),null,null,false));
 end loop;
 return jsonb_build_object('saves',saves);
end $$;

create or replace function fabrik_task.set_owner(p_record text, p_person text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); r jsonb:=fabrik_task.latest(rid); s uuid:=(r->'version'->>'scope_id')::uuid; people jsonb; who jsonb;
begin
 if fabrik_task.kind(r->'version'->'payload') is distinct from 'activity' then raise exception 'Only an activity has an owner' using errcode='22023'; end if;
 if btrim(coalesce(p_person,''))='' then raise exception 'Name the person who owns the activity' using errcode='22023'; end if;
 people:=fabrik.fabrik_find_people(s,p_person)->'items';
 if jsonb_array_length(people)>1 then
  select coalesce(jsonb_agg(x),'[]'::jsonb) into who from jsonb_array_elements(people) x where lower(x->>'display_name')=lower(btrim(p_person));
  if jsonb_array_length(who)=1 then people:=who; end if;
 end if;
 if jsonb_array_length(people)=0 then
  raise exception 'No person who can read % has a name with "%". An administrator can give them read in the scope',fabrik_task.scope_name(s),p_person using errcode='22023';
 end if;
 if jsonb_array_length(people)>1 then
  raise exception 'More than one person fits "%": %',p_person,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
 end if;
 return fabrik_task.change(rid,p_reason,jsonb_build_object('owner_actor_id',people->0->'actor_id'),null,null,p_preview);
end $$;

-- Each task function runs its body, and answers a permission refusal as the functions that change
-- data do.
create or replace function fabrik.fabrik_add_record(p_scope text, p_kind text, p_title text, p_reason text, p_fields jsonb default '{}',
 p_parent text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_task.add_record(p_scope,p_kind,p_title,p_reason,p_fields,p_parent,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_task.refused('fabrik_add_record',m,p_scope,p_kind,null);
end $$;

create or replace function fabrik.fabrik_change_record(p_record text, p_reason text, p_fields jsonb default '{}', p_title text default null,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.change_record(p_record,p_reason,p_fields,p_title,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_change_record',m,null,null,coalesce(r::text,p_record));
end $$;

create or replace function fabrik.fabrik_set_state(p_record text, p_state text, p_reason text, p_note text default null,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.set_state(p_record,p_state,p_reason,p_note,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_set_state',m,null,null,coalesce(r::text,p_record));
end $$;

create or replace function fabrik.fabrik_link(p_record text, p_target text, p_relation text, p_reason text, p_note text default null,
 p_locator text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.link(p_record,p_target,p_relation,p_reason,p_note,p_locator,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_link',m,null,null,coalesce(r::text,p_record));
end $$;

create or replace function fabrik.fabrik_unlink(p_record text, p_target text, p_relation text, p_reason text,
 p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.unlink(p_record,p_target,p_relation,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_unlink',m,null,null,coalesce(r::text,p_record));
end $$;

create or replace function fabrik.fabrik_assign(p_record text, p_person text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.assign(p_record,p_person,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_assign',m,null,null,coalesce(r::text,p_record));
end $$;

create or replace function fabrik.fabrik_add_blocker(p_task text, p_title text, p_requirements text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.add_blocker(p_task,p_title,p_requirements,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_task); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_add_blocker',m,null,null,coalesce(r::text,p_task));
end $$;

create or replace function fabrik.fabrik_add_deliverable(p_task text, p_title text, p_requirements text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.add_deliverable(p_task,p_title,p_requirements,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_task); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_add_deliverable',m,null,null,coalesce(r::text,p_task));
end $$;

create or replace function fabrik.fabrik_clear_blocker(p_blocker text, p_note text, p_evidence text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.clear_blocker(p_blocker,p_note,p_evidence,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_blocker); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_clear_blocker',m,null,null,coalesce(r::text,p_blocker));
end $$;

create or replace function fabrik.fabrik_set_owner(p_record text, p_person text, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.set_owner(p_record,p_person,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_set_owner',m,null,null,coalesce(r::text,p_record));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on function fabrik_task.refused(text,text,text,text,text), fabrik_task.save_version(jsonb,uuid), fabrik_task.add_record(text,text,text,text,jsonb,text,boolean), fabrik_task.change_record(text,text,jsonb,text,boolean), fabrik_task.set_state(text,text,text,text,boolean), fabrik_task.link(text,text,text,text,text,text,boolean), fabrik_task.unlink(text,text,text,text,boolean), fabrik_task.assign(text,text,text,boolean), fabrik_task.add_blocker(text,text,text,text,boolean), fabrik_task.add_deliverable(text,text,text,text,boolean), fabrik_task.clear_blocker(text,text,text,text,boolean), fabrik_task.set_owner(text,text,text,boolean) from public, anon;
grant execute on function fabrik_task.refused(text,text,text,text,text), fabrik_task.save_version(jsonb,uuid), fabrik_task.add_record(text,text,text,text,jsonb,text,boolean), fabrik_task.change_record(text,text,jsonb,text,boolean), fabrik_task.set_state(text,text,text,text,boolean), fabrik_task.link(text,text,text,text,text,text,boolean), fabrik_task.unlink(text,text,text,text,boolean), fabrik_task.assign(text,text,text,boolean), fabrik_task.add_blocker(text,text,text,text,boolean), fabrik_task.add_deliverable(text,text,text,text,boolean), fabrik_task.clear_blocker(text,text,text,text,boolean), fabrik_task.set_owner(text,text,text,boolean) to authenticated;

notify pgrst, 'reload schema';

-- ===================================================================
-- 8u. Access templates live in fabrik.
-- ===================================================================
-- An access template is a named set of grants: its code, description, authority class and grants.
-- Each grant names a scope by its code, its record kinds, its actions and whether it is limited to
-- the person's own records. Every signed-in actor reads the templates. Only a person who is an
-- administrator changes one, giving a reason, and each change is logged with the old and new grants.
set role fabrik_owner;
create table if not exists fabrik.access_template (
 code text primary key check (code ~ '^[a-z][a-z0-9_]{0,62}$'),
 description text not null check (length(btrim(description)) between 1 and 4000),
 authority_class text not null check (authority_class in ('restricted','administrator')),
 grants jsonb not null default '[]'::jsonb check (jsonb_typeof(grants)='array'),
 changed_at timestamptz not null default clock_timestamp(),
 changed_by_actor_id uuid references fabrik.actor(actor_id)
);
create index if not exists access_template_actor_idx on fabrik.access_template(changed_by_actor_id);
alter table fabrik.access_template enable row level security;
revoke all on fabrik.access_template from public;

-- Each change to an access template: its code, its description, authority class and grants before
-- (null for a new template) and after, who changed it, when and why. Append-only, written only by
-- fabrik_private.save_access_template.
create table if not exists fabrik.access_template_change (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 code text not null,
 old_value jsonb,
 new_value jsonb not null,
 changed_by_actor_id uuid not null references fabrik.actor(actor_id),
 reason text not null check (length(btrim(reason)) between 1 and 4000)
);
create index if not exists access_template_change_actor_idx on fabrik.access_template_change(changed_by_actor_id);
create index if not exists access_template_change_time_idx on fabrik.access_template_change(at desc);
alter table fabrik.access_template_change enable row level security;
revoke all on fabrik.access_template_change from public;
grant select on fabrik.access_template_change to fabrik_reader;
drop policy if exists access_template_change_reader_read on fabrik.access_template_change;
create policy access_template_change_reader_read on fabrik.access_template_change for select to fabrik_reader using (true);

create or replace function fabrik_private.guard_access_template_change()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 raise exception 'The access template log is append-only' using errcode='23514';
end $$;
revoke all on function fabrik_private.guard_access_template_change() from public, anon, authenticated;
drop trigger if exists access_template_change_immutable on fabrik.access_template_change;
create trigger access_template_change_immutable before update or delete on fabrik.access_template_change
 for each row execute function fabrik_private.guard_access_template_change();
drop trigger if exists access_template_change_no_truncate on fabrik.access_template_change;
create trigger access_template_change_no_truncate before truncate on fabrik.access_template_change
 for each statement execute function fabrik_private.guard_access_template_change();

-- The template every fabrik starts with: administrator. A template an administrator has already
-- changed stays as it is.
insert into fabrik.access_template(code,description,authority_class,grants) values
 ('administrator','An administrator: administrator authority, which reads and changes every scope''s records with no grant, and keeps scopes and actors.','administrator',
  '[]')
on conflict (code) do nothing;

-- Every template, for any signed-in actor, in code order. Each grant also names its scope.
create or replace function fabrik_private.access_templates() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.current_actor();
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('code',t.code,'description',t.description,'authority_class',t.authority_class,
   'grants',(select coalesce(jsonb_agg(g||jsonb_build_object('scope_name',s.display_name) order by o),'[]'::jsonb)
     from jsonb_array_elements(t.grants) with ordinality x(g,o) left join fabrik.scope s on s.code=g->>'scope'),
   'changed_at',t.changed_at,'changed_by',fabrik_private.actor_name(t.changed_by_actor_id)) order by t.code) from fabrik.access_template t),'[]'::jsonb));
end $$;

-- A template's grants in their stored form, each kind and action once and in fabrik's order, or the
-- error that refuses them: a scope that does not exist, is private or is a sessions scope, an
-- unknown kind or action, or a grant limited to own records that carries delete or lacks read.
create or replace function fabrik_private.template_grants(p_grants jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare g jsonb; sc fabrik.scope; kinds text[]; acts text[]; out jsonb:='[]'::jsonb;
 all_kinds text[]:=array['activity','decision','model','evidence'];
 all_actions text[]:=array['read','create','edit','start','hold','complete','reopen','cancel','decide','delete'];
begin
 if jsonb_typeof(p_grants) is distinct from 'array' then raise exception 'A template''s grants are a list' using errcode='22023'; end if;
 for g in select x from jsonb_array_elements(p_grants) x loop
  if jsonb_typeof(g)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(g) k)<>array['actions','own_records','record_kinds','scope']
   or jsonb_typeof(g->'scope')<>'string' or jsonb_typeof(g->'record_kinds')<>'array' or jsonb_typeof(g->'actions')<>'array'
   or jsonb_typeof(g->'own_records')<>'boolean' then
   raise exception 'Each grant has exactly scope, record_kinds, actions and own_records: %',g using errcode='22023';
  end if;
  select * into sc from fabrik.scope where code=g->>'scope';
  if not found or not sc.enabled then raise exception 'There is no scope with the code %',g->>'scope' using errcode='22023'; end if;
  if sc.is_private or sc.code like 'sessions\_%' then raise exception 'A template names shared scopes only, and % is not one',sc.display_name using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(g->'record_kinds') k where jsonb_typeof(k)<>'string' or not k#>>'{}'=any(all_kinds)) then
   raise exception 'A grant''s record kinds are activity, decision, model and evidence: %',g->'record_kinds' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(g->'actions') k where jsonb_typeof(k)<>'string' or not k#>>'{}'=any(all_actions)) then
   raise exception 'A grant''s actions are %: %',array_to_string(all_actions,', '),g->'actions' using errcode='22023'; end if;
  kinds:=array(select k from unnest(all_kinds) with ordinality u(k,o) where g->'record_kinds' ? k order by o);
  acts:=array(select k from unnest(all_actions) with ordinality u(k,o) where g->'actions' ? k order by o);
  if cardinality(kinds)=0 or cardinality(acts)=0 then raise exception 'A grant names at least one record kind and one action: %',g using errcode='22023'; end if;
  if (g->>'own_records')::boolean and 'delete'=any(acts) then raise exception 'A grant limited to own records does not carry delete' using errcode='22023'; end if;
  if (g->>'own_records')::boolean and not 'read'=any(acts) then raise exception 'A grant limited to own records carries read' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(out) o where o->>'scope'=sc.code and o->'own_records'=g->'own_records') then
   raise exception 'The template has two grants in % that are both % own records',sc.display_name,
    case when (g->>'own_records')::boolean then 'limited to' else 'beyond' end using errcode='22023'; end if;
  out:=out||jsonb_build_array(jsonb_build_object('scope',sc.code,'record_kinds',to_jsonb(kinds),'actions',to_jsonb(acts),'own_records',g->'own_records'));
 end loop;
 return out;
end $$;

-- Adds a template, or changes one's grants, description or authority class, and logs the change. A
-- null leaves that part as it is. Only a person who is an administrator changes a template, and no
-- template names the administration scope.
create or replace function fabrik_private.save_access_template(p_code text, p_grants jsonb, p_description text, p_authority_class text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; o fabrik.access_template; n fabrik.access_template; c text:=lower(btrim(coalesce(p_code,'')));
 old_value jsonb; new_value jsonb;
begin
 a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator changes an access template' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the change, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 if c !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'A template''s code is lower case letters, digits and underscores, starting with a letter' using errcode='22023'; end if;
 lock table fabrik.access_template in share row exclusive mode;
 select * into o from fabrik.access_template where code=c;
 if found then
  n:=o;
  old_value:=jsonb_build_object('description',o.description,'authority_class',o.authority_class,'grants',o.grants);
 elsif p_description is null or p_authority_class is null or p_grants is null then
  raise exception 'A new template needs its description, authority class and grants' using errcode='22023';
 end if;
 n.code:=c;
 n.description:=coalesce(nullif(btrim(coalesce(p_description,'')),''),o.description);
 n.authority_class:=coalesce(p_authority_class,o.authority_class);
 n.grants:=case when p_grants is null then o.grants else fabrik_private.template_grants(p_grants) end;
 -- The setup and access records in Administration are read by administrators alone.
 if exists(select 1 from jsonb_array_elements(n.grants) x where x->>'scope'='administration') then
  raise exception 'Only administrators work in the administration scope, and no template names it' using errcode='22023'; end if;
 if n.description is null or length(n.description)>4000 then raise exception 'A template''s description is 1 to 4000 characters' using errcode='22023'; end if;
 if n.authority_class not in ('restricted','administrator') then raise exception 'A template''s authority class is restricted or administrator' using errcode='22023'; end if;
 if n.authority_class='administrator' and jsonb_array_length(n.grants)>0 then
  raise exception 'The administrator authority class reads and changes every scope, and its template has no grants' using errcode='22023'; end if;
 new_value:=jsonb_build_object('description',n.description,'authority_class',n.authority_class,'grants',n.grants);
 if new_value=old_value then raise exception 'The % access template already has that description, authority class and grants',c using errcode='22023'; end if;
 insert into fabrik.access_template(code,description,authority_class,grants,changed_at,changed_by_actor_id)
 values(c,n.description,n.authority_class,n.grants,clock_timestamp(),a.actor_id)
 on conflict (code) do update set description=excluded.description,authority_class=excluded.authority_class,grants=excluded.grants,
  changed_at=excluded.changed_at,changed_by_actor_id=excluded.changed_by_actor_id;
 insert into fabrik.access_template_change(code,old_value,new_value,changed_by_actor_id,reason) values(c,old_value,new_value,a.actor_id,btrim(p_reason));
 return jsonb_build_object('code',c,'old',old_value,'new',new_value,'changed_at',clock_timestamp(),'changed_by',a.display_name,'reason',btrim(p_reason));
end $$;

-- Issues each grant of a template that the person lacks, approved by p_approver, and gives each grant
-- it issued. A grant is held when the person has a live grant on the whole of its scope with each of
-- its record kinds and actions, limited to own records only where the template's grant is. Run as the
-- postgres login, as bootstrap.sql step 3f does, it issues each grant with provision_grant. Called by
-- a signed-in person, through fabrik_apply_access_template, it issues each one as them, and they must be
-- an administrator. A scope the template names and fabrik lacks stops it before any grant.
create or replace function fabrik_private.apply_access_template(p_approver uuid, p_person uuid, p_template text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; t fabrik.access_template; g jsonb; sid uuid; kinds text[]; acts text[]; own boolean; z jsonb;
 issued jsonb:='[]'::jsonb; held int:=0; missing text; approver uuid:=p_approver; signed_in boolean:=fabrik_private.request_auth_uid() is not null;
begin
 if signed_in then
  a:=fabrik_private.current_actor();
  if a.actor_kind<>'human' or a.authority_class<>'administrator' then
   raise exception 'Only a person who is an administrator applies an access template' using errcode='42501'; end if;
  if approver is not null and approver<>a.actor_id then
   raise exception 'A template''s grants are approved by the administrator who applies it' using errcode='42501'; end if;
  approver:=a.actor_id;
 end if;
 select * into t from fabrik.access_template where code=lower(btrim(coalesce(p_template,'')));
 if not found then raise exception 'There is no access template %',p_template using errcode='22023'; end if;
 if not exists(select 1 from fabrik.actor where actor_id=p_person and enabled) then raise exception 'Executor unavailable' using errcode='22023'; end if;
 select string_agg(distinct x->>'scope',', ') into missing from jsonb_array_elements(t.grants) x
  where not exists(select 1 from fabrik.scope s where s.code=x->>'scope' and s.enabled);
 if missing is not null then raise exception 'The % access template names scopes this fabrik lacks: %',t.code,missing using errcode='22023'; end if;
 for g in select x from jsonb_array_elements(t.grants) x loop
  select scope_id into sid from fabrik.scope where code=g->>'scope';
  kinds:=array(select jsonb_array_elements_text(g->'record_kinds'));
  acts:=array(select jsonb_array_elements_text(g->'actions'));
  own:=(g->>'own_records')::boolean;
  if exists(select 1 from fabrik.authorisation z where z.executor_actor_id=p_person and z.scope_id=sid and z.record_id is null
   and z.mode='standing_permission' and z.record_kinds @> kinds and z.allowed_actions @> acts and (own or not z.own_records)
   and fabrik_private.authority_live(z.authorisation_id)) then
   held:=held+1;
   continue;
  end if;
  if signed_in then
   z:=fabrik_private.grant_permission(gen_random_uuid(),p_person,sid,kinds,null,acts,null,'The '||t.code||' access template.',own);
  else
   z:=fabrik_private.provision_grant(approver,gen_random_uuid(),p_person,sid,kinds,null,acts,null,'The '||t.code||' access template.',own);
  end if;
  issued:=issued||jsonb_build_array(jsonb_build_object('authorisation_id',z->'authorisation_id','scope',g->>'scope','record_kinds',g->'record_kinds',
   'actions',g->'actions','own_records',own));
 end loop;
 return jsonb_build_object('template',t.code,'person_id',p_person,'person_name',fabrik_private.actor_name(p_person),'issued',issued,'already_held',held);
end $$;
reset role;
revoke all on function fabrik_private.access_templates(), fabrik_private.template_grants(jsonb),
 fabrik_private.save_access_template(text,jsonb,text,text,text), fabrik_private.apply_access_template(uuid,uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.grant_permission(uuid,uuid,uuid,text[],uuid,text[],timestamptz,text,boolean) to fabrik_owner;
grant execute on function fabrik_private.access_templates(), fabrik_private.save_access_template(text,jsonb,text,text,text),
 fabrik_private.apply_access_template(uuid,uuid,text) to fabrik_writer;

-- The functions actors call. A change refused for want of permission is logged and answered, as the
-- other functions that change data do.
grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
-- Every access template, for any signed-in actor.
create or replace function fabrik.fabrik_get_access_templates() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select fabrik_private.access_templates()
$$;

-- Adds a template, or changes one, with the reason. A null leaves that part as it is.
create or replace function fabrik.fabrik_save_access_template(p_code text, p_grants jsonb default null, p_description text default null,
 p_authority_class text default null, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.save_access_template(p_code,p_grants,p_description,p_authority_class,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_save_access_template',m,null,null,null);
end $$;

-- Issues each grant of the template the person lacks, as the signed-in administrator.
create or replace function fabrik.fabrik_apply_access_template(p_person uuid, p_template text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.apply_access_template(null,p_person,p_template);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_apply_access_template',m,null,null,null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_get_access_templates(), fabrik.fabrik_save_access_template(text,jsonb,text,text,text),
 fabrik.fabrik_apply_access_template(uuid,text) from public, anon;
grant execute on function fabrik.fabrik_get_access_templates(), fabrik.fabrik_save_access_template(text,jsonb,text,text,text),
 fabrik.fabrik_apply_access_template(uuid,text) to authenticated;

-- The audit log gives each change to an access template as access_template_changed, with the old and
-- new grants, to every reader.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- What happened from p_from until p_to, newest first, as far as the caller may read. Each item
-- names its time, event, scope, actor and subject, with the ids that lead to the full entry. A
-- private scope's handing on is scope_handed_on, and an administrator sees no description of a
-- deleted private scope, nor its grants, unless they deleted it. A refused change is change_refused,
-- for the refused actor, an administrator, and a private scope's owner, with the scope only for a
-- reader who can see it. A change to an access template is access_template_changed. A scope's making
-- is scope_created, with the reason it was added.
create or replace function fabrik.fabrik_get_audit(p_from timestamptz, p_to timestamptz, p_cursor text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; c_at bigint; c_key text; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'A period needs a start before its end' using errcode='22023'; end if;
 if p_cursor is not null then
  if p_cursor !~ '^[0-9]+/[a-z]:[0-9a-f-]+$' then raise exception 'Invalid audit cursor' using errcode='22023'; end if;
  c_at:=split_part(p_cursor,'/',1)::bigint; c_key:=split_part(p_cursor,'/',2);
 end if;
 with events as (
  select v.recorded_at at,'v:'||v.version_id::text k,'record_saved' event,r.scope_id,v.executor_actor_id actor_id,v.title subject,v.change_reason reason,
   jsonb_build_object('record_id',v.record_id,'kind',r.kind,'version_id',v.version_id,'version_number',v.version_number,
    'authorisation_id',v.authorisation_id,'accountable_human_id',v.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(v.accountable_human_id)) details
  from fabrik_private.audit_versions(p_from,p_to) v cross join lateral (select v.kind,v.scope_id) r
  union all
  select d.deleted_at,'d:'||d.deletion_id::text,'record_deleted',d.scope_id,d.executor_actor_id,d.kind,d.reason,
   jsonb_build_object('record_id',d.record_id,'kind',d.kind,'deletion_id',d.deletion_id,'authorisation_id',d.authorisation_id,
    'accountable_human_id',d.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(d.accountable_human_id),
    'approved_by_actor_id',z.issued_by_actor_id,'approved_by_name',fabrik_private.actor_name(z.issued_by_actor_id),'content_sha256',d.content_sha256)
  from fabrik.record_deletion d left join fabrik.authorisation z on z.authorisation_id=d.authorisation_id
  where d.deleted_at>=p_from and d.deleted_at<p_to
  union all
  select m.moved_at,'m:'||m.move_id::text,'record_moved',m.to_scope_id,m.executor_actor_id,
   coalesce(case when fabrik_private.can_read_record(m.record_id) then
    (select v.title from fabrik.record_version v where v.record_id=m.record_id order by v.change_no desc limit 1) end,m.kind),m.reason,
   jsonb_build_object('record_id',m.record_id,'kind',m.kind,'move_id',m.move_id,'request_id',m.request_id,
    'from_scope_id',m.from_scope_id,'from_scope_name',fabrik_private.scope_name(m.from_scope_id),
    'to_scope_id',m.to_scope_id,'to_scope_name',fabrik_private.scope_name(m.to_scope_id))
   ||case when a.authority_class='administrator' then jsonb_build_object('losing_access',m.losing_access,'gaining_access',m.gaining_access) else '{}'::jsonb end
  from fabrik.record_move m where m.moved_at>=p_from and m.moved_at<p_to
  union all
  select c.at,'c:'||lpad(c.event_id::text,19,'0'),case when c.field='owner_actor_id' then 'scope_handed_on' else 'scope_renamed' end,c.scope_id,c.changed_by_actor_id,
   case when c.field='owner_actor_id' then fabrik_private.actor_name(c.new_value::uuid) else c.new_value end,c.reason,
   jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value)
   ||case when c.field='owner_actor_id' then jsonb_build_object('old_owner_name',fabrik_private.actor_name(c.old_value::uuid),
    'new_owner_name',fabrik_private.actor_name(c.new_value::uuid)) else '{}'::jsonb end
  from fabrik.scope_change c where c.at>=p_from and c.at<p_to
  union all
  select s.created_at,'o:'||s.scope_id::text,'scope_created',s.scope_id,s.created_by,s.display_name,coalesce(s.created_reason,'Made at setup'),
   jsonb_build_object('code',s.code,'description',s.description,'is_private',s.is_private,'owner_name',fabrik_private.actor_name(s.owner_actor_id))
  from fabrik.scope s where s.created_at>=p_from and s.created_at<p_to
  union all
  select x.at,'x:'||lpad(x.event_id::text,19,'0'),'scope_deleted',null::uuid,x.deleted_by_actor_id,x.display_name,x.reason,
   jsonb_build_object('deleted_scope_id',x.scope_id,'code',x.code,'is_private',x.is_private,
    'description',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.description end,
    'grants_removed',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.grants_removed end)
  from fabrik.scope_deletion x where x.at>=p_from and x.at<p_to
  union all
  select z.issued_at,'g:'||z.authorisation_id::text,case when z.mode='explicit_approval' then 'approval_given' else 'grant_issued' end,z.scope_id,z.issued_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,
    'record_kinds',z.record_kinds,'record_id',z.record_id,'own_records',z.own_records,'expires_at',z.expires_at)
  from fabrik.authorisation z where z.issued_at>=p_from and z.issued_at<p_to
  union all
  select z.revoked_at,'r:'||z.authorisation_id::text,'grant_revoked',z.scope_id,z.revoked_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.revocation_reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds)
  from fabrik.authorisation z where z.revoked_at>=p_from and z.revoked_at<p_to
  union all
  select c.changed_at,'a:'||c.change_id::text,case when c.old_value is null then 'actor_created' else 'actor_changed' end,null::uuid,c.changed_by_actor_id,
   fabrik_private.actor_name(c.actor_id),null::text,
   jsonb_build_object('changed_actor_id',c.actor_id)||case when c.old_value is null then '{}'::jsonb
    else jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value) end
  from fabrik.actor_change c where c.changed_at>=p_from and c.changed_at<p_to and (c.old_value is not null or c.field='actor_id')
  union all
  select f.at,'f:'||lpad(f.event_id::text,19,'0'),'file_'||f.event,f.scope_id,f.actor_id,f.name,null::text,
   jsonb_build_object('object_id',f.object_id,'previous_name',f.previous_name,'attributed_by',f.attributed_by,'login',f.login)
  from fabrik.file_event f where f.at>=p_from and f.at<p_to
  union all
  select s.at,'s:'||lpad(s.event_id::text,19,'0'),s.event,null::uuid,s.actor_id,fabrik_private.actor_name(s.actor_id),null::text,
   jsonb_build_object('session_id',s.session_id,'auth_user_id',s.auth_user_id,'user_agent',s.user_agent,'ip',s.ip)
  from fabrik.sign_in_event s where s.at>=p_from and s.at<p_to
  union all
  select n.at,'n:'||lpad(n.event_id::text,19,'0'),'change_refused',
   case when a.authority_class='administrator' or fabrik_private.can_see_scope(n.scope_id) or fabrik_private.scope_owner(n.scope_id)=a.actor_id then n.scope_id end,
   n.actor_id,n.problem,null::text,
   jsonb_build_object('function',n.function_name,'kind',n.kind,'record_id',n.record_id,'problem',n.problem,'auth_user_id',n.auth_user_id)
  from fabrik.refusal_event n where n.at>=p_from and n.at<p_to
  union all
  select t.at,'t:'||lpad(t.event_id::text,19,'0'),'access_template_changed',null::uuid,t.changed_by_actor_id,t.code,t.reason,
   jsonb_build_object('code',t.code,'old_grants',t.old_value->'grants','new_grants',t.new_value->'grants',
    'old_description',t.old_value->>'description','new_description',t.new_value->>'description',
    'old_authority_class',t.old_value->>'authority_class','new_authority_class',t.new_value->>'authority_class')
  from fabrik.access_template_change t where t.at>=p_from and t.at<p_to),
 keyed as (select e.*,(extract(epoch from e.at)*1000000)::bigint micros from events e),
 page as (select * from keyed where p_cursor is null or (micros,k)<(c_at,c_key) order by micros desc,k desc limit p_limit)
 select jsonb_build_object(
  'items',coalesce(jsonb_agg(jsonb_build_object('at',p.at,'event',p.event,'scope_id',p.scope_id,'scope_name',fabrik_private.scope_name(p.scope_id),
    'actor_id',p.actor_id,'actor_name',fabrik_private.actor_name(p.actor_id),'subject',p.subject,'reason',p.reason)||p.details order by p.micros desc,p.k desc),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(p.micros::text||'/'||p.k order by p.micros,p.k))[1] end) into result
 from page p;
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
notify pgrst, 'reload schema';

-- ===================================================================

-- ===================================================================
-- 8w. A record named by its title, and a read's cutoff, found from the readable records as a set.
-- Upgrade 0002-set-based-lookups, from HED's 0072.
-- ===================================================================
grant create on schema fabrik_private to fabrik_identity;
set role fabrik_identity;
-- The highest change number among the records the current actor may read.
create or replace function fabrik_private.readable_cutoff() returns bigint
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(max(v.change_no),0) from fabrik.record_version v where v.record_id in (select fabrik_private.readable_records())
$$;

-- The record named by its id, or by the exact title of its latest version in any case, among every
-- record the current actor may read that is not deleted. A title is looked up among the readable
-- records whose titles hold its words.
create or replace function fabrik_private.named_record(p_record text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); hits uuid[];
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  if not exists(select 1 from fabrik.record where record_id=t::uuid) or not fabrik_private.can_read_record(t::uuid) then
   raise exception 'Record unavailable: no record has the id %',t using errcode='42501';
  end if;
  return t::uuid;
 end if;
 select array_agg(r.record_id order by r.record_id) into hits from fabrik.record r
  cross join lateral (select v.title from fabrik.record_version v where v.record_id=r.record_id order by v.change_no desc limit 1) lv
  where r.record_id in (select fabrik_private.readable_records(null,null,t,null,null))
   and r.deleted_at is null and lower(btrim(lv.title))=lower(t);
 if cardinality(hits)=1 then return hits[1]; end if;
 if hits is null then raise exception 'Record unavailable: no record has the title "%"',t using errcode='42501'; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, id %s)',t,s.display_name,r.record_id),'; ' order by r.record_id)
   from fabrik.record r join fabrik.scope s using(scope_id) where r.record_id=any(hits)) using errcode='22023';
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_identity;
revoke all on function fabrik_private.readable_cutoff() from public, anon, authenticated;
grant execute on function fabrik_private.readable_cutoff() to fabrik_owner, fabrik_writer, fabrik_reader;

grant create on schema fabrik_private to fabrik_reader;
set role fabrik_reader;
create or replace function fabrik_private.read_cutoff(p_cutoff bigint) returns bigint
language plpgsql stable set search_path=pg_catalog as $$
declare m bigint;
begin
 perform fabrik_private.read_actor();
 m:=fabrik_private.readable_cutoff();
 if p_cutoff is not null and (p_cutoff<0 or p_cutoff>m) then raise exception 'Cutoff outside accessible history' using errcode='22023'; end if;
 return coalesce(p_cutoff,m);
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_reader;

-- Row-level security reads the person's grants a fixed number of times, however many records fabrik
-- holds, and matches each record's scope, kind and creator against them. A version, a deletion and
-- a link are visible when their records are, and a link joins two records in one scope.
set role fabrik_owner;
alter policy record_writer_read on fabrik.record using (exists(select 1 from fabrik_private.read_grants() g
 where g.scope_id=record.scope_id and (g.record_kinds is null or record.kind=any(g.record_kinds))
 and (g.record_id is null or g.record_id=record.record_id)
 and (not g.own_records or fabrik_private.is_own_record(g.actor_id,record.record_id))));
alter policy record_reader_read on fabrik.record using (exists(select 1 from fabrik_private.read_grants() g
 where g.scope_id=record.scope_id and (g.record_kinds is null or record.kind=any(g.record_kinds))
 and (g.record_id is null or g.record_id=record.record_id)
 and (not g.own_records or fabrik_private.is_own_record(g.actor_id,record.record_id))));
alter policy version_writer_read on fabrik.record_version using (exists(select 1 from fabrik.record r where r.record_id=record_version.record_id));
alter policy version_reader_read on fabrik.record_version using (exists(select 1 from fabrik.record r where r.record_id=record_version.record_id));
alter policy deletion_reader_read on fabrik.record_deletion using (exists(select 1 from fabrik.record r where r.record_id=record_deletion.record_id));
alter policy link_writer_read on fabrik.version_link using (exists(select 1 from fabrik.record_version sv join fabrik.record sr on sr.record_id=sv.record_id
 join fabrik.record_version tv on tv.version_id=version_link.target_version_id join fabrik.record tr on tr.record_id=tv.record_id
 where sv.version_id=version_link.source_version_id and sr.scope_id=tr.scope_id));
alter policy link_reader_read on fabrik.version_link using (exists(select 1 from fabrik.record_version sv join fabrik.record sr on sr.record_id=sv.record_id
 join fabrik.record_version tv on tv.version_id=version_link.target_version_id join fabrik.record tr on tr.record_id=tv.record_id
 where sv.version_id=version_link.source_version_id and sr.scope_id=tr.scope_id));
alter policy link_writer_insert on fabrik.version_link with check (exists(select 1 from fabrik.record_version sv join fabrik.record sr on sr.record_id=sv.record_id
 join fabrik.record_version tv on tv.version_id=version_link.target_version_id join fabrik.record tr on tr.record_id=tv.record_id
 where sv.version_id=version_link.source_version_id and sr.scope_id=tr.scope_id));
reset role;

-- ===================================================================
-- 9. The upgrades this build already contains, so a new project has none pending.
-- ===================================================================
-- ===================================================================
-- 8x. A second factor at sign-in, for administrators.
-- ===================================================================
-- One setting: off or administrators. Under administrators, a call signed in with a password alone is refused to each
-- actor whose authority class is administrator: request_auth_uid() gives no caller for it, so each fabrik function, Storage
-- policy and file search policy refuses it. Every other actor keeps its password sign-in. The
-- level of a sign-in is the access token's aal claim: aal2 once the sign-in gave a code from an authenticator app.
-- From HED's upgrade 0109-second-factor.
set role fabrik_owner;
create table if not exists fabrik_private.sign_in_setting (
 only_row boolean primary key default true check (only_row),
 second_factor text not null default 'off' check (second_factor in ('off','administrators')),
 changed_at timestamptz not null default clock_timestamp()
);
insert into fabrik_private.sign_in_setting(second_factor) values('off') on conflict (only_row) do nothing;
revoke all on fabrik_private.sign_in_setting from public, anon, authenticated;
grant select, update on fabrik_private.sign_in_setting to fabrik_writer;

-- Each change of the setting: its old and new value, the reason, the administrator and the time. Append-only.
create table if not exists fabrik.sign_in_setting_change (
 event_id bigint generated always as identity primary key,
 at timestamptz not null default clock_timestamp(),
 old_value text not null check (old_value in ('off','administrators')),
 new_value text not null check (new_value in ('off','administrators')),
 reason text not null check (length(btrim(reason)) between 1 and 4000),
 changed_by_actor_id uuid not null references fabrik.actor(actor_id)
);
create index if not exists sign_in_setting_change_time_idx on fabrik.sign_in_setting_change(at desc);
create index if not exists sign_in_setting_change_actor_idx on fabrik.sign_in_setting_change(changed_by_actor_id);
alter table fabrik.sign_in_setting_change enable row level security;
revoke all on fabrik.sign_in_setting_change from public, anon, authenticated;
grant select on fabrik.sign_in_setting_change to fabrik_writer, fabrik_reader;
grant insert on fabrik.sign_in_setting_change to fabrik_writer;
drop policy if exists sign_in_setting_change_internal on fabrik.sign_in_setting_change;
create policy sign_in_setting_change_internal on fabrik.sign_in_setting_change for all to fabrik_writer using (true) with check (true);
drop policy if exists sign_in_setting_change_reader_read on fabrik.sign_in_setting_change;
create policy sign_in_setting_change_reader_read on fabrik.sign_in_setting_change for select to fabrik_reader using (true);

create or replace function fabrik_private.guard_sign_in_setting_change()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 raise exception 'The second factor log is append-only' using errcode='23514';
end $$;
revoke all on function fabrik_private.guard_sign_in_setting_change() from public, anon, authenticated;
drop trigger if exists sign_in_setting_change_immutable on fabrik.sign_in_setting_change;
create trigger sign_in_setting_change_immutable before update or delete on fabrik.sign_in_setting_change
 for each row execute function fabrik_private.guard_sign_in_setting_change();
drop trigger if exists sign_in_setting_change_no_truncate on fabrik.sign_in_setting_change;
create trigger sign_in_setting_change_no_truncate before truncate on fabrik.sign_in_setting_change
 for each statement execute function fabrik_private.guard_sign_in_setting_change();
reset role;

-- Owned by the postgres login, as request_auth_uid() is. The level of the caller's sign-in: aal2 or aal1.
create or replace function fabrik_private.request_aal()
returns text language sql stable security definer set search_path=pg_catalog
as $$ select case when auth.jwt()->>'aal'='aal2' then 'aal2' else 'aal1' end $$;

-- True when the setting covers the Auth user and the sign-in's level is not aal2.
create or replace function fabrik_private.second_factor_missing(p_auth_user_id uuid, p_aal text)
returns boolean language sql stable security definer set search_path=pg_catalog
as $$
 select p_auth_user_id is not null and p_aal is distinct from 'aal2' and exists(
  select 1 from fabrik_private.sign_in_setting s where s.second_factor='administrators'
   and exists(select 1 from fabrik.actor a where a.auth_user_id=p_auth_user_id and a.authority_class='administrator'))
$$;

-- The caller's Auth user, or null for a sign-in the setting refuses.
create or replace function fabrik_private.request_auth_uid()
returns uuid language sql stable security definer set search_path=pg_catalog
as $$ select case when fabrik_private.second_factor_missing(auth.uid(), fabrik_private.request_aal()) then null else auth.uid() end $$;

revoke all on function fabrik_private.request_aal(), fabrik_private.second_factor_missing(uuid,text), fabrik_private.request_auth_uid() from public, anon, authenticated;
grant execute on function fabrik_private.request_aal(), fabrik_private.request_auth_uid() to fabrik_owner, fabrik_identity, fabrik_writer, fabrik_reader;

-- Sets the second factor. Only a person who is an administrator sets it, with a reason. Turning it on needs the
-- administrator's own sign-in to carry a code, so an administrator with no authenticator app leaves it off.
grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik_private.set_second_factor(p_value text, p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; was text; at_ timestamptz:=clock_timestamp();
begin
 a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator sets the second factor' using errcode='42501';
 end if;
 if p_value is null or p_value not in ('off','administrators') then
  raise exception 'The second factor is off or administrators, as p_value' using errcode='22023';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the change, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 if p_value<>'off' and fabrik_private.request_aal()<>'aal2' then
  raise exception 'Sign in with a code from your authenticator app, then set the second factor' using errcode='22023';
 end if;
 select s.second_factor into was from fabrik_private.sign_in_setting s for update;
 if was=p_value then raise exception 'The second factor is already %',p_value using errcode='22023'; end if;
 update fabrik_private.sign_in_setting set second_factor=p_value, changed_at=at_;
 insert into fabrik.sign_in_setting_change(at,old_value,new_value,reason,changed_by_actor_id) values(at_,was,p_value,btrim(p_reason),a.actor_id);
 return jsonb_build_object('second_factor',p_value,'was',was,'changed_at',at_);
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_writer;
revoke all on function fabrik_private.set_second_factor(text,text) from public, anon, authenticated;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik.fabrik_set_second_factor(p_value text, p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.set_second_factor(p_value,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_set_second_factor',m,null,null,null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_set_second_factor(text,text) from public, anon;
grant execute on function fabrik.fabrik_set_second_factor(text,text) to authenticated;

-- The audit log, with each change of the second factor, as second_factor_set, to administrators.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- What happened from p_from until p_to, newest first, as far as the caller may read. Each item
-- names its time, event, scope, actor and subject, with the ids that lead to the full entry. A
-- private scope's handing on is scope_handed_on, and an administrator sees no description of a
-- deleted private scope, nor its grants, unless they deleted it. A refused change is change_refused,
-- for the refused actor, an administrator, and a private scope's owner, with the scope only for a
-- reader who can see it. A change to an access template is access_template_changed. A scope's making
-- is scope_created, with the reason it was added. A change of the second factor is second_factor_set,
-- for administrators.
create or replace function fabrik.fabrik_get_audit(p_from timestamptz, p_to timestamptz, p_cursor text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; c_at bigint; c_key text; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'A period needs a start before its end' using errcode='22023'; end if;
 if p_cursor is not null then
  if p_cursor !~ '^[0-9]+/[a-z]:[0-9a-f-]+$' then raise exception 'Invalid audit cursor' using errcode='22023'; end if;
  c_at:=split_part(p_cursor,'/',1)::bigint; c_key:=split_part(p_cursor,'/',2);
 end if;
 with events as (
  select v.recorded_at at,'v:'||v.version_id::text k,'record_saved' event,r.scope_id,v.executor_actor_id actor_id,v.title subject,v.change_reason reason,
   jsonb_build_object('record_id',v.record_id,'kind',r.kind,'version_id',v.version_id,'version_number',v.version_number,
    'authorisation_id',v.authorisation_id,'accountable_human_id',v.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(v.accountable_human_id)) details
  from fabrik_private.audit_versions(p_from,p_to) v cross join lateral (select v.kind,v.scope_id) r
  union all
  select d.deleted_at,'d:'||d.deletion_id::text,'record_deleted',d.scope_id,d.executor_actor_id,d.kind,d.reason,
   jsonb_build_object('record_id',d.record_id,'kind',d.kind,'deletion_id',d.deletion_id,'authorisation_id',d.authorisation_id,
    'accountable_human_id',d.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(d.accountable_human_id),
    'approved_by_actor_id',z.issued_by_actor_id,'approved_by_name',fabrik_private.actor_name(z.issued_by_actor_id),'content_sha256',d.content_sha256)
  from fabrik.record_deletion d left join fabrik.authorisation z on z.authorisation_id=d.authorisation_id
  where d.deleted_at>=p_from and d.deleted_at<p_to
  union all
  select m.moved_at,'m:'||m.move_id::text,'record_moved',m.to_scope_id,m.executor_actor_id,
   coalesce(case when fabrik_private.can_read_record(m.record_id) then
    (select v.title from fabrik.record_version v where v.record_id=m.record_id order by v.change_no desc limit 1) end,m.kind),m.reason,
   jsonb_build_object('record_id',m.record_id,'kind',m.kind,'move_id',m.move_id,'request_id',m.request_id,
    'from_scope_id',m.from_scope_id,'from_scope_name',fabrik_private.scope_name(m.from_scope_id),
    'to_scope_id',m.to_scope_id,'to_scope_name',fabrik_private.scope_name(m.to_scope_id))
   ||case when a.authority_class='administrator' then jsonb_build_object('losing_access',m.losing_access,'gaining_access',m.gaining_access) else '{}'::jsonb end
  from fabrik.record_move m where m.moved_at>=p_from and m.moved_at<p_to
  union all
  select c.at,'c:'||lpad(c.event_id::text,19,'0'),case when c.field='owner_actor_id' then 'scope_handed_on' else 'scope_renamed' end,c.scope_id,c.changed_by_actor_id,
   case when c.field='owner_actor_id' then fabrik_private.actor_name(c.new_value::uuid) else c.new_value end,c.reason,
   jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value)
   ||case when c.field='owner_actor_id' then jsonb_build_object('old_owner_name',fabrik_private.actor_name(c.old_value::uuid),
    'new_owner_name',fabrik_private.actor_name(c.new_value::uuid)) else '{}'::jsonb end
  from fabrik.scope_change c where c.at>=p_from and c.at<p_to
  union all
  select s.created_at,'o:'||s.scope_id::text,'scope_created',s.scope_id,s.created_by,s.display_name,coalesce(s.created_reason,'Made at setup'),
   jsonb_build_object('code',s.code,'description',s.description,'is_private',s.is_private,'owner_name',fabrik_private.actor_name(s.owner_actor_id))
  from fabrik.scope s where s.created_at>=p_from and s.created_at<p_to
  union all
  select x.at,'x:'||lpad(x.event_id::text,19,'0'),'scope_deleted',null::uuid,x.deleted_by_actor_id,x.display_name,x.reason,
   jsonb_build_object('deleted_scope_id',x.scope_id,'code',x.code,'is_private',x.is_private,
    'description',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.description end,
    'grants_removed',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.grants_removed end)
  from fabrik.scope_deletion x where x.at>=p_from and x.at<p_to
  union all
  select z.issued_at,'g:'||z.authorisation_id::text,case when z.mode='explicit_approval' then 'approval_given' else 'grant_issued' end,z.scope_id,z.issued_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,
    'record_kinds',z.record_kinds,'record_id',z.record_id,'own_records',z.own_records,'expires_at',z.expires_at)
  from fabrik.authorisation z where z.issued_at>=p_from and z.issued_at<p_to
  union all
  select z.revoked_at,'r:'||z.authorisation_id::text,'grant_revoked',z.scope_id,z.revoked_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.revocation_reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds)
  from fabrik.authorisation z where z.revoked_at>=p_from and z.revoked_at<p_to
  union all
  select c.changed_at,'a:'||c.change_id::text,case when c.old_value is null then 'actor_created' else 'actor_changed' end,null::uuid,c.changed_by_actor_id,
   fabrik_private.actor_name(c.actor_id),null::text,
   jsonb_build_object('changed_actor_id',c.actor_id)||case when c.old_value is null then '{}'::jsonb
    else jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value) end
  from fabrik.actor_change c where c.changed_at>=p_from and c.changed_at<p_to and (c.old_value is not null or c.field='actor_id')
  union all
  select f.at,'f:'||lpad(f.event_id::text,19,'0'),'file_'||f.event,f.scope_id,f.actor_id,f.name,null::text,
   jsonb_build_object('object_id',f.object_id,'previous_name',f.previous_name,'attributed_by',f.attributed_by,'login',f.login)
  from fabrik.file_event f where f.at>=p_from and f.at<p_to
  union all
  select s.at,'s:'||lpad(s.event_id::text,19,'0'),s.event,null::uuid,s.actor_id,fabrik_private.actor_name(s.actor_id),null::text,
   jsonb_build_object('session_id',s.session_id,'auth_user_id',s.auth_user_id,'user_agent',s.user_agent,'ip',s.ip)
  from fabrik.sign_in_event s where s.at>=p_from and s.at<p_to
  union all
  select n.at,'n:'||lpad(n.event_id::text,19,'0'),'change_refused',
   case when a.authority_class='administrator' or fabrik_private.can_see_scope(n.scope_id) or fabrik_private.scope_owner(n.scope_id)=a.actor_id then n.scope_id end,
   n.actor_id,n.problem,null::text,
   jsonb_build_object('function',n.function_name,'kind',n.kind,'record_id',n.record_id,'problem',n.problem,'auth_user_id',n.auth_user_id)
  from fabrik.refusal_event n where n.at>=p_from and n.at<p_to
  union all
  select t.at,'t:'||lpad(t.event_id::text,19,'0'),'access_template_changed',null::uuid,t.changed_by_actor_id,t.code,t.reason,
   jsonb_build_object('code',t.code,'old_grants',t.old_value->'grants','new_grants',t.new_value->'grants',
    'old_description',t.old_value->>'description','new_description',t.new_value->>'description',
    'old_authority_class',t.old_value->>'authority_class','new_authority_class',t.new_value->>'authority_class')
  from fabrik.access_template_change t where t.at>=p_from and t.at<p_to
  union all
  select q2.at,'h:'||lpad(q2.event_id::text,19,'0'),'second_factor_set',null::uuid,q2.changed_by_actor_id,q2.new_value,q2.reason,
   jsonb_build_object('old_value',q2.old_value,'new_value',q2.new_value)
  from fabrik.sign_in_setting_change q2 where q2.at>=p_from and q2.at<p_to and a.authority_class='administrator'),
 keyed as (select e.*,(extract(epoch from e.at)*1000000)::bigint micros from events e),
 page as (select * from keyed where p_cursor is null or (micros,k)<(c_at,c_key) order by micros desc,k desc limit p_limit)
 select jsonb_build_object(
  'items',coalesce(jsonb_agg(jsonb_build_object('at',p.at,'event',p.event,'scope_id',p.scope_id,'scope_name',fabrik_private.scope_name(p.scope_id),
    'actor_id',p.actor_id,'actor_name',fabrik_private.actor_name(p.actor_id),'subject',p.subject,'reason',p.reason)||p.details order by p.micros desc,p.k desc),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(p.micros::text||'/'||p.k order by p.micros,p.k))[1] end) into result
 from page p;
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
notify pgrst, 'reload schema';

-- ===================================================================

-- ===================================================================
-- 8y. The graph reader, off until the business adds its own Anthropic API key.
-- ===================================================================
-- The hosted function graph-reader reads each waiting part of the business's files with Claude, through Anthropic's
-- Message Batches API, every 15 minutes, and saves what it finds as the part's entities and relations, in the name of
-- Graph reader, an application actor with no sign-in. It is off until an administrator keeps the business's own
-- Anthropic API key in the Vault with graph-reader's set_key, so the business decides what goes to Claude, and pays
-- for it. Until then, and in the scopes it leaves out, a person's agent reads parts in the person's own Claude
-- subscription, as before. It reads no private scope's files, no sessions scope's and no Administration file. Each entity's type is one of the glossary's classes and each relation one of its
-- relationships; a finding that fits none is dropped and kept with its reason. fabrik_get_graph_reader says whether it
-- is on and which scopes it reads, and fabrik_get_file_parts gives a file's parts, for a person to correct one. The
-- audit log gives each batch to administrators. From HED's upgrades 0105-graph-reader and 0108-graph-batch-drops.
-- Owned by the postgres login, which owns file search and reads the Vault.

-- Graph reader's actor id, or null before its first save.
create or replace function fabrik_private.graph_reader_id() returns uuid
language sql stable set search_path=pg_catalog as $$
 select x.actor_id from fabrik.actor x
 where x.actor_kind='application' and x.auth_user_id is null and x.display_name='Graph reader' order by x.actor_id limit 1
$$;

-- Graph reader's actor id, made the first time, accountable to the first enabled administrator, who approves it.
create or replace function fabrik_private.graph_reader() returns uuid
language plpgsql volatile set search_path=pg_catalog as $$
declare id uuid:=fabrik_private.graph_reader_id(); admin uuid; previous text;
begin
 if id is not null then return id; end if;
 perform pg_advisory_xact_lock(hashtextextended('fabrik_private.graph_reader',19483));
 id:=fabrik_private.graph_reader_id();
 if id is not null then return id; end if;
 select x.actor_id into admin from fabrik.actor x
 where x.actor_kind='human' and x.authority_class='administrator' and x.enabled order by x.actor_id limit 1;
 if admin is null then raise exception 'fabrik has no administrator yet' using errcode='55000'; end if;
 previous:=current_setting('fabrik.provisioning_actor',true);
 perform set_config('fabrik.provisioning_actor',admin::text,true);
 insert into fabrik.actor(display_name,actor_kind,accountable_human_id,authority_class,requires_human_approval,enabled)
 values('Graph reader','application',admin,'restricted',false,true) returning actor_id into id;
 perform set_config('fabrik.provisioning_actor',coalesce(previous,''),true);
 return id;
end $$;

-- The scopes whose files graph-reader reads, by their buckets' names: every enabled scope except private scopes,
-- sessions scopes and the Administration scope.
create or replace function fabrik_private.graph_reader_buckets() returns text[]
language sql stable set search_path=pg_catalog as $$
 select coalesce(array_agg(s.code order by s.code),'{}') from fabrik.scope s
 where s.enabled and not s.is_private and s.code<>'administration'
  and s.code not like 'sessions\_%'
$$;

-- True once an administrator has kept the business's Anthropic API key in the Vault with graph-reader's set_key.
create or replace function fabrik_private.graph_reader_on() returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from vault.decrypted_secrets where name='anthropic_api_key' and coalesce(decrypted_secret,'')<>'')
$$;

-- A read's entities and relations fitted to the glossary, as fabrik_save_extraction holds a person's: each entity's type
-- is a class, written as the glossary writes it, and each relation names a relationship from an entity of its from
-- class to one of its to class, with the relationship's name among its keywords. A finding that fits none is dropped,
-- with its reason, in place of refusing the part. Lists that are not lists are given back as they came.
create or replace function fabrik_private.fit_glossary(p_entities jsonb, p_relations jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare x jsonb; cls text; rel fabrik.glossary_term; types jsonb:='{}'::jsonb; src text; tgt text;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb; dropped jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(coalesce(p_entities,'null'))<>'array' or jsonb_typeof(coalesce(p_relations,'null'))<>'array' then
  return jsonb_build_object('entities',p_entities,'relations',p_relations,'dropped','[]'::jsonb);
 end if;
 for x in select value from jsonb_array_elements(p_entities) loop
  cls:=(select g.term from fabrik.glossary_term g where g.kind='class' and lower(g.term)=lower(btrim(coalesce(x->>'type',''))));
  if cls is null then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','An entity''s type is not a class in the glossary','item',x));
   continue;
  end if;
  ents:=ents||jsonb_build_array(x||jsonb_build_object('type',cls));
  -- A name given twice keeps its first class, as file search's trim keeps its first entity.
  if not types ? file_search.graph_key(x->>'name') then types:=types||jsonb_build_object(file_search.graph_key(x->>'name'),cls); end if;
 end loop;
 for x in select value from jsonb_array_elements(p_relations) loop
  select g.* into rel from fabrik.glossary_term g where g.kind='relationship' and lower(g.term)=lower(btrim(coalesce(x->>'relationship','')));
  if rel.term is null then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','A relation names no relationship in the glossary','item',x));
   continue;
  end if;
  src:=types->>file_search.graph_key(x->>'source'); tgt:=types->>file_search.graph_key(x->>'target');
  if src is not null and tgt is not null and (src<>rel.from_class or tgt<>rel.to_class) then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','A relation''s ends are not the classes its relationship joins','item',x));
   continue;
  end if;
  rels:=rels||jsonb_build_array(x||jsonb_build_object('keywords',jsonb_build_array(rel.term)||case jsonb_typeof(x->'keywords') when 'array' then x->'keywords' else '[]'::jsonb end));
 end loop;
 return jsonb_build_object('entities',ents,'relations',rels,'dropped',dropped);
end $$;

-- Closes graph-reader's open batch with its results, each read fitted to the glossary, saved under Graph reader.
create or replace function fabrik_private.save_graph_batch(p_batch uuid, p_results jsonb, p_usage jsonb) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare r jsonb; f jsonb; fitted jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(coalesce(p_results,'null'))<>'array' then raise exception 'The results are a list' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(p_results) loop
  if r ? 'entities' then
   f:=fabrik_private.fit_glossary(r->'entities',r->'relations');
   r:=r||jsonb_build_object('entities',f->'entities','relations',f->'relations','dropped',f->'dropped');
  end if;
  fitted:=fitted||jsonb_build_array(r);
 end loop;
 return file_search.close_graph_batch(p_batch,fitted,p_usage,fabrik_private.graph_reader(),'Graph reader');
end $$;

-- Called every 15 minutes by the schedule schedule.sql sets up. Calls graph-reader while a batch is open, or, once
-- the business's key is in the Vault and its glossary has a class, while a part waits and the month's cost is
-- under the cap.
create or replace function fabrik_private.graph_reader_dispatch() returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
declare address text; secret text;
begin
 if to_regprocedure('file_search.graph_has_work(text[])') is null then return false; end if;
 if not fabrik_private.graph_reader_on() then return false; end if;
 if not exists(select 1 from file_search.graph_batch where closed_at is null)
    and not exists(select 1 from fabrik.glossary_term where kind='class') then return false; end if;
 select decrypted_secret into address from vault.decrypted_secrets where name='file_search_project_url';
 select decrypted_secret into secret from vault.decrypted_secrets where name='graph_reader_secret';
 if address is null or secret is null then
  raise exception 'The project address or the graph reader secret is missing from Vault: run schedule.sql' using errcode='55000';
 end if;
 if not file_search.graph_has_work(fabrik_private.graph_reader_buckets()) then return false; end if;
 perform net.http_post(url:=address||'/functions/v1/graph-reader', body:='{}'::jsonb,
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret), timeout_milliseconds:=150000);
 return true;
end $$;

-- Each batch graph-reader sent, and each it closed, with its drops by reason, for the audit log.
create or replace function fabrik_private.graph_batch_events(p_from timestamptz, p_to timestamptz)
returns table(at timestamptz, k text, event text, actor_id uuid, subject text, details jsonb)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if to_regclass('file_search.graph_batch') is null then return; end if;
 return query execute $q$
  select b.sent_at,'b:'||b.batch_id::text,'graph_batch_sent',fabrik_private.graph_reader_id(),
   format('%s parts sent to Claude',cardinality(b.chunks)),
   jsonb_build_object('batch_id',b.batch_id,'api_batch_id',b.api_batch_id,'model',b.model,'parts',cardinality(b.chunks))
  from file_search.graph_batch b where b.sent_at>=$1 and b.sent_at<$2
  union all
  select b.closed_at,'e:'||b.batch_id::text,'graph_batch_saved',fabrik_private.graph_reader_id(),
   format('%s parts saved, %s failed, %s findings dropped',b.saved,b.failed,b.dropped),
   jsonb_build_object('batch_id',b.batch_id,'api_batch_id',b.api_batch_id,'model',b.model,'parts',cardinality(b.chunks),
    'saved',b.saved,'failed',b.failed,'retried',b.retried,'input_tokens',b.input_tokens,'cache_write_tokens',b.cache_write_tokens,
    'cache_read_tokens',b.cache_read_tokens,'output_tokens',b.output_tokens,'cost_usd',b.cost_usd,'problem',b.problem,'dropped',b.dropped,
    'drops',coalesce((select jsonb_object_agg(r.reason,r.n) from (select d.reason,count(*)::int as n from file_search.graph_drop d
     where d.batch_id=b.batch_id group by d.reason) r),'{}'::jsonb))
  from file_search.graph_batch b where b.closed_at>=$1 and b.closed_at<$2 and b.sent_at is not null$q$ using p_from,p_to;
end $$;

revoke all on function fabrik_private.graph_reader_id(), fabrik_private.graph_reader(), fabrik_private.graph_reader_buckets(),
 fabrik_private.graph_reader_on(), fabrik_private.fit_glossary(jsonb,jsonb), fabrik_private.save_graph_batch(uuid,jsonb,jsonb),
 fabrik_private.graph_reader_dispatch(), fabrik_private.graph_batch_events(timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function fabrik_private.graph_reader_id() to fabrik_writer, fabrik_reader;
grant execute on function fabrik_private.graph_batch_events(timestamptz,timestamptz) to fabrik_reader;

-- Whether graph-reader is on, the scopes it reads, and, for an administrator, the month's cost and its cap. An agent
-- reads a part itself only where it is off, or the scope is not one it reads.
create or replace function fabrik.fabrik_get_graph_reader() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; result jsonb; cost jsonb;
begin
 a:=fabrik_private.read_actor();
 result:=jsonb_build_object('on',fabrik_private.graph_reader_on(),
  'scopes',(select coalesce(jsonb_agg(s.code order by s.code),'[]'::jsonb) from unnest(fabrik_private.graph_reader_buckets()) s(code)
   where s.code in (select fabrik_storage.usable_buckets('read'))));
 if a.authority_class='administrator' and to_regclass('file_search.graph_settings') is not null then
  execute 'select jsonb_build_object(''month_cost_usd'',file_search.graph_month_cost(),''monthly_cap_usd'',s.monthly_cap_usd) from file_search.graph_settings s'
   into strict cost;
  result:=result||cost;
 end if;
 return result;
end $$;
revoke all on function fabrik.fabrik_get_graph_reader() from public, anon;
grant execute on function fabrik.fabrik_get_graph_reader() to authenticated;

-- Each part of a file in a scope, from p_from on, with its text and where its graph stands: read, with who saved it;
-- failed, with the reason; in a batch; or waiting. Needs read in the scope. A person reads a part's text and chunk_id
-- here to correct its graph with fabrik_save_extraction.
create or replace function fabrik.fabrik_get_file_parts(p_scope text, p_file text, p_from integer default 0, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare sc fabrik.scope;
begin
 perform fabrik_private.read_actor();
 begin
  sc:=fabrik_private.named_scope(p_scope);
 exception when insufficient_privilege then sc:=null;
 end;
 if sc.code is null or sc.code not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
 end if;
 if to_regprocedure('file_search.file_parts(text,text,integer,integer)') is null then
  raise exception 'File search''s graph reader is not set up yet: apply file search''s upgrade 0003-graph-reader' using errcode='55000';
 end if;
 return jsonb_build_object('scope',sc.display_name,'code',sc.code)||file_search.file_parts(sc.code,p_file,p_from,p_limit);
end $$;
revoke all on function fabrik.fabrik_get_file_parts(text,text,integer,integer) from public, anon;
grant execute on function fabrik.fabrik_get_file_parts(text,text,integer,integer) to authenticated;

-- fabrik_save_extraction, as section 8p holds it, with Graph reader's save replaceable by a person with read and create.
-- Saves the entities and relations the caller's agent read in one chunk, once. Needs read and
-- create in the chunk's scope. Each entity's type is a glossary class, named in any case, and is
-- saved as the glossary names it. Each relation names a glossary relationship, as relationship,
-- from an entity of its from class to one of its to class, and keeps the relationship's name among
-- its keywords. Each entity merges by its normalised name and type, and the save names the caller
-- as the actor who saved it. With p_replace, the actor who saved the chunk's extraction, or an
-- administrator, replaces it, and a person with read and create in the scope replaces Graph reader's.
create or replace function fabrik.fabrik_save_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb default '[]', p_replace boolean default false) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; b text; saver uuid; x jsonb; cls text; rel fabrik.glossary_term; types jsonb:='{}'::jsonb;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb; src text; tgt text;
begin
 a:=fabrik_private.current_actor();
 if to_regprocedure('file_search.save_extraction(uuid,jsonb,jsonb,uuid,text,boolean)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 select v.bucket_id into b from file_search.chunk c join file_search.file_version v on v.version_id=c.version_id where c.chunk_id=p_chunk;
 if b is null or not exists(select 1 from fabrik.scope where code=b) or b not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Chunk unavailable: no chunk with the id "%" in a scope you may read',p_chunk using errcode='42501';
 end if;
 if b not in (select fabrik_storage.usable_buckets('create')) then
  raise exception 'Saving a chunk''s entities and relations needs create permission in its scope' using errcode='42501';
 end if;
 if coalesce(p_replace,false) then
  select x.saved_by into saver from file_search.chunk_extraction x where x.chunk_id=p_chunk;
  if saver is not null and saver<>a.actor_id and a.authority_class<>'administrator' and saver is distinct from fabrik_private.graph_reader_id() then
   raise exception 'Only the actor who saved this chunk''s entities and relations, or an administrator, may replace them: %',fabrik_private.actor_name(saver) using errcode='42501';
  end if;
 end if;
 if jsonb_typeof(coalesce(p_entities,'[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_relations,'[]'::jsonb))<>'array' then
  raise exception 'Entities and relations are each a list' using errcode='22023';
 end if;
 for x in select value from jsonb_array_elements(coalesce(p_entities,'[]'::jsonb)) loop
  cls:=(select g.term from fabrik.glossary_term g where g.kind='class' and lower(g.term)=lower(btrim(coalesce(x->>'type',''))));
  if cls is null then
   raise exception 'The entity "%" has the type "%", which is not a class in the glossary. An entity''s type is one of the classes fabrik_get_unextracted lists',
    x->>'name',coalesce(x->>'type','') using errcode='23514';
  end if;
  ents:=ents||jsonb_build_array(x||jsonb_build_object('type',cls));
  types:=types||jsonb_build_object(file_search.graph_key(x->>'name'),cls);
 end loop;
 for x in select value from jsonb_array_elements(coalesce(p_relations,'[]'::jsonb)) loop
  select g.* into rel from fabrik.glossary_term g where g.kind='relationship' and lower(g.term)=lower(btrim(coalesce(x->>'relationship','')));
  if rel.term is null then
   raise exception 'The relation from "%" to "%" names "%", which is not a relationship in the glossary. A relation names one of the relationships fabrik_get_unextracted lists',
    x->>'source',x->>'target',coalesce(x->>'relationship','') using errcode='23514';
  end if;
  src:=types->>file_search.graph_key(x->>'source'); tgt:=types->>file_search.graph_key(x->>'target');
  if src is not null and tgt is not null and (src<>rel.from_class or tgt<>rel.to_class) then
   raise exception 'The relationship "%" goes from a % to a %, and "%" is a % and "%" a %',rel.term,rel.from_class,rel.to_class,
    x->>'source',src,x->>'target',tgt using errcode='23514';
  end if;
  rels:=rels||jsonb_build_array(x||jsonb_build_object('keywords',jsonb_build_array(rel.term)||case jsonb_typeof(x->'keywords') when 'array' then x->'keywords'
   when 'string' then to_jsonb(string_to_array(x->>'keywords',',')) else '[]'::jsonb end));
 end loop;
 return file_search.save_extraction(p_chunk,ents,rels,a.actor_id,a.display_name,coalesce(p_replace,false));
end $$;

-- The audit log, with each batch graph-reader sent and closed, as graph_batch_sent and graph_batch_saved, to
-- administrators.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- What happened from p_from until p_to, newest first, as far as the caller may read. Each item
-- names its time, event, scope, actor and subject, with the ids that lead to the full entry. A
-- private scope's handing on is scope_handed_on, and an administrator sees no description of a
-- deleted private scope, nor its grants, unless they deleted it. A refused change is change_refused,
-- for the refused actor, an administrator, and a private scope's owner, with the scope only for a
-- reader who can see it. A change to an access template is access_template_changed. A scope's making
-- is scope_created, with the reason it was added. A change of the second factor is second_factor_set,
-- for administrators. Each batch graph-reader sent and closed is graph_batch_sent and graph_batch_saved, for
-- administrators.
create or replace function fabrik.fabrik_get_audit(p_from timestamptz, p_to timestamptz, p_cursor text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; c_at bigint; c_key text; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'A period needs a start before its end' using errcode='22023'; end if;
 if p_cursor is not null then
  if p_cursor !~ '^[0-9]+/[a-z]:[0-9a-f-]+$' then raise exception 'Invalid audit cursor' using errcode='22023'; end if;
  c_at:=split_part(p_cursor,'/',1)::bigint; c_key:=split_part(p_cursor,'/',2);
 end if;
 with events as (
  select v.recorded_at at,'v:'||v.version_id::text k,'record_saved' event,r.scope_id,v.executor_actor_id actor_id,v.title subject,v.change_reason reason,
   jsonb_build_object('record_id',v.record_id,'kind',r.kind,'version_id',v.version_id,'version_number',v.version_number,
    'authorisation_id',v.authorisation_id,'accountable_human_id',v.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(v.accountable_human_id)) details
  from fabrik_private.audit_versions(p_from,p_to) v cross join lateral (select v.kind,v.scope_id) r
  union all
  select d.deleted_at,'d:'||d.deletion_id::text,'record_deleted',d.scope_id,d.executor_actor_id,d.kind,d.reason,
   jsonb_build_object('record_id',d.record_id,'kind',d.kind,'deletion_id',d.deletion_id,'authorisation_id',d.authorisation_id,
    'accountable_human_id',d.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(d.accountable_human_id),
    'approved_by_actor_id',z.issued_by_actor_id,'approved_by_name',fabrik_private.actor_name(z.issued_by_actor_id),'content_sha256',d.content_sha256)
  from fabrik.record_deletion d left join fabrik.authorisation z on z.authorisation_id=d.authorisation_id
  where d.deleted_at>=p_from and d.deleted_at<p_to
  union all
  select m.moved_at,'m:'||m.move_id::text,'record_moved',m.to_scope_id,m.executor_actor_id,
   coalesce(case when fabrik_private.can_read_record(m.record_id) then
    (select v.title from fabrik.record_version v where v.record_id=m.record_id order by v.change_no desc limit 1) end,m.kind),m.reason,
   jsonb_build_object('record_id',m.record_id,'kind',m.kind,'move_id',m.move_id,'request_id',m.request_id,
    'from_scope_id',m.from_scope_id,'from_scope_name',fabrik_private.scope_name(m.from_scope_id),
    'to_scope_id',m.to_scope_id,'to_scope_name',fabrik_private.scope_name(m.to_scope_id))
   ||case when a.authority_class='administrator' then jsonb_build_object('losing_access',m.losing_access,'gaining_access',m.gaining_access) else '{}'::jsonb end
  from fabrik.record_move m where m.moved_at>=p_from and m.moved_at<p_to
  union all
  select c.at,'c:'||lpad(c.event_id::text,19,'0'),case when c.field='owner_actor_id' then 'scope_handed_on' else 'scope_renamed' end,c.scope_id,c.changed_by_actor_id,
   case when c.field='owner_actor_id' then fabrik_private.actor_name(c.new_value::uuid) else c.new_value end,c.reason,
   jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value)
   ||case when c.field='owner_actor_id' then jsonb_build_object('old_owner_name',fabrik_private.actor_name(c.old_value::uuid),
    'new_owner_name',fabrik_private.actor_name(c.new_value::uuid)) else '{}'::jsonb end
  from fabrik.scope_change c where c.at>=p_from and c.at<p_to
  union all
  select s.created_at,'o:'||s.scope_id::text,'scope_created',s.scope_id,s.created_by,s.display_name,coalesce(s.created_reason,'Made at setup'),
   jsonb_build_object('code',s.code,'description',s.description,'is_private',s.is_private,'owner_name',fabrik_private.actor_name(s.owner_actor_id))
  from fabrik.scope s where s.created_at>=p_from and s.created_at<p_to
  union all
  select x.at,'x:'||lpad(x.event_id::text,19,'0'),'scope_deleted',null::uuid,x.deleted_by_actor_id,x.display_name,x.reason,
   jsonb_build_object('deleted_scope_id',x.scope_id,'code',x.code,'is_private',x.is_private,
    'description',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.description end,
    'grants_removed',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.grants_removed end)
  from fabrik.scope_deletion x where x.at>=p_from and x.at<p_to
  union all
  select z.issued_at,'g:'||z.authorisation_id::text,case when z.mode='explicit_approval' then 'approval_given' else 'grant_issued' end,z.scope_id,z.issued_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,
    'record_kinds',z.record_kinds,'record_id',z.record_id,'own_records',z.own_records,'expires_at',z.expires_at)
  from fabrik.authorisation z where z.issued_at>=p_from and z.issued_at<p_to
  union all
  select z.revoked_at,'r:'||z.authorisation_id::text,'grant_revoked',z.scope_id,z.revoked_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.revocation_reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds)
  from fabrik.authorisation z where z.revoked_at>=p_from and z.revoked_at<p_to
  union all
  select c.changed_at,'a:'||c.change_id::text,case when c.old_value is null then 'actor_created' else 'actor_changed' end,null::uuid,c.changed_by_actor_id,
   fabrik_private.actor_name(c.actor_id),null::text,
   jsonb_build_object('changed_actor_id',c.actor_id)||case when c.old_value is null then '{}'::jsonb
    else jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value) end
  from fabrik.actor_change c where c.changed_at>=p_from and c.changed_at<p_to and (c.old_value is not null or c.field='actor_id')
  union all
  select f.at,'f:'||lpad(f.event_id::text,19,'0'),'file_'||f.event,f.scope_id,f.actor_id,f.name,null::text,
   jsonb_build_object('object_id',f.object_id,'previous_name',f.previous_name,'attributed_by',f.attributed_by,'login',f.login)
  from fabrik.file_event f where f.at>=p_from and f.at<p_to
  union all
  select s.at,'s:'||lpad(s.event_id::text,19,'0'),s.event,null::uuid,s.actor_id,fabrik_private.actor_name(s.actor_id),null::text,
   jsonb_build_object('session_id',s.session_id,'auth_user_id',s.auth_user_id,'user_agent',s.user_agent,'ip',s.ip)
  from fabrik.sign_in_event s where s.at>=p_from and s.at<p_to
  union all
  select n.at,'n:'||lpad(n.event_id::text,19,'0'),'change_refused',
   case when a.authority_class='administrator' or fabrik_private.can_see_scope(n.scope_id) or fabrik_private.scope_owner(n.scope_id)=a.actor_id then n.scope_id end,
   n.actor_id,n.problem,null::text,
   jsonb_build_object('function',n.function_name,'kind',n.kind,'record_id',n.record_id,'problem',n.problem,'auth_user_id',n.auth_user_id)
  from fabrik.refusal_event n where n.at>=p_from and n.at<p_to
  union all
  select t.at,'t:'||lpad(t.event_id::text,19,'0'),'access_template_changed',null::uuid,t.changed_by_actor_id,t.code,t.reason,
   jsonb_build_object('code',t.code,'old_grants',t.old_value->'grants','new_grants',t.new_value->'grants',
    'old_description',t.old_value->>'description','new_description',t.new_value->>'description',
    'old_authority_class',t.old_value->>'authority_class','new_authority_class',t.new_value->>'authority_class')
  from fabrik.access_template_change t where t.at>=p_from and t.at<p_to
  union all
  select q2.at,'h:'||lpad(q2.event_id::text,19,'0'),'second_factor_set',null::uuid,q2.changed_by_actor_id,q2.new_value,q2.reason,
   jsonb_build_object('old_value',q2.old_value,'new_value',q2.new_value)
  from fabrik.sign_in_setting_change q2 where q2.at>=p_from and q2.at<p_to and a.authority_class='administrator'
  union all
  select g.at,g.k,g.event,null::uuid,g.actor_id,g.subject,null::text,g.details
  from fabrik_private.graph_batch_events(p_from,p_to) g where a.authority_class='administrator'),
 keyed as (select e.*,(extract(epoch from e.at)*1000000)::bigint micros from events e),
 page as (select * from keyed where p_cursor is null or (micros,k)<(c_at,c_key) order by micros desc,k desc limit p_limit)
 select jsonb_build_object(
  'items',coalesce(jsonb_agg(jsonb_build_object('at',p.at,'event',p.event,'scope_id',p.scope_id,'scope_name',fabrik_private.scope_name(p.scope_id),
    'actor_id',p.actor_id,'actor_name',fabrik_private.actor_name(p.actor_id),'subject',p.subject,'reason',p.reason)||p.details order by p.micros desc,p.k desc),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(p.micros::text||'/'||p.k order by p.micros,p.k))[1] end) into result
 from page p;
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
notify pgrst, 'reload schema';

-- ===================================================================

-- ===================================================================
-- 8z. Private sessions, for named people.
-- ===================================================================
-- Each person's agent uploads the text of every session to the person's sessions scope, and an administrator reads
-- every scope that is not private, so administrators read every person's sessions. An administrator makes one
-- person's sessions scope private, owned by that person, on the business's instruction, with
-- fabrik_make_sessions_private: each grant there ends, and the person holds one grant on evidence, issued in their own
-- name. An administrator then sees the scope's name and owner, and nothing in it. Its owner alone makes it ordinary
-- again, with fabrik_make_sessions_ordinary. fabrik_add_scope makes a private sessions scope for the person its code names.
-- The audit log gives sessions_made_private and sessions_made_ordinary. From HED's upgrade 0084-private-sessions.
set role fabrik_owner;
alter table fabrik.scope_change drop constraint if exists scope_change_field_check;
alter table fabrik.scope_change add constraint scope_change_field_check check (field in ('display_name','description','owner_actor_id','is_private'));

-- The sessions scope a change of privacy in this transaction is changing; set only by
-- fabrik_private.set_sessions_privacy.
create or replace function fabrik_private.changing_privacy() returns uuid
language sql stable set search_path=pg_catalog as $$
 select nullif(current_setting('fabrik.changing_privacy',true),'')::uuid
$$;
reset role;
revoke all on function fabrik_private.changing_privacy() from public, anon, authenticated;
grant execute on function fabrik_private.changing_privacy() to fabrik_writer, fabrik_reader;

-- Who may read which scope changes: whoever reads the scope, and an administrator, of a change to a
-- sessions scope's privacy.
drop policy if exists scope_change_reader_read on fabrik.scope_change;
create policy scope_change_reader_read on fabrik.scope_change for select to fabrik_reader
 using (fabrik_private.scope_read_for((select (fabrik_private.current_actor()).actor_id),scope_id,null,null)
  or (field='is_private' and (select (fabrik_private.current_actor()).authority_class)='administrator'));

set role fabrik_owner;
create or replace function fabrik_private.guard_scope() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 perform fabrik_private.lock_writes();
 if tg_op='DELETE' then
  if current_user='fabrik_owner' and old.scope_id=fabrik_private.deleting_scope() then return old; end if;
  raise exception 'Disable scopes; delete only an empty one, with fabrik_delete_scope' using errcode='23514';
 end if;
 -- A sessions scope becomes private, or ordinary again, only from fabrik_private.set_sessions_privacy.
 if tg_op='UPDATE' and current_user='fabrik_owner' and new.scope_id=fabrik_private.changing_privacy() and starts_with(new.code,'sessions_')
  and row(new.scope_id,new.code,new.created_by,new.created_at,new.created_reason) is not distinct from row(old.scope_id,old.code,old.created_by,old.created_at,old.created_reason) then
  return new;
 end if;
 if tg_op='UPDATE' and row(new.scope_id,new.code,new.created_by,new.created_at,new.created_reason,new.is_private) is distinct from row(old.scope_id,old.code,old.created_by,old.created_at,old.created_reason,old.is_private) then
  raise exception 'Scope identity is fixed' using errcode='23514';
 end if;
 if tg_op='UPDATE' and new.owner_actor_id is distinct from old.owner_actor_id
  and not (current_user='fabrik_owner' and new.scope_id=fabrik_private.handing_on_scope()) then
  raise exception 'A private scope changes owner only when its owner hands it on, with fabrik_hand_on_scope' using errcode='23514';
 end if;
 return new;
end $$;

create or replace function fabrik_private.guard_authorisation() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare a fabrik.actor; own uuid;
begin
 -- Deleting an empty scope deletes its grants and approvals, only from fabrik_private.delete_scope.
 if tg_op='DELETE' and current_user='fabrik_owner' and old.scope_id=fabrik_private.deleting_scope() then return old; end if;
 -- A deletion empties the approval requests that carried its record's content.
 if tg_op='UPDATE' and current_user='fabrik_owner' and fabrik_private.deleting_record() is not null then
  if old.mode='explicit_approval' and fabrik_private.carries_record(old.request_payload,fabrik_private.deleting_record())
   and (to_jsonb(new)-array['request_payload','reason'])=(to_jsonb(old)-array['request_payload','reason'])
   and new.request_payload=fabrik_private.erased_request(old.request_payload,fabrik_private.deleting_record())
   and new.reason=(case when old.request_payload->>'record_id'=fabrik_private.deleting_record()::text then 'Deleted' else old.reason end) then
   return new;
  end if;
  raise exception 'A deletion empties only the approvals that carry its record' using errcode='42501';
 end if;
 -- Handing a private scope on ends each grant and unused approval its old owner gave there, only
 -- from fabrik_private.hand_on_scope.
 if tg_op='UPDATE' and current_user='fabrik_owner' and old.scope_id=fabrik_private.handing_on_scope() then
  if old.revoked_at is null and new.revoked_at is not null and new.revoked_by_actor_id=old.issued_by_actor_id
   and (to_jsonb(new)-array['revoked_at','revoked_by_actor_id','revocation_reason'])=(to_jsonb(old)-array['revoked_at','revoked_by_actor_id','revocation_reason']) then
   return new;
  end if;
  raise exception 'Handing a scope on ends only the grants its old owner gave' using errcode='42501';
 end if;
 -- Making a sessions scope private, or ordinary again, ends each grant there, only from
 -- fabrik_private.set_sessions_privacy. A sessions scope opens to its person with one grant on
 -- evidence, from its owner where it is private and from an administrator where it is not, only from
 -- fabrik_private.open_sessions_for.
 if tg_op in ('INSERT','UPDATE') and current_user='fabrik_owner' and new.scope_id=fabrik_private.changing_privacy() then
  if tg_op='UPDATE' and old.revoked_at is null and new.revoked_at is not null
   and (to_jsonb(new)-array['revoked_at','revoked_by_actor_id','revocation_reason'])=(to_jsonb(old)-array['revoked_at','revoked_by_actor_id','revocation_reason']) then
   return new;
  end if;
  if tg_op='INSERT' and new.executor_actor_id=new.accountable_human_id and new.mode='standing_permission' and new.record_id is null
   and not new.own_records and new.expires_at is null and new.record_kinds=array['evidence']
   and (new.issued_by_actor_id=fabrik_private.scope_owner(new.scope_id)
    or (fabrik_private.scope_owner(new.scope_id) is null and exists(select 1 from fabrik.actor i where i.actor_id=new.issued_by_actor_id
     and i.enabled and i.actor_kind='human' and i.authority_class='administrator'))) then
   return new;
  end if;
  raise exception 'Changing a sessions scope''s privacy ends its grants and opens it to its person alone' using errcode='42501';
 end if;
 -- A private scope opens to its owner with one full grant, issued in their own name, only from
 -- fabrik_private.open_scope_for.
 if tg_op='INSERT' and current_user='fabrik_owner' and new.scope_id=fabrik_private.opening_scope() then
  if new.issued_by_actor_id=fabrik_private.scope_owner(new.scope_id) and new.executor_actor_id=new.issued_by_actor_id
   and new.accountable_human_id=new.issued_by_actor_id and new.mode='standing_permission' and new.record_id is null
   and not new.own_records and new.expires_at is null then
   return new;
  end if;
  raise exception 'A private scope opens with one full grant to its owner' using errcode='42501';
 end if;
 if current_user<>'fabrik_writer' then raise exception 'Use authority functions' using errcode='42501'; end if;
 a:=fabrik_private.acting_actor();
 if tg_op='DELETE' then raise exception 'Authorisations are retained' using errcode='23514'; end if;
 -- In a private scope, its owner gives and ends every grant and approval; elsewhere, an administrator.
 own:=fabrik_private.scope_owner(new.scope_id);
 if tg_op='INSERT' then
  -- A private sessions scope holds its person's own grant alone, so the upload hook finds one
  -- sessions scope for each person.
  if own is not null and exists(select 1 from fabrik.scope s where s.scope_id=new.scope_id and starts_with(s.code,'sessions_')) then
   raise exception 'A private sessions scope holds its person''s own grant alone' using errcode='42501';
  end if;
  if new.issued_by_actor_id<>a.actor_id or (own is null and a.authority_class<>'administrator') or (own is not null and a.actor_id<>own) then
   raise exception '%',case when own is null then 'Administrator issuer required' else 'Only the scope''s owner gives grants and approvals in a private scope' end using errcode='42501';
  end if;
  if not exists(select 1 from fabrik.actor e join fabrik.actor h on h.actor_id=e.accountable_human_id
   where e.actor_id=new.executor_actor_id and h.actor_id=new.accountable_human_id and h.actor_kind='human' and e.enabled and h.enabled) then
   raise exception 'Invalid executor or accountable human' using errcode='23514';
  end if;
  if new.expires_at is null and new.mode='explicit_approval' then
   raise exception 'Exact approval requires expiry' using errcode='23514';
  end if;
  return new;
 end if;
 if (to_jsonb(new)-array['revoked_at','revoked_by_actor_id','revocation_reason','consumed_version_id','consumed_deletion_id'])
   is distinct from (to_jsonb(old)-array['revoked_at','revoked_by_actor_id','revocation_reason','consumed_version_id','consumed_deletion_id']) then
  raise exception 'Authority scope is immutable; revoke and issue another grant' using errcode='23514';
 end if;
 if row(new.revoked_at,new.revoked_by_actor_id,new.revocation_reason) is distinct from row(old.revoked_at,old.revoked_by_actor_id,old.revocation_reason) then
  if (own is null and a.authority_class<>'administrator') or (own is not null and a.actor_id<>own)
   or old.revoked_at is not null or new.revoked_at is null or new.revoked_by_actor_id<>a.actor_id then
   raise exception 'Invalid revocation' using errcode='42501';
  end if;
 end if;
 if new.consumed_version_id is distinct from old.consumed_version_id then
  if old.consumed_version_id is not null or new.consumed_version_id is null or old.mode<>'explicit_approval'
    or new.executor_actor_id<>a.actor_id or not fabrik_private.authority_live(new.authorisation_id)
    or not exists(select 1 from fabrik.record_version where version_id=new.consumed_version_id and authorisation_id=new.authorisation_id and executor_actor_id=a.actor_id) then
   raise exception 'Invalid approval consumption' using errcode='42501';
  end if;
 end if;
 if new.consumed_deletion_id is distinct from old.consumed_deletion_id then
  if old.consumed_deletion_id is not null or old.consumed_version_id is not null or new.consumed_deletion_id is null or old.mode<>'explicit_approval'
    or new.executor_actor_id<>a.actor_id or not fabrik_private.authority_live(new.authorisation_id)
    or not exists(select 1 from fabrik.record_deletion where deletion_id=new.consumed_deletion_id and authorisation_id=new.authorisation_id and executor_actor_id=a.actor_id) then
   raise exception 'Invalid approval consumption' using errcode='42501';
  end if;
 end if;
 return new;
end $$;

-- Opens a sessions scope to its person: one grant on evidence, with read, create, edit and delete,
-- issued by p_issuer, as bootstrap.sql's is. Called only by add_scope and set_sessions_privacy.
create or replace function fabrik_private.open_sessions_for(p_scope uuid, p_person uuid, p_issuer uuid) returns uuid
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare kinds text[]:=array['evidence']; actions text[]:=array['read','create','edit','delete']; req jsonb; g uuid;
begin
 req:=jsonb_build_object('scope_id',p_scope,'operation','grant','executor',p_person,'kinds',kinds,'record',null,'actions',actions,'expiry',null,
  'reason','Their agent keeps the text of each session with them here.');
 perform set_config('fabrik.changing_privacy',p_scope::text,true);
 insert into fabrik.authorisation(scope_id,executor_actor_id,accountable_human_id,issued_by_actor_id,mode,issuance_request_id,issuance_hash,record_kinds,record_id,allowed_actions,own_records,expires_at,reason)
 values(p_scope,p_person,p_person,p_issuer,'standing_permission',gen_random_uuid(),
  encode(sha256(convert_to(jsonb_build_object('format',1,'request',req,'executor',p_person,'human',p_person)::text,'UTF8')),'hex'),
  kinds,null,actions,false,null,'Their agent keeps the text of each session with them here.') returning authorisation_id into g;
 perform set_config('fabrik.changing_privacy','',true);
 return g;
end $$;

-- Adds a scope, with its bucket, and opens a private one to its owner: a private sessions scope
-- with one grant on evidence, and any other with a full grant. fabrik_add_scope calls it after every check.
create or replace function fabrik_private.add_scope(p_code text, p_display_name text, p_description text, p_private boolean, p_owner uuid, p_creator uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare s fabrik.scope; g uuid;
begin
 insert into fabrik.scope(code,display_name,description,created_by,created_reason,is_private,owner_actor_id)
 values(p_code,p_display_name,p_description,p_creator,p_reason,p_private,case when p_private then p_owner end) returning * into s;
 if p_private and starts_with(p_code,'sessions_') then
  g:=fabrik_private.open_sessions_for(s.scope_id,p_owner,p_owner);
 elsif p_private then
  g:=fabrik_private.open_scope_for(s.scope_id,p_owner);
 end if;
 return jsonb_build_object('scope_id',s.scope_id,'code',s.code,'name',s.display_name,'description',s.description,
  'created_at',s.created_at,'created_by',fabrik_private.actor_name(p_creator),'reason',p_reason,
  'is_private',s.is_private,'owner_actor_id',s.owner_actor_id,'owner_name',fabrik_private.actor_name(s.owner_actor_id),'owner_grant_id',g);
end $$;

-- The sessions scopes of a person: the scope whose code names their Auth user id, and each scope
-- whose code starts sessions_ where they hold a live grant with create on the whole scope.
create or replace function fabrik_private.sessions_scopes(p_person uuid) returns setof uuid
language sql stable security definer set search_path=pg_catalog as $$
 select s.scope_id from fabrik.scope s join fabrik.actor p on p.actor_id=p_person
 where s.code='sessions_'||replace(p.auth_user_id::text,'-','')
  or (starts_with(s.code,'sessions_') and exists(select 1 from fabrik.authorisation z where z.scope_id=s.scope_id and z.executor_actor_id=p_person
   and z.mode='standing_permission' and z.record_id is null and not z.own_records and 'create'=any(z.allowed_actions)
   and fabrik_private.authority_live(z.authorisation_id)))
$$;

-- Makes a sessions scope private, owned by p_person, or ordinary again. Ends each grant and unused
-- approval there, opens the scope to p_person with a grant p_issuer gives, and logs the change.
-- make_sessions_private and make_sessions_ordinary call it after every check.
create or replace function fabrik_private.set_sessions_privacy(p_scope uuid, p_private boolean, p_person uuid, p_executor uuid, p_issuer uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare o fabrik.scope; n fabrik.scope; g uuid; ended integer;
begin
 select * into o from fabrik.scope where scope_id=p_scope for update;
 if o.is_private=p_private then
  raise exception 'The scope % is already %',o.display_name,case when p_private then 'private' else 'ordinary' end using errcode='22023';
 end if;
 perform set_config('fabrik.changing_privacy',p_scope::text,true);
 update fabrik.authorisation set revoked_at=clock_timestamp(),revoked_by_actor_id=p_executor,
  revocation_reason=case when p_private then 'The sessions were made private: ' else 'The sessions were made ordinary: ' end||p_reason
 where scope_id=p_scope and revoked_at is null and consumed_version_id is null and consumed_deletion_id is null;
 get diagnostics ended=row_count;
 update fabrik.scope set is_private=p_private,owner_actor_id=case when p_private then p_person end where scope_id=p_scope returning * into n;
 g:=fabrik_private.open_sessions_for(p_scope,p_person,p_issuer);
 perform set_config('fabrik.changing_privacy','',true);
 perform set_config('fabrik.renaming_scope',p_scope::text,true);
 insert into fabrik.scope_change(scope_id,field,old_value,new_value,changed_by_actor_id,reason)
 values(p_scope,'is_private',o.is_private::text,p_private::text,p_executor,p_reason);
 perform set_config('fabrik.renaming_scope','',true);
 return jsonb_build_object('scope_id',n.scope_id,'code',n.code,'name',n.display_name,'is_private',n.is_private,
  'owner_actor_id',n.owner_actor_id,'owner_name',fabrik_private.actor_name(n.owner_actor_id),
  'person_actor_id',p_person,'person_name',fabrik_private.actor_name(p_person),'grants_ended',ended,
  'grant_id',g,'issued_by',fabrik_private.actor_name(p_issuer),
  'changed_at',clock_timestamp(),'changed_by',fabrik_private.actor_name(p_executor),'reason',p_reason);
end $$;
reset role;
revoke all on function fabrik_private.open_sessions_for(uuid,uuid,uuid), fabrik_private.sessions_scopes(uuid),
 fabrik_private.set_sessions_privacy(uuid,boolean,uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function fabrik_private.sessions_scopes(uuid), fabrik_private.set_sessions_privacy(uuid,boolean,uuid,uuid,uuid,text) to fabrik_writer;

grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
-- Checks a new scope and adds it. A private scope's code starts sessions_ only when it names its owner's Auth user id.
create or replace function fabrik_private.add_scope(p_code text, p_display_name text, p_description text, p_reason text default null,
 p_private boolean default false, p_owner text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; c text:=btrim(coalesce(p_code,'')); n text:=btrim(coalesce(p_display_name,'')); d text:=btrim(coalesce(p_description,''));
 private boolean:=coalesce(p_private,false); o uuid; people jsonb; clash fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator adds a scope' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for the change, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 if not private and p_owner is not null then raise exception 'Only a private scope has an owner' using errcode='22023'; end if;
 if c !~ '^[a-z][a-z0-9_]{0,62}$' then
  raise exception 'A scope''s code is lower case letters, digits and underscores, starting with a letter, at most 63 characters' using errcode='22023';
 end if;
 if private and c in ('general','routines','reference') then
  raise exception 'The code % is kept for fabrik''s own scopes',c using errcode='22023';
 end if;
 if n='' or length(n)>200 then raise exception 'Give the scope''s name, at most 200 characters, as p_display_name' using errcode='22023'; end if;
 if d='' or length(d)>4000 then raise exception 'Give what the scope covers, at most 4000 characters, as p_description' using errcode='22023'; end if;
 select * into clash from fabrik.scope x where c=x.code or lower(n) in (lower(btrim(x.display_name)),lower(x.code)) limit 1;
 if found then
  raise exception 'Another scope has the name or code "%": % (code %)',case when c=clash.code then c else n end,clash.display_name,clash.code using errcode='23505';
 end if;
 if private then
  if p_owner is null then
   o:=a.actor_id;
  else
   people:=fabrik_private.named_people((select coalesce(jsonb_agg(jsonb_build_object('actor_id',x.actor_id,'display_name',x.display_name)),'[]'::jsonb)
    from fabrik.actor x where x.actor_kind='human' and x.enabled),p_owner);
   if jsonb_array_length(people)=0 then raise exception 'No enabled person has a name with "%"',p_owner using errcode='22023'; end if;
   if jsonb_array_length(people)>1 then
    raise exception 'More than one person fits "%": %',p_owner,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
   end if;
   o:=(people->0->>'actor_id')::uuid;
  end if;
 end if;
 if private and starts_with(c,'sessions_') and c is distinct from (select 'sessions_'||replace(x.auth_user_id::text,'-','') from fabrik.actor x where x.actor_id=o) then
  raise exception 'The code % is kept for fabrik''s own scopes. A private sessions scope''s code is sessions_ and its owner''s Auth user id with its hyphens removed',c using errcode='22023';
 end if;
 return fabrik_private.add_scope(c,n,d,private,o,a.actor_id,btrim(p_reason));
end $$;

create or replace function fabrik_private.make_sessions_private(p_person text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; people jsonb; p uuid; hits uuid[]; sc fabrik.scope;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then
  raise exception 'Only a person who is an administrator makes a person''s sessions private' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for making the sessions private, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 if btrim(coalesce(p_person,''))='' then raise exception 'Name the person whose sessions are made private, as p_person' using errcode='22023'; end if;
 people:=fabrik_private.named_people((select coalesce(jsonb_agg(jsonb_build_object('actor_id',x.actor_id,'display_name',x.display_name)),'[]'::jsonb)
  from fabrik.actor x where x.actor_kind='human' and x.enabled),p_person);
 if jsonb_array_length(people)=0 then raise exception 'No enabled person has a name with "%"',p_person using errcode='22023'; end if;
 if jsonb_array_length(people)>1 then
  raise exception 'More than one person fits "%": %',p_person,(select string_agg(x->>'display_name',', ') from jsonb_array_elements(people) x) using errcode='22023';
 end if;
 p:=(people->0->>'actor_id')::uuid;
 select array_agg(distinct x) into hits from fabrik_private.sessions_scopes(p) x;
 if hits is null then
  raise exception '% has no sessions scope. Make it as adding the person does',people->0->>'display_name' using errcode='22023';
 end if;
 if cardinality(hits)>1 then
  raise exception '% has more than one sessions scope: %',people->0->>'display_name',
   (select string_agg(format('%s (code %s)',x.display_name,x.code),'; ' order by x.code) from fabrik.scope x where x.scope_id=any(hits)) using errcode='22023';
 end if;
 select * into sc from fabrik.scope where scope_id=hits[1];
 if sc.is_private then raise exception 'The scope % is already private',sc.display_name using errcode='22023'; end if;
 return fabrik_private.set_sessions_privacy(sc.scope_id,true,p,a.actor_id,p,btrim(p_reason));
end $$;

create or replace function fabrik_private.make_sessions_ordinary(p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; sc fabrik.scope; issuer uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 select s.* into sc from fabrik.scope s where s.is_private and s.owner_actor_id=a.actor_id and starts_with(s.code,'sessions_')
  order by s.code='sessions_'||replace(a.auth_user_id::text,'-','') desc, s.code limit 1;
 if not found or a.actor_kind<>'human' then
  raise exception 'Only the owner of a private sessions scope makes it ordinary' using errcode='42501';
 end if;
 if p_reason is null or btrim(p_reason)='' then raise exception 'Give the reason for making the sessions ordinary, as p_reason' using errcode='22023'; end if;
 if length(btrim(p_reason))>4000 then raise exception 'A reason is at most 4000 characters' using errcode='22023'; end if;
 select x.actor_id into issuer from fabrik.actor x
  where x.enabled and x.actor_kind='human' and x.authority_class='administrator'
  order by x.actor_id=sc.created_by desc,
   x.actor_id is not distinct from (select c.changed_by_actor_id from fabrik.scope_change c where c.scope_id=sc.scope_id and c.field='is_private' and c.new_value='true'
    order by c.event_id desc limit 1) desc,
   x.actor_id limit 1;
 if issuer is null then
  raise exception 'fabrik has no enabled administrator to give the grant in %',sc.display_name using errcode='22023';
 end if;
 return fabrik_private.set_sessions_privacy(sc.scope_id,false,a.actor_id,a.actor_id,issuer,btrim(p_reason));
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_writer;
revoke all on function fabrik_private.make_sessions_private(text,text), fabrik_private.make_sessions_ordinary(text) from public, anon, authenticated;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
-- Makes a person's sessions scope private, owned by them, and ends each grant there. Only a person who is an
-- administrator makes it, on the business's instruction.
create or replace function fabrik.fabrik_make_sessions_private(p_person text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.make_sessions_private(p_person,p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_make_sessions_private',m,null,null,null);
end $$;

-- Makes the caller's private sessions scope ordinary again, so administrators read it.
create or replace function fabrik.fabrik_make_sessions_ordinary(p_reason text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.make_sessions_ordinary(p_reason);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_make_sessions_ordinary',m,null,null,null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_make_sessions_private(text,text), fabrik.fabrik_make_sessions_ordinary(text) from public, anon;
grant execute on function fabrik.fabrik_make_sessions_private(text,text), fabrik.fabrik_make_sessions_ordinary(text) to authenticated;

-- The audit log, with each change of a sessions scope's privacy, as sessions_made_private and sessions_made_ordinary.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- What happened from p_from until p_to, newest first, as far as the caller may read. Each item
-- names its time, event, scope, actor and subject, with the ids that lead to the full entry. A
-- private scope's handing on is scope_handed_on, and an administrator sees no description of a
-- deleted private scope, nor its grants, unless they deleted it. A refused change is change_refused,
-- for the refused actor, an administrator, and a private scope's owner, with the scope only for a
-- reader who can see it. A change to an access template is access_template_changed. A scope's making
-- is scope_created, with the reason it was added. A change of the second factor is second_factor_set,
-- for administrators. Each batch graph-reader sent and closed is graph_batch_sent and graph_batch_saved, for
-- administrators.
create or replace function fabrik.fabrik_get_audit(p_from timestamptz, p_to timestamptz, p_cursor text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a fabrik.actor; c_at bigint; c_key text; result jsonb;
begin
 a:=fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1 through 100' using errcode='22023'; end if;
 if p_from is null or p_to is null or p_from>=p_to then raise exception 'A period needs a start before its end' using errcode='22023'; end if;
 if p_cursor is not null then
  if p_cursor !~ '^[0-9]+/[a-z]:[0-9a-f-]+$' then raise exception 'Invalid audit cursor' using errcode='22023'; end if;
  c_at:=split_part(p_cursor,'/',1)::bigint; c_key:=split_part(p_cursor,'/',2);
 end if;
 with events as (
  select v.recorded_at at,'v:'||v.version_id::text k,'record_saved' event,r.scope_id,v.executor_actor_id actor_id,v.title subject,v.change_reason reason,
   jsonb_build_object('record_id',v.record_id,'kind',r.kind,'version_id',v.version_id,'version_number',v.version_number,
    'authorisation_id',v.authorisation_id,'accountable_human_id',v.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(v.accountable_human_id)) details
  from fabrik_private.audit_versions(p_from,p_to) v cross join lateral (select v.kind,v.scope_id) r
  union all
  select d.deleted_at,'d:'||d.deletion_id::text,'record_deleted',d.scope_id,d.executor_actor_id,d.kind,d.reason,
   jsonb_build_object('record_id',d.record_id,'kind',d.kind,'deletion_id',d.deletion_id,'authorisation_id',d.authorisation_id,
    'accountable_human_id',d.accountable_human_id,'accountable_human_name',fabrik_private.actor_name(d.accountable_human_id),
    'approved_by_actor_id',z.issued_by_actor_id,'approved_by_name',fabrik_private.actor_name(z.issued_by_actor_id),'content_sha256',d.content_sha256)
  from fabrik.record_deletion d left join fabrik.authorisation z on z.authorisation_id=d.authorisation_id
  where d.deleted_at>=p_from and d.deleted_at<p_to
  union all
  select m.moved_at,'m:'||m.move_id::text,'record_moved',m.to_scope_id,m.executor_actor_id,
   coalesce(case when fabrik_private.can_read_record(m.record_id) then
    (select v.title from fabrik.record_version v where v.record_id=m.record_id order by v.change_no desc limit 1) end,m.kind),m.reason,
   jsonb_build_object('record_id',m.record_id,'kind',m.kind,'move_id',m.move_id,'request_id',m.request_id,
    'from_scope_id',m.from_scope_id,'from_scope_name',fabrik_private.scope_name(m.from_scope_id),
    'to_scope_id',m.to_scope_id,'to_scope_name',fabrik_private.scope_name(m.to_scope_id))
   ||case when a.authority_class='administrator' then jsonb_build_object('losing_access',m.losing_access,'gaining_access',m.gaining_access) else '{}'::jsonb end
  from fabrik.record_move m where m.moved_at>=p_from and m.moved_at<p_to
  union all
  select c.at,'c:'||lpad(c.event_id::text,19,'0'),case c.field when 'owner_actor_id' then 'scope_handed_on'
    when 'is_private' then case when c.new_value='true' then 'sessions_made_private' else 'sessions_made_ordinary' end else 'scope_renamed' end,c.scope_id,c.changed_by_actor_id,
   case c.field when 'owner_actor_id' then fabrik_private.actor_name(c.new_value::uuid) when 'is_private' then fabrik_private.scope_name(c.scope_id) else c.new_value end,c.reason,
   jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value)
   ||case when c.field='owner_actor_id' then jsonb_build_object('old_owner_name',fabrik_private.actor_name(c.old_value::uuid),
    'new_owner_name',fabrik_private.actor_name(c.new_value::uuid)) else '{}'::jsonb end
  from fabrik.scope_change c where c.at>=p_from and c.at<p_to
  union all
  select s.created_at,'o:'||s.scope_id::text,'scope_created',s.scope_id,s.created_by,s.display_name,coalesce(s.created_reason,'Made at setup'),
   jsonb_build_object('code',s.code,'description',s.description,'is_private',s.is_private,'owner_name',fabrik_private.actor_name(s.owner_actor_id))
  from fabrik.scope s where s.created_at>=p_from and s.created_at<p_to
  union all
  select x.at,'x:'||lpad(x.event_id::text,19,'0'),'scope_deleted',null::uuid,x.deleted_by_actor_id,x.display_name,x.reason,
   jsonb_build_object('deleted_scope_id',x.scope_id,'code',x.code,'is_private',x.is_private,
    'description',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.description end,
    'grants_removed',case when x.is_private and x.deleted_by_actor_id<>a.actor_id then null else x.grants_removed end)
  from fabrik.scope_deletion x where x.at>=p_from and x.at<p_to
  union all
  select z.issued_at,'g:'||z.authorisation_id::text,case when z.mode='explicit_approval' then 'approval_given' else 'grant_issued' end,z.scope_id,z.issued_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,
    'record_kinds',z.record_kinds,'record_id',z.record_id,'own_records',z.own_records,'expires_at',z.expires_at)
  from fabrik.authorisation z where z.issued_at>=p_from and z.issued_at<p_to
  union all
  select z.revoked_at,'r:'||z.authorisation_id::text,'grant_revoked',z.scope_id,z.revoked_by_actor_id,
   fabrik_private.actor_name(z.executor_actor_id),z.revocation_reason,
   jsonb_build_object('authorisation_id',z.authorisation_id,'executor_actor_id',z.executor_actor_id,'allowed_actions',z.allowed_actions,'record_kinds',z.record_kinds)
  from fabrik.authorisation z where z.revoked_at>=p_from and z.revoked_at<p_to
  union all
  select c.changed_at,'a:'||c.change_id::text,case when c.old_value is null then 'actor_created' else 'actor_changed' end,null::uuid,c.changed_by_actor_id,
   fabrik_private.actor_name(c.actor_id),null::text,
   jsonb_build_object('changed_actor_id',c.actor_id)||case when c.old_value is null then '{}'::jsonb
    else jsonb_build_object('field',c.field,'old_value',c.old_value,'new_value',c.new_value) end
  from fabrik.actor_change c where c.changed_at>=p_from and c.changed_at<p_to and (c.old_value is not null or c.field='actor_id')
  union all
  select f.at,'f:'||lpad(f.event_id::text,19,'0'),'file_'||f.event,f.scope_id,f.actor_id,f.name,null::text,
   jsonb_build_object('object_id',f.object_id,'previous_name',f.previous_name,'attributed_by',f.attributed_by,'login',f.login)
  from fabrik.file_event f where f.at>=p_from and f.at<p_to
  union all
  select s.at,'s:'||lpad(s.event_id::text,19,'0'),s.event,null::uuid,s.actor_id,fabrik_private.actor_name(s.actor_id),null::text,
   jsonb_build_object('session_id',s.session_id,'auth_user_id',s.auth_user_id,'user_agent',s.user_agent,'ip',s.ip)
  from fabrik.sign_in_event s where s.at>=p_from and s.at<p_to
  union all
  select n.at,'n:'||lpad(n.event_id::text,19,'0'),'change_refused',
   case when a.authority_class='administrator' or fabrik_private.can_see_scope(n.scope_id) or fabrik_private.scope_owner(n.scope_id)=a.actor_id then n.scope_id end,
   n.actor_id,n.problem,null::text,
   jsonb_build_object('function',n.function_name,'kind',n.kind,'record_id',n.record_id,'problem',n.problem,'auth_user_id',n.auth_user_id)
  from fabrik.refusal_event n where n.at>=p_from and n.at<p_to
  union all
  select t.at,'t:'||lpad(t.event_id::text,19,'0'),'access_template_changed',null::uuid,t.changed_by_actor_id,t.code,t.reason,
   jsonb_build_object('code',t.code,'old_grants',t.old_value->'grants','new_grants',t.new_value->'grants',
    'old_description',t.old_value->>'description','new_description',t.new_value->>'description',
    'old_authority_class',t.old_value->>'authority_class','new_authority_class',t.new_value->>'authority_class')
  from fabrik.access_template_change t where t.at>=p_from and t.at<p_to
  union all
  select q2.at,'h:'||lpad(q2.event_id::text,19,'0'),'second_factor_set',null::uuid,q2.changed_by_actor_id,q2.new_value,q2.reason,
   jsonb_build_object('old_value',q2.old_value,'new_value',q2.new_value)
  from fabrik.sign_in_setting_change q2 where q2.at>=p_from and q2.at<p_to and a.authority_class='administrator'
  union all
  select g.at,g.k,g.event,null::uuid,g.actor_id,g.subject,null::text,g.details
  from fabrik_private.graph_batch_events(p_from,p_to) g where a.authority_class='administrator'),
 keyed as (select e.*,(extract(epoch from e.at)*1000000)::bigint micros from events e),
 page as (select * from keyed where p_cursor is null or (micros,k)<(c_at,c_key) order by micros desc,k desc limit p_limit)
 select jsonb_build_object(
  'items',coalesce(jsonb_agg(jsonb_build_object('at',p.at,'event',p.event,'scope_id',p.scope_id,'scope_name',fabrik_private.scope_name(p.scope_id),
    'actor_id',p.actor_id,'actor_name',fabrik_private.actor_name(p.actor_id),'subject',p.subject,'reason',p.reason)||p.details order by p.micros desc,p.k desc),'[]'::jsonb),
  'next_cursor',case when count(*)=p_limit then (array_agg(p.micros::text||'/'||p.k order by p.micros,p.k))[1] end) into result
 from page p;
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
notify pgrst, 'reload schema';

-- ===================================================================

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- The record that came from another system: the one whose current version's payload.source names the system and
-- the id it had there, among the records the caller may read that are not deleted. Null when there is none. A
-- deleted record's versions are emptied, so it never matches. The first record created wins if two carry one source.
create or replace function fabrik.fabrik_find_by_source(p_system text, p_id text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare found_id uuid;
begin
 perform fabrik_private.read_actor();
 select r.record_id into found_id from fabrik.record_version v join fabrik.record r using(record_id)
 where v.payload->'source' is not null and v.payload->'source'->>'id'=p_id and v.payload->'source'->>'system'=p_system
  and r.deleted_at is null
  and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
  and fabrik_private.can_read_record(r.record_id)
 order by r.created_at,r.record_id limit 1;
 return found_id;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_find_by_source(text,text) from public, anon;
grant execute on function fabrik.fabrik_find_by_source(text,text) to authenticated;
notify pgrst, 'reload schema';

-- Several links from one record, saved as one version. Each is {target, relation, note, locator}, the target named
-- as fabrik_link names it, and goes to the target's latest version. As fabrik_link does, each replaces the record's
-- link of that relation to the same record, and a parent replaces any other parent. A list that names one link
-- twice is refused.
grant create on schema fabrik to fabrik_reader;
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_reader;
reset role;
set role fabrik_reader;
create or replace function fabrik_task.link_many(p_record text, p_links jsonb, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); r jsonb; added jsonb; kept jsonb; made jsonb;
begin
 if jsonb_typeof(p_links) is distinct from 'array' or jsonb_array_length(p_links)=0 or exists(select 1 from jsonb_array_elements(p_links) l
   where jsonb_typeof(l) is distinct from 'object' or jsonb_typeof(l->'target') is distinct from 'string' or jsonb_typeof(l->'relation') is distinct from 'string') then
  raise exception 'Give the links as a list, each with a target and a relation' using errcode='22023';
 end if;
 if jsonb_array_length(p_links)>200 then raise exception 'Too many items: links' using errcode='22023'; end if;
 select jsonb_agg(jsonb_build_object('target_record_id',fabrik_task.record_id(l->>'target'),'relation',l->'relation','note',l->'note','locator',l->'locator') order by n)
  into added from jsonb_array_elements(p_links) with ordinality x(l,n);
 if exists(select 1 from jsonb_array_elements(added) a group by a->>'relation',a->>'target_record_id' having count(*)>1)
   or (select count(*) from jsonb_array_elements(added) a where a->>'relation'='parent')>1 then
  raise exception 'The list names one link twice' using errcode='22023';
 end if;
 r:=fabrik_task.latest(rid);
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',l->'target_version_id','relation',l->'relation','locator',l->'locator','note',l->'note'))
  order by (l->>'link_id')::uuid),'[]'::jsonb) into kept
 from jsonb_array_elements(r->'links') l
 where not exists(select 1 from jsonb_array_elements(fabrik_task.version_links((r->'version'->>'version_id')::uuid)) m
   join jsonb_array_elements(added) a on a->>'relation'=m->>'relation' and (a->>'target_record_id'=m->>'target_record_id' or a->>'relation'='parent')
  where m->>'link_id'=l->>'link_id');
 select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',fabrik_task.latest((a->>'target_record_id')::uuid)->'version'->'version_id',
  'relation',a->'relation','locator',a->'locator','note',a->'note')) order by n) into made from jsonb_array_elements(added) with ordinality y(a,n);
 return fabrik_task.change(rid,p_reason,'{}'::jsonb,null,kept||made,p_preview);
end $$;

create or replace function fabrik.fabrik_link_many(p_record text, p_links jsonb, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.link_many(p_record,p_links,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_link_many',m,null,null,coalesce(r::text,p_record));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on function fabrik_task.link_many(text,jsonb,text,boolean), fabrik.fabrik_link_many(text,jsonb,text,boolean) from public, anon;
grant execute on function fabrik_task.link_many(text,jsonb,text,boolean), fabrik.fabrik_link_many(text,jsonb,text,boolean) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- The lookups and the change the connector's ported tools share. A record whose latest payload holds
-- properties.trashed_at is trashed: the ported delete_record saves it so, and restore_record removes it.
-- The lookups leave trashed records out unless asked for them.
-- ===================================================================

-- A title names a record by one rule, here and in fabrik_task.record_id: the one record not trashed that has the
-- title, or, when no record not trashed has it, the one trashed record that has it. Where more than one could be
-- meant, the refusal lists each, a trashed one marked deleted. An id names any record.
set role fabrik_owner;
create or replace function fabrik_task.record_id(p_record text, p_scope uuid) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); page jsonb; cut bigint; cur bigint; hits jsonb:='[]'::jsonb; live jsonb;
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return t::uuid; end if;
 loop
  page:=fabrik.fabrik_find_records(null,p_scope,t,cut,cur,100);
  cut:=(page->>'cutoff')::bigint;
  hits:=hits||coalesce((select jsonb_agg(x) from jsonb_array_elements(page->'items') x where lower(btrim(x->>'title'))=lower(t)),'[]'::jsonb);
  cur:=(page->>'next_cursor')::bigint;
  exit when cur is null;
 end loop;
 if jsonb_array_length(hits)=1 then return (hits->0->>'record_id')::uuid; end if;
 if jsonb_array_length(hits)=0 then raise exception 'Record unavailable: no record you can read has the title "%"',t using errcode='42501'; end if;
 -- Only where more than one has the title is each read for whether it is trashed.
 select jsonb_agg(x||jsonb_build_object('deleted',
  fabrik.fabrik_get_record((x->>'record_id')::uuid)->'version'->'payload'->'properties'->'trashed_at' is not null)) into hits
 from jsonb_array_elements(hits) x;
 select coalesce(jsonb_agg(x),'[]'::jsonb) into live from jsonb_array_elements(hits) x where not (x->>'deleted')::boolean;
 if jsonb_array_length(live)=1 then return (live->0->>'record_id')::uuid; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, saved %s%s, id %s)',x->>'title',fabrik_task.scope_name((x->>'scope_id')::uuid),x->>'saved_at',
    case when (x->>'deleted')::boolean then ', deleted' else '' end,x->>'record_id'),'; ')
   from jsonb_array_elements(hits) x) using errcode='22023';
end $$;
revoke all on function fabrik_task.record_id(text,uuid) from public, anon;
grant execute on function fabrik_task.record_id(text,uuid) to authenticated;

-- The record named by its id, or by its title by fabrik_task.record_id's rule and in its words, for the security
-- definer reads, which cannot run fabrik_task. A record the caller may not read, or a deleted one, is refused as
-- unavailable.
create or replace function fabrik_private.readable_record_id(p_record text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); rid uuid; hits jsonb; live jsonb;
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then rid:=t::uuid;
 else
  select coalesce(jsonb_agg(jsonb_build_object('record_id',r.record_id,'title',v.title,'scope',s.display_name,'saved_at',v.recorded_at,
   'deleted',v.payload->'properties'->'trashed_at' is not null) order by v.change_no desc),'[]'::jsonb)
  into hits from fabrik.record_version v join fabrik.record r using(record_id) join fabrik.scope s on s.scope_id=r.scope_id
  where lower(btrim(v.title))=lower(t) and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id);
  if jsonb_array_length(hits)=0 then raise exception 'Record unavailable: no record you can read has the title "%"',t using errcode='42501'; end if;
  select coalesce(jsonb_agg(x),'[]'::jsonb) into live from jsonb_array_elements(hits) x where not (x->>'deleted')::boolean;
  if jsonb_array_length(hits)=1 then rid:=(hits->0->>'record_id')::uuid;
  elsif jsonb_array_length(live)=1 then rid:=(live->0->>'record_id')::uuid;
  else
   raise exception 'More than one record has the title "%": %',t,(select string_agg(format('%s (%s, saved %s%s, id %s)',x->>'title',x->>'scope',x->>'saved_at',
    case when (x->>'deleted')::boolean then ', deleted' else '' end,x->>'record_id'),'; ') from jsonb_array_elements(hits) x) using errcode='22023';
  end if;
 end if;
 if not fabrik_private.can_read_record(rid) or exists(select 1 from fabrik.record where record_id=rid and deleted_at is not null) then
  raise exception 'Record unavailable' using errcode='42501';
 end if;
 return rid;
end $$;
reset role;
revoke all on function fabrik_private.readable_record_id(text) from public, anon, authenticated;
grant execute on function fabrik_private.readable_record_id(text) to fabrik_reader;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- The records whose title is p_name, ignoring case and outer spaces, and whose payload.type is p_type when it is
-- given: latest versions of records the caller may read, not deleted, newest save first, at most 50. Trashed records
-- are left out unless p_trashed; each item's deleted is true for a trashed one.
create or replace function fabrik.fabrik_find_by_name(p_name text, p_type text default null, p_trashed boolean default false) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform fabrik_private.read_actor();
 select coalesce(jsonb_agg(jsonb_build_object('record_id',x.record_id,'kind',x.kind,'type',x.payload->'type','title',x.title,
  'scope_id',x.scope_id,'saved_at',x.recorded_at,'deleted',x.payload->'properties'->'trashed_at' is not null) order by x.change_no desc),'[]'::jsonb) into result
 from (select r.record_id,r.kind,r.scope_id,v.title,v.payload,v.recorded_at,v.change_no
  from fabrik.record_version v join fabrik.record r using(record_id)
  where lower(btrim(v.title))=lower(btrim(coalesce(p_name,'')))
   and (p_type is null or v.payload->>'type'=p_type)
   and (coalesce(p_trashed,false) or v.payload->'properties'->'trashed_at' is null)
   and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id)
  order by v.change_no desc limit 50) x;
 return result;
end $$;

-- The records of one payload.type whose payload holds p_match, and whose title holds every word of p_words in any
-- case: latest versions of records the caller may read, not deleted, trashed ones only when p_trashed and otherwise
-- none. With p_own, only the caller's own: those whose first version was saved for the person the caller answers to,
-- which fabrik keeps and no payload can set. Each item's latest_own is true when its latest version was also saved for
-- that person, so a caller can leave out a record someone else changed last. With p_records, only those records.
-- Newest save first, at most p_limit (1 to 500); more is true when there were more.
create or replace function fabrik.fabrik_find_typed(p_type text, p_match jsonb default '{}', p_words text default null,
 p_trashed boolean default false, p_limit integer default 100, p_own boolean default false, p_records uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare n integer:=coalesce(p_limit,100); words text[]; result jsonb; me fabrik.actor;
begin
 me:=fabrik_private.read_actor();
 if n<1 or n>500 then raise exception 'The limit is 1 to 500' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_match,'{}'::jsonb))<>'object' then raise exception 'The match is a JSON object' using errcode='22023'; end if;
 words:=array(select w from regexp_split_to_table(lower(btrim(coalesce(p_words,''))),'\s+') w where w<>'');
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('record_id',x.record_id,'kind',x.kind,'scope_id',x.scope_id,'title',x.title,
  'version_id',x.version_id,'saved_at',x.recorded_at,'payload',x.payload,'latest_own',x.accountable_human_id=me.accountable_human_id)
  order by x.change_no desc) filter (where x.rn<=n),'[]'::jsonb),
  'more',count(*)>n) into result
 from (select r.record_id,r.kind,r.scope_id,v.title,v.version_id,v.recorded_at,v.payload,v.change_no,v.accountable_human_id,
  row_number() over (order by v.change_no desc) rn
  from fabrik.record_version v join fabrik.record r using(record_id)
  where v.payload->>'type'=p_type
   and (p_records is null or v.record_id=any(p_records))
   and v.payload@>coalesce(p_match,'{}'::jsonb)
   and (select bool_and(strpos(lower(coalesce(v.title,'')),w)>0) from unnest(words) w) is not false
   and (v.payload->'properties'->'trashed_at' is not null)=coalesce(p_trashed,false)
   and (not coalesce(p_own,false) or exists(select 1 from fabrik.record_version f where f.record_id=v.record_id and f.version_number=1
    and f.accountable_human_id=me.accountable_human_id))
   and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id)
  order by v.change_no desc limit n+1) x;
 return result;
end $$;

-- The contacts, records of type Person or Organization, whose properties.email is p_value in any case and with no outer
-- spaces (p_key email), or whose properties.telephone has p_value's digits and leading + (p_key telephone): latest
-- versions of records the caller may read, not deleted and not trashed. Items as fabrik_find_typed gives them, newest
-- save first, at most p_limit (1 to 500); more is true when there were more.
create or replace function fabrik.fabrik_find_contacts(p_key text, p_value text, p_limit integer default 10) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare n integer:=coalesce(p_limit,10); want text; result jsonb; me fabrik.actor;
begin
 me:=fabrik_private.read_actor();
 if n<1 or n>500 then raise exception 'The limit is 1 to 500' using errcode='22023'; end if;
 if coalesce(p_key,'') not in ('email','telephone') then raise exception 'The key is email or telephone' using errcode='22023'; end if;
 want:=case when p_key='email' then lower(btrim(coalesce(p_value,''))) else regexp_replace(coalesce(p_value,''),'[^0-9+]','','g') end;
 if want in ('','+') then raise exception 'Give the % to find',p_key using errcode='22023'; end if;
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('record_id',x.record_id,'kind',x.kind,'scope_id',x.scope_id,'title',x.title,
  'version_id',x.version_id,'saved_at',x.recorded_at,'payload',x.payload,'latest_own',x.accountable_human_id=me.accountable_human_id)
  order by x.change_no desc) filter (where x.rn<=n),'[]'::jsonb),
  'more',count(*)>n) into result
 from (select r.record_id,r.kind,r.scope_id,v.title,v.version_id,v.recorded_at,v.payload,v.change_no,v.accountable_human_id,
  row_number() over (order by v.change_no desc) rn
  from fabrik.record_version v join fabrik.record r using(record_id)
  where v.payload->>'type' in ('Person','Organization')
   and case when p_key='email' then lower(btrim(v.payload->'properties'->>'email'))
    else regexp_replace(v.payload->'properties'->>'telephone','[^0-9+]','','g') end=want
   and v.payload->'properties'->'trashed_at' is null
   and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id)
  order by v.change_no desc limit n+1) x;
 return result;
end $$;

-- The records linked to or from p_record by a relation in p_relations. 'out': the targets of the links of
-- p_record's latest version, each at its latest version. 'in': the records whose latest version links to any version
-- of p_record. 'both': the two together. Records the caller may read, not deleted and not trashed, newest save first.
-- p_record is named as fabrik_task.record_id names a record, through fabrik_private.readable_record_id.
create or replace function fabrik.fabrik_linked(p_record text, p_relations text[], p_direction text default 'both') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rid uuid; latest uuid; result jsonb;
begin
 perform fabrik_private.read_actor();
 if coalesce(p_direction,'') not in ('out','in','both') then raise exception 'The direction is out, in or both' using errcode='22023'; end if;
 rid:=fabrik_private.readable_record_id(p_record);
 select v.version_id into latest from fabrik.record_version v where v.record_id=rid order by v.change_no desc limit 1;
 with found as (
  select tv.record_id,l.relation,'out' as direction,l.note from fabrik.version_link l join fabrik.record_version tv on tv.version_id=l.target_version_id
  where p_direction in ('out','both') and l.source_version_id=latest and l.relation=any(p_relations)
  union all
  select sv.record_id,l.relation,'in',l.note from fabrik.version_link l join fabrik.record_version sv on sv.version_id=l.source_version_id
   join fabrik.record_version tv on tv.version_id=l.target_version_id
  where p_direction in ('in','both') and tv.record_id=rid and l.relation=any(p_relations)
   and sv.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=sv.record_id))
 select coalesce(jsonb_agg(jsonb_build_object('record_id',f.record_id,'kind',r.kind,'type',v.payload->'type','title',v.title,'relation',f.relation,
  'direction',f.direction,'note',f.note,'saved_at',v.recorded_at,'payload',v.payload) order by v.change_no desc,f.relation,f.direction),'[]'::jsonb) into result
 from found f join fabrik.record r on r.record_id=f.record_id
 join fabrik.record_version v on v.record_id=f.record_id and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=f.record_id)
 where r.deleted_at is null and v.payload->'properties'->'trashed_at' is null and fabrik_private.can_read_record(r.record_id);
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_find_by_name(text,text,boolean), fabrik.fabrik_find_typed(text,jsonb,text,boolean,integer,boolean,uuid[]),
 fabrik.fabrik_find_contacts(text,text,integer), fabrik.fabrik_linked(text,text[],text) from public, anon;
grant execute on function fabrik.fabrik_find_by_name(text,text,boolean), fabrik.fabrik_find_typed(text,jsonb,text,boolean,integer,boolean,uuid[]),
 fabrik.fabrik_find_contacts(text,text,integer), fabrik.fabrik_linked(text,text[],text) to authenticated;
notify pgrst, 'reload schema';

-- A new version of a record whose properties are its old ones with p_properties merged in, a key given as JSON null
-- removed; p_fields merged into the payload's top level, as fabrik_change_record merges them; its title p_title when
-- given; its links kept. It answers as fabrik_change_record does.
grant create on schema fabrik to fabrik_reader;
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_reader;
reset role;
set role fabrik_reader;
create or replace function fabrik_task.change_properties(p_record text, p_reason text, p_properties jsonb, p_fields jsonb default '{}',
 p_title text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); p jsonb:=coalesce(p_properties,'{}'::jsonb); f jsonb:=coalesce(p_fields,'{}'::jsonb); old jsonb; merged jsonb;
begin
 if jsonb_typeof(p)<>'object' then raise exception 'The properties are a JSON object' using errcode='22023'; end if;
 if jsonb_typeof(f)<>'object' then raise exception 'The fields are a JSON object' using errcode='22023'; end if;
 old:=fabrik_task.latest(rid)->'version'->'payload'->'properties';
 merged:=(case when jsonb_typeof(old)='object' then old else '{}'::jsonb end||p)-array(select key from jsonb_each(p) where value='null'::jsonb);
 -- A record with no properties gains none from a change that sets none.
 f:=f-'properties'||case when old is null and merged='{}'::jsonb then '{}'::jsonb else jsonb_build_object('properties',merged) end;
 return fabrik_task.change(rid,p_reason,f,p_title,null,p_preview);
end $$;

create or replace function fabrik.fabrik_change_properties(p_record text, p_reason text, p_properties jsonb, p_fields jsonb default '{}',
 p_title text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.change_properties(p_record,p_reason,p_properties,p_fields,p_title,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_change_properties',m,null,null,coalesce(r::text,p_record));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on function fabrik_task.change_properties(text,text,jsonb,jsonb,text,boolean), fabrik.fabrik_change_properties(text,text,jsonb,jsonb,text,boolean) from public, anon;
grant execute on function fabrik_task.change_properties(text,text,jsonb,jsonb,text,boolean), fabrik.fabrik_change_properties(text,text,jsonb,jsonb,text,boolean) to authenticated;
notify pgrst, 'reload schema';

-- The tasks ready to start: open, untrashed tasks the caller may read, not deleted, with no blocks link to any of
-- their versions from the latest version of an open, untrashed task the caller may read. Open is neither completed
-- nor cancelled. With p_project, only the project's tasks: those its latest version links by has_task, and those
-- whose latest version has a parent link to it. Soonest forecast finish first, then by title.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
create or replace function fabrik.fabrik_ready_tasks(p_project text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare pid uuid; result jsonb;
begin
 perform fabrik_private.read_actor();
 if p_project is not null then
  pid:=fabrik_private.readable_record_id(p_project);
  -- A has_task link also comes from a person or a business that has a task, as maxy-code kept it: only a plan's are a project's.
  if not exists(select 1 from fabrik.record_version v where v.record_id=pid and v.payload->>'activity_kind'='plan'
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=pid)) then
   raise exception 'Not a project: "%" is not a plan',p_project using errcode='22023';
  end if;
 end if;
 with latest as (
  select r.record_id,v.version_id,v.title,v.payload,v.recorded_at
  from fabrik.record_version v join fabrik.record r using(record_id)
  where r.kind='activity' and v.payload->>'activity_kind'='task' and r.deleted_at is null
   and coalesce(v.payload->>'state','') not in ('completed','cancelled')
   and v.payload->'properties'->'trashed_at' is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id))
 select coalesce(jsonb_agg(jsonb_build_object('record_id',t.record_id,'title',t.title,'state',t.payload->'state','saved_at',t.recorded_at,'payload',t.payload)
  order by t.payload->>'forecast_finish_at' nulls last,t.title,t.record_id),'[]'::jsonb) into result
 from latest t
 where (pid is null
   or exists(select 1 from fabrik.version_link l join fabrik.record_version tv on tv.version_id=l.target_version_id
    where l.relation='has_task' and tv.record_id=t.record_id
     and l.source_version_id=(select p.version_id from fabrik.record_version p where p.record_id=pid order by p.change_no desc limit 1))
   or exists(select 1 from fabrik.version_link l join fabrik.record_version pv on pv.version_id=l.target_version_id
    where l.relation='parent' and l.source_version_id=t.version_id and pv.record_id=pid))
  and not exists(select 1 from fabrik.version_link l join fabrik.record_version tv on tv.version_id=l.target_version_id
   join latest b on b.version_id=l.source_version_id
   where l.relation='blocks' and tv.record_id=t.record_id);
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_ready_tasks(text) from public, anon;
grant execute on function fabrik.fabrik_ready_tasks(text) to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- 8za. Mailbox settings, for the fabrik-apps connector's mail tools.
-- ===================================================================
-- Where each mailbox is and who signs in to it, one row per mailbox. The password is not here: it is saved in Vault as
-- the secret imap_<name>, by the connector, once fabrik_list_mailboxes or fabrik_save_mailbox has accepted the caller as
-- an administrator. Only the three functions below read or change a row, and only for an administrator.
set role fabrik_owner;
create table if not exists fabrik_private.mailbox (
 name text primary key check (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
 host text not null,
 port int not null default 993 check (port between 1 and 65535),
 username text not null,
 updated_at timestamptz not null default now(),
 address text check (address is null or (length(address)<=320 and address ~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$')),
 smtp_host text,
 smtp_port int not null default 465 check (smtp_port between 1 and 65535),
 signature text,
 signature_html text check (signature_html is null or length(signature_html)<=50000)
);
revoke all on fabrik_private.mailbox from public, anon, authenticated;
grant select on fabrik_private.mailbox to fabrik_reader;
grant select, insert, update on fabrik_private.mailbox to fabrik_writer;
reset role;

-- Saves a mailbox's settings: adds it, or changes the one that has the name. Only an administrator saves one. The name is
-- lowercase letters, digits, _ and -, at most 40, and starts with a letter or digit. The From address is one email
-- address, the username when none is given. A mailbox with an SMTP host sends as well as drafts: ports 587, 25 and
-- 2525 use STARTTLS and any other port implicit TLS. The signature is plain text, at most 2,000 characters, put under
-- the body of each draft and message. A refusal for a person who is not an administrator is logged, as the second
-- factor's is. Answers the saved row, never a password.
grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik_private.save_mailbox(p_name text, p_host text, p_port int, p_username text, p_address text default null,
 p_smtp_host text default null, p_smtp_port int default 465, p_signature text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; n text:=lower(btrim(coalesce(p_name,''))); h text:=lower(btrim(coalesce(p_host,''))); u text:=btrim(coalesce(p_username,''));
 e text:=nullif(btrim(coalesce(p_address,'')),''); sh text:=nullif(lower(btrim(coalesce(p_smtp_host,''))),'');
 sig text:=nullif(btrim(coalesce(p_signature,''),E' \n\r\t'),'');
 dns constant text:='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'; m fabrik_private.mailbox;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then raise exception 'Only an administrator saves a mailbox' using errcode='42501'; end if;
 if n !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
  raise exception 'A mailbox name is lowercase letters, digits, _ and -, at most 40, starting with a letter or digit, as p_name' using errcode='22023';
 end if;
 if length(h)>253 or h !~ dns then raise exception 'Give the mailbox''s host as a DNS name: letters, digits and inner hyphens in dot-separated labels of at most 63, at most 253 in all, as p_host' using errcode='22023'; end if;
 if p_port is null or p_port<1 or p_port>65535 then raise exception 'The port is from 1 to 65535, as p_port' using errcode='22023'; end if;
 if u='' or length(u)>320 or u ~ '[[:cntrl:]]' then raise exception 'Give the username, at most 320 characters and no control characters, as p_username' using errcode='22023'; end if;
 e:=coalesce(e,u);
 if length(e)>320 or e !~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$' then
  raise exception 'Give the From address as one email address, such as ann@example.com, as p_address' using errcode='22023';
 end if;
 if sh is not null and (length(sh)>253 or sh !~ dns) then
  raise exception 'Give the SMTP host as a DNS name, as p_smtp_host, or none for a mailbox that only drafts' using errcode='22023';
 end if;
 if p_smtp_port is null or p_smtp_port<1 or p_smtp_port>65535 then raise exception 'The SMTP port is from 1 to 65535, as p_smtp_port' using errcode='22023'; end if;
 if length(sig)>2000 then raise exception 'The signature is at most 2,000 characters, as p_signature' using errcode='22023'; end if;
 insert into fabrik_private.mailbox(name,host,port,username,updated_at,address,smtp_host,smtp_port,signature)
 values(n,h,p_port,u,clock_timestamp(),e,sh,p_smtp_port,sig)
 on conflict (name) do update set host=excluded.host, port=excluded.port, username=excluded.username, updated_at=excluded.updated_at,
  address=excluded.address, smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port, signature=excluded.signature
 returning * into m;
 return jsonb_build_object('name',m.name,'host',m.host,'port',m.port,'username',m.username,'address',m.address,'smtp_host',m.smtp_host,
  'smtp_port',m.smtp_port,'signature',m.signature,'updated_at',m.updated_at);
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_writer;
revoke all on function fabrik_private.save_mailbox(text,text,int,text,text,text,int,text) from public, anon, authenticated;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik.fabrik_save_mailbox(p_name text, p_host text, p_port int, p_username text, p_address text default null,
 p_smtp_host text default null, p_smtp_port int default 465, p_signature text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.save_mailbox(p_name,p_host,p_port,p_username,p_address,p_smtp_host,p_smtp_port,p_signature);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_save_mailbox',m,null,null,null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_save_mailbox(text,text,int,text,text,text,int,text) from public, anon;
grant execute on function fabrik.fabrik_save_mailbox(text,text,int,text,text,text,int,text) to authenticated;

-- Sets a mailbox's plain-text signature, its HTML signature or both, for an administrator. A part given as null is kept,
-- and a part given as an empty string, or as spaces alone, is removed. The plain-text signature is at most 2,000
-- characters and the HTML one at most 50,000. A refusal for a person who is not an administrator is logged, as the
-- mailbox's save is. Answers the mailbox's name and both signatures as they are now stored.
grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik_private.save_mailbox_signature(p_name text, p_text text default null, p_html text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; n text:=lower(btrim(coalesce(p_name,'')));
 t text:=btrim(p_text,E' \n\r\t'); h text:=btrim(p_html,E' \n\r\t'); m fabrik_private.mailbox;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then raise exception 'Only an administrator sets a mailbox''s signature' using errcode='42501'; end if;
 if p_text is null and p_html is null then raise exception 'Give the plain-text signature as p_text, the HTML signature as p_html, or both' using errcode='22023'; end if;
 if length(t)>2000 then raise exception 'The signature is at most 2,000 characters, as p_text' using errcode='22023'; end if;
 if length(h)>50000 then raise exception 'The HTML signature is at most 50,000 characters, as p_html' using errcode='22023'; end if;
 update fabrik_private.mailbox set
  signature=case when p_text is null then signature else nullif(t,'') end,
  signature_html=case when p_html is null then signature_html else nullif(h,'') end,
  updated_at=clock_timestamp()
 where name=n returning * into m;
 if m.name is null then raise exception 'No mailbox is named "%"', n using errcode='22023'; end if;
 return jsonb_build_object('name',m.name,'signature',m.signature,'signature_html',m.signature_html,'updated_at',m.updated_at);
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_writer;
revoke all on function fabrik_private.save_mailbox_signature(text,text,text) from public, anon, authenticated;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik.fabrik_save_mailbox_signature(p_name text, p_text text default null, p_html text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.save_mailbox_signature(p_name,p_text,p_html);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_save_mailbox_signature',m,null,null,null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_save_mailbox_signature(text,text,text) from public, anon;
grant execute on function fabrik.fabrik_save_mailbox_signature(text,text,text) to authenticated;

-- Every mailbox's settings and time of saving, by name, for an administrator. Never a password.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
create or replace function fabrik.fabrik_list_mailboxes() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.read_actor();
 if a.actor_kind is distinct from 'human' or a.authority_class is distinct from 'administrator' then raise exception 'Only an administrator lists mailboxes' using errcode='42501'; end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('name',m.name,'host',m.host,'port',m.port,'username',m.username,
  'address',m.address,'smtp_host',m.smtp_host,'smtp_port',m.smtp_port,'signature',m.signature,'signature_html',m.signature_html,'updated_at',m.updated_at)
  order by m.name) from fabrik_private.mailbox m),'[]'::jsonb));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_list_mailboxes() from public, anon;
grant execute on function fabrik.fabrik_list_mailboxes() to authenticated;
notify pgrst, 'reload schema';

-- ===================================================================
-- The public agent: the chat box on the owner's website, which the public-agent hosted function answers from the
-- KNOWLEDGE.md file in the private bucket public-agent. The bucket has no rule for a signed-in person, so only the
-- function reads or writes it, with the project's service key. The settings row holds the Claude model and the daily
-- cap in tokens, and the Turnstile site key the chat page draws its check with. The usage table holds each day's tokens, counted from Claude's answers, and nothing a visitor typed.
-- Only the function reads or changes either table.
set role fabrik_owner;
create table if not exists fabrik_private.public_agent_setting (
 id boolean primary key default true check (id),
 model text not null default 'claude-haiku-5-5' check (model ~ '^claude-[a-z0-9.-]{1,60}$'),
 daily_cap_tokens integer not null default 500000 check (daily_cap_tokens between 1000 and 100000000),
 updated_at timestamptz not null default now()
);
alter table fabrik_private.public_agent_setting add column if not exists turnstile_sitekey text
 check (turnstile_sitekey ~ '^[0-9]x[A-Za-z0-9_-]{18,60}$');
insert into fabrik_private.public_agent_setting(id) values (true) on conflict (id) do nothing;
create table if not exists fabrik_private.public_agent_usage (
 day date primary key,
 tokens bigint not null default 0 check (tokens >= 0)
);
alter table fabrik_private.public_agent_setting enable row level security;
alter table fabrik_private.public_agent_usage enable row level security;
revoke all on fabrik_private.public_agent_setting, fabrik_private.public_agent_usage from public, anon, authenticated;
reset role;
insert into storage.buckets(id, name, public) values ('public-agent', 'public-agent', false) on conflict (id) do nothing;

insert into fabrik_private.schema_upgrade(id) values ('0001-baseline'), ('0002-set-based-lookups'), ('0003-second-factor'), ('0004-graph-reader'), ('0005-private-sessions'), ('0006-record-source'), ('0007-ported-tools'), ('0008-mailbox'), ('0009-save-version-check'), ('0010-mail-send'), ('0011-mail-signature'), ('0012-public-agent'), ('0013-public-agent-sitekey');

-- ===================================================================
-- Next: bootstrap.sql creates the first administrator, the first scope
-- and each later user. tests.sql checks this setup and rolls back.
-- ===================================================================
