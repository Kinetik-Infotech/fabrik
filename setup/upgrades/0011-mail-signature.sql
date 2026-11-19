-- 0011-mail-signature
-- base: a3f30cc
-- redeploy: fabrik-apps
-- A mailbox's HTML signature, beside its plain-text one: fabrik_private.mailbox gains signature_html, at most 50,000
-- characters, fabrik_save_mailbox_signature sets either signature or both, and fabrik_list_mailboxes gives it.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
alter table fabrik_private.mailbox add column if not exists signature_html text check (signature_html is null or length(signature_html)<=50000);
reset role;

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

insert into fabrik_private.schema_upgrade(id) values ('0011-mail-signature') on conflict (id) do nothing;
