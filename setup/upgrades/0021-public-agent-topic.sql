-- 0021-public-agent-topic
-- base: b18c0bd
-- redeploy: fabrik-apps, public-agent
-- A public agent may have a topic, a short text such as Masks, which the chat pages group the agents by. An agent
-- with no topic has an empty one.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
alter table fabrik_private.public_agent add column if not exists topic text not null default '' check (length(topic) <= 80);
reset role;

insert into fabrik_private.schema_upgrade(id) values ('0021-public-agent-topic') on conflict (id) do nothing;
