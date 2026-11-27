-- 0023-public-agent-pass
-- base: 663246c
-- redeploy: public-agent
-- Each public-agent pass's questions: the pass's signature, the time it ends and how many questions it has answered. The
-- public-agent function takes one question from the pass's row before it calls Claude, and refuses the pass once it has
-- answered 20, so one Turnstile check can't be replayed without end. A row is the pass alone: nothing in it names a
-- visitor. Only the public-agent function reads or changes it.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
create table if not exists fabrik_private.public_agent_pass (
 signature text primary key check (signature ~ '^[0-9a-f]{64}$'),
 until timestamptz not null,
 questions integer not null default 0 check (questions >= 0)
);
create index if not exists public_agent_pass_until on fabrik_private.public_agent_pass (until);
alter table fabrik_private.public_agent_pass enable row level security;
revoke all on fabrik_private.public_agent_pass from public, anon, authenticated;
reset role;

insert into fabrik_private.schema_upgrade(id) values ('0023-public-agent-pass') on conflict (id) do nothing;
