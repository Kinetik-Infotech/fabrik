-- 0012-public-agent
-- base: 3212004
-- redeploy: fabrik-apps, public-agent
-- The public agent's settings and usage tables, and its private bucket public-agent. The public-agent hosted function
-- uses them to answer the chat box on the owner's website. The same text is in setup.sql. Safe to run twice. Run as
-- the postgres login.

set role fabrik_owner;
create table if not exists fabrik_private.public_agent_setting (
 id boolean primary key default true check (id),
 model text not null default 'claude-haiku-5-5' check (model ~ '^claude-[a-z0-9.-]{1,60}$'),
 daily_cap_tokens integer not null default 500000 check (daily_cap_tokens between 1000 and 100000000),
 updated_at timestamptz not null default now()
);
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

insert into fabrik_private.schema_upgrade(id) values ('0012-public-agent') on conflict (id) do nothing;
