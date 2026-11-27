-- 0022-public-agent-greeting
-- base: 7aa6e64
-- redeploy: fabrik-apps, public-agent
-- A public agent may have a greeting, plain text of at most 600 characters, which its chat page shows as the first
-- message of a new conversation, without calling Claude. An agent with no greeting has an empty one.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
alter table fabrik_private.public_agent add column if not exists greeting text not null default '' check (length(greeting) <= 600);
reset role;

insert into fabrik_private.schema_upgrade(id) values ('0022-public-agent-greeting') on conflict (id) do nothing;
