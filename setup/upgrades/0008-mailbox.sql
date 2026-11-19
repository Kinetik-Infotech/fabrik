-- 0008-mailbox
-- base: 2e670b2
-- redeploy: fabrik-apps
-- The database side of the fabrik-apps connector's read-only mail: fabrik_private.mailbox, where each mailbox is and who
-- signs in to it, and fabrik_save_mailbox and fabrik_list_mailboxes, which only an administrator calls. The password is
-- never kept here; the connector saves it in Vault once these have accepted the caller.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

-- ===================================================================
-- 8za. Mailbox settings, for the fabrik-apps connector's read-only mail tools.
-- ===================================================================
-- Where each mailbox is and who signs in to it, one row per mailbox. The password is not here: it is saved in Vault as
-- the secret imap_<name>, by the connector, once fabrik_list_mailboxes or fabrik_save_mailbox has accepted the caller as
-- an administrator. Only the two functions below read or change a row, and only for an administrator.
set role fabrik_owner;
create table if not exists fabrik_private.mailbox (
 name text primary key check (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
 host text not null,
 port int not null default 993 check (port between 1 and 65535),
 username text not null,
 updated_at timestamptz not null default now()
);
revoke all on fabrik_private.mailbox from public, anon, authenticated;
grant select on fabrik_private.mailbox to fabrik_reader;
grant select, insert, update on fabrik_private.mailbox to fabrik_writer;
reset role;

-- Saves a mailbox's settings: adds it, or changes the one that has the name. Only an administrator saves one. The name is
-- lowercase letters, digits, _ and -, at most 40, and starts with a letter or digit. A refusal for a person who is not
-- an administrator is logged, as the second factor's is. Answers the saved row, never a password.
grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik_private.save_mailbox(p_name text, p_host text, p_port int, p_username text) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor; n text:=lower(btrim(coalesce(p_name,''))); h text:=lower(btrim(coalesce(p_host,''))); u text:=btrim(coalesce(p_username,'')); m fabrik_private.mailbox;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 if a.actor_kind<>'human' or a.authority_class<>'administrator' then raise exception 'Only an administrator saves a mailbox' using errcode='42501'; end if;
 if n !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
  raise exception 'A mailbox name is lowercase letters, digits, _ and -, at most 40, starting with a letter or digit, as p_name' using errcode='22023';
 end if;
 if length(h)>253 or h !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$' then raise exception 'Give the mailbox''s host as a DNS name: letters, digits and inner hyphens in dot-separated labels of at most 63, at most 253 in all, as p_host' using errcode='22023'; end if;
 if p_port is null or p_port<1 or p_port>65535 then raise exception 'The port is from 1 to 65535, as p_port' using errcode='22023'; end if;
 if u='' or length(u)>320 then raise exception 'Give the username, at most 320 characters, as p_username' using errcode='22023'; end if;
 insert into fabrik_private.mailbox(name,host,port,username,updated_at) values(n,h,p_port,u,clock_timestamp())
 on conflict (name) do update set host=excluded.host, port=excluded.port, username=excluded.username, updated_at=excluded.updated_at
 returning * into m;
 return jsonb_build_object('name',m.name,'host',m.host,'port',m.port,'username',m.username,'updated_at',m.updated_at);
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_writer;
revoke all on function fabrik_private.save_mailbox(text,text,int,text) from public, anon, authenticated;

grant create on schema fabrik to fabrik_writer;
set role fabrik_writer;
create or replace function fabrik.fabrik_save_mailbox(p_name text, p_host text, p_port int, p_username text) returns jsonb
language plpgsql security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare m text; c text;
begin
 return fabrik_private.save_mailbox(p_name,p_host,p_port,p_username);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_private.log_refusal('fabrik_save_mailbox',m,null,null,null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_writer;
revoke all on function fabrik.fabrik_save_mailbox(text,text,int,text) from public, anon;
grant execute on function fabrik.fabrik_save_mailbox(text,text,int,text) to authenticated;

-- Every mailbox's name, host, port, username and time of saving, by name, for an administrator. Never a password.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
create or replace function fabrik.fabrik_list_mailboxes() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog set "TimeZone" to 'UTC' as $$
declare a fabrik.actor;
begin
 a:=fabrik_private.read_actor();
 if a.actor_kind is distinct from 'human' or a.authority_class is distinct from 'administrator' then raise exception 'Only an administrator lists mailboxes' using errcode='42501'; end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('name',m.name,'host',m.host,'port',m.port,'username',m.username,'updated_at',m.updated_at)
  order by m.name) from fabrik_private.mailbox m),'[]'::jsonb));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_list_mailboxes() from public, anon;
grant execute on function fabrik.fabrik_list_mailboxes() to authenticated;
notify pgrst, 'reload schema';

insert into fabrik_private.schema_upgrade(id) values ('0008-mailbox') on conflict (id) do nothing;
