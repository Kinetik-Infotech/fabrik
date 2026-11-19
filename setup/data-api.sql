-- fabrik setup: the Data API serves the fabrik schema, beside Supabase's own public and graphql_public, and no other of
-- fabrik's schemas. Run as postgres, by fabrik setup --owner, after setup.sql. Supabase's
-- documentation gives this statement for exposing a schema without the dashboard; once it is set, the dashboard's
-- Exposed schemas list no longer manages the setting, and reset.sql resets it.
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, fabrik';
notify pgrst, 'reload config';
-- Check: the setting the Data API now reads.
select rolconfig from pg_roles where rolname = 'authenticator';
