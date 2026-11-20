-- 0013-public-agent-sitekey
-- base: 6072423
-- redeploy: fabrik-apps, public-agent
-- The chat page's Turnstile site key: fabrik_private.public_agent_setting gains turnstile_sitekey, which the public
-- agent card saves beside the secret key and the public-agent function gives the chat page. The same text is in
-- setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
alter table fabrik_private.public_agent_setting add column if not exists turnstile_sitekey text
 check (turnstile_sitekey ~ '^[0-9]x[A-Za-z0-9_-]{18,60}$');
reset role;

insert into fabrik_private.schema_upgrade(id) values ('0013-public-agent-sitekey') on conflict (id) do nothing;
