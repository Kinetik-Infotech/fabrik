-- fabrik: the first administrator and the three scopes, from the Auth user the fabrik-setup hosted function made at the
-- owner's first sign-in, as fabrik_setup.person lists it. Run once, as postgres, through fabrik-setup or the SQL Editor,
-- after the owner has signed in. It holds no name, email or id of its own.
-- It does what bootstrap.sql's steps 1, 2 and 3e do, filled in from fabrik_setup.person: the owner becomes the first
-- administrator, the three scopes are made in their name, and the owner gets their sessions scope. One transaction: a
-- failure keeps nothing.
do $$
declare
 o record;
 admin_id uuid;
begin
 select * into o from fabrik_setup.person where role = 'owner';
 if o.auth_user_id is null then
  raise exception 'The owner has not signed in yet: fabrik_setup.person names no owner' using errcode = '22023';
 end if;
 if exists(select 1 from fabrik.actor) then
  raise exception 'fabrik already has actors: the first administrator is made' using errcode = '23505';
 end if;

 -- Step 1. The first administrator.
 admin_id := fabrik_private.provision_first_administrator(o.auth_user_id, o.name);

 -- Step 2. The three scopes, as bootstrap.sql's step 2 makes them.
 insert into fabrik.scope(code, display_name, description, created_by)
 select x.code, x.display_name, x.description, admin_id
 from (values
   ('general', 'General', 'Day-to-day records and files.'),
   ('reference', 'Reference', 'The glossary of words, and the data dictionary of where each fact is kept.'),
   ('administration', 'Administration', 'The setup record and each access record: who set the project up, each actor made, each grant given and why. Read only by administrators.')
 ) as x(code, display_name, description)
 where not exists(select 1 from fabrik.scope s where s.code = x.code);

 -- Step 3e for the owner.
 insert into fabrik.scope(code, display_name, description, created_by)
 values ('sessions_' || replace(o.auth_user_id::text, '-', ''), o.name || '''s sessions',
  'The text of each session ' || o.name || ' has had with their agent.', admin_id);
 perform fabrik_private.provision_grant(
  admin_id,
  gen_random_uuid(),
  admin_id,
  (select s.scope_id from fabrik.scope s where s.code = 'sessions_' || replace(o.auth_user_id::text, '-', '')),
  array['evidence'],
  null::uuid,
  array['read','create','edit','delete'],
  null::timestamptz,
  'Their agent keeps the text of each session with them here.');
end $$;
