-- 0014-public-agents
-- base: 682e03d
-- redeploy: fabrik-apps, public-agent
-- Any number of public agents. fabrik_private.public_agent holds one row per agent: its slug, name, purpose, model and
-- daily cap. The day's tokens in fabrik_private.public_agent_usage are counted per agent. The Anthropic API key and the
-- Turnstile keys stay shared, and public_agent_setting gains the chat page's address, which AGENTS.md names.
--
-- A project that has used the chat box gets the agent chat, named Chat, with the model, the cap and the tokens the
-- settings held. The public-agent function moves its KNOWLEDGE.md to agents/chat/knowledge.md the first time it reads
-- it. The same text is in setup.sql. Safe to run twice. Run as the postgres login.

-- Whether the project has used the chat box, read as the postgres login, which reads Storage and the Vault.
select set_config('fabrik.chat_used', (exists (select 1 from storage.objects where bucket_id = 'public-agent' and name = 'KNOWLEDGE.md')
  or exists (select 1 from vault.secrets where name = 'public_agent_anthropic_key'))::text, true);

set role fabrik_owner;
create table if not exists fabrik_private.public_agent (
 slug text primary key check (slug ~ '^[a-z0-9-]{1,40}$'),
 name text not null check (length(btrim(name)) between 1 and 80),
 purpose text not null default '' check (length(purpose) <= 500),
 model text not null default 'claude-haiku-5-5' check (model ~ '^claude-[a-z0-9.-]{1,60}$'),
 daily_cap_tokens integer not null default 500000 check (daily_cap_tokens between 1000 and 100000000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table fabrik_private.public_agent enable row level security;
revoke all on fabrik_private.public_agent from public, anon, authenticated;
alter table fabrik_private.public_agent_setting add column if not exists page_address text
 check (page_address ~ '^https://[a-z0-9.-]{1,253}(:[0-9]{1,5})?$');
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'fabrik_private' and table_name = 'public_agent_setting' and column_name = 'model') then
    if current_setting('fabrik.chat_used', true) = 'true' or exists (select 1 from fabrik_private.public_agent_usage) then
      insert into fabrik_private.public_agent(slug, name, model, daily_cap_tokens)
      select 'chat', 'Chat', model, daily_cap_tokens from fabrik_private.public_agent_setting where id
      on conflict (slug) do nothing;
    end if;
    alter table fabrik_private.public_agent_setting drop column model, drop column daily_cap_tokens;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'fabrik_private' and table_name = 'public_agent_usage' and column_name = 'slug') then
    alter table fabrik_private.public_agent_usage add column slug text;
    update fabrik_private.public_agent_usage set slug = 'chat';
    alter table fabrik_private.public_agent_usage alter column slug set not null,
      drop constraint public_agent_usage_pkey, add primary key (slug, day),
      add foreign key (slug) references fabrik_private.public_agent(slug) on delete cascade;
  end if;
end $$;
reset role;

insert into fabrik_private.schema_upgrade(id) values ('0014-public-agents') on conflict (id) do nothing;
