-- 0015-public-exchanges
-- base: 96d8d23
-- redeploy: fabrik-apps, public-agent
-- The public agents' conversations, kept in the owner's own project. fabrik_private.public_exchange holds one row for
-- each question a public agent answered: the conversation's id, which the chat page makes when it opens, the agent's
-- slug, the time, the question, the answer shown, and the answer's input and output tokens. Nothing that identifies a
-- visitor is kept. Only the public-agent function reads or changes it. The same text is in setup.sql. Safe to run
-- twice. Run as the postgres login.

set role fabrik_owner;
create table if not exists fabrik_private.public_exchange (
 id bigint generated always as identity primary key,
 conversation uuid not null,
 slug text not null references fabrik_private.public_agent(slug) on delete cascade,
 at timestamptz not null default now(),
 question text not null,
 answer text not null,
 input_tokens integer not null default 0 check (input_tokens >= 0),
 output_tokens integer not null default 0 check (output_tokens >= 0)
);
create index if not exists public_exchange_slug_at on fabrik_private.public_exchange (slug, at);
create index if not exists public_exchange_conversation on fabrik_private.public_exchange (conversation);
alter table fabrik_private.public_exchange enable row level security;
revoke all on fabrik_private.public_exchange from public, anon, authenticated;
reset role;

insert into fabrik_private.schema_upgrade(id) values ('0015-public-exchanges') on conflict (id) do nothing;
