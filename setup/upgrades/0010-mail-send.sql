-- 0010-mail-send
-- base: bdaa665
-- redeploy: fabrik-apps
-- The database side of the fabrik-apps connector's drafts and sending: fabrik_private.mailbox gains the From address,
-- the SMTP host and port and the signature, and fabrik_save_mailbox and fabrik_list_mailboxes take and give them. The
-- password is never kept here; the connector reads it from Vault, where it already is.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
alter table fabrik_private.mailbox add column if not exists address text check (address is null or (length(address)<=320 and address ~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$'));
alter table fabrik_private.mailbox add column if not exists smtp_host text;
alter table fabrik_private.mailbox add column if not exists smtp_port int not null default 465 check (smtp_port between 1 and 65535);
alter table fabrik_private.mailbox add column if not exists signature text;
reset role;
-- A username that is one email address becomes the From address. Any other leaves it none, and the connector asks for the
-- mailbox to be set up again before it drafts or sends.
update fabrik_private.mailbox set address=username where address is null and length(username)<=320 and username ~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$';

drop function if exists fabrik.fabrik_save_mailbox(text,text,int,text);
drop function if exists fabrik_private.save_mailbox(text,text,int,text);

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
  'address',m.address,'smtp_host',m.smtp_host,'smtp_port',m.smtp_port,'signature',m.signature,'updated_at',m.updated_at)
  order by m.name) from fabrik_private.mailbox m),'[]'::jsonb));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_list_mailboxes() from public, anon;
grant execute on function fabrik.fabrik_list_mailboxes() to authenticated;
notify pgrst, 'reload schema';

insert into fabrik_private.schema_upgrade(id) values ('0010-mail-send') on conflict (id) do nothing;
