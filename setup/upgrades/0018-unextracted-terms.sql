-- 0018-unextracted-terms
-- base: 9414854
-- fabrik_get_unextracted lists the glossary's terms of a class without their definitions, as a definition needs read
-- in the reference scope. The same text is in setup.sql. Safe to run twice. Run as the postgres login.

-- The chunks of a scope's files whose graph no agent has saved yet, for the caller's agent to read and extract, with
-- the glossary's classes and relationships to extract them with, and its terms that name one thing of a class as
-- instances, each with its class and the term it comes under as broader. A definition needs read in the reference
-- scope, through get_reference, so none is given here. Needs read in the scope.
-- Owned by postgres, which owns file search: the scope's bucket is checked here with fabrik's storage rules, and file
-- search lists its chunks.
create or replace function fabrik.fabrik_get_unextracted(p_scope text, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare sc fabrik.scope;
begin
 perform fabrik_private.read_actor();
 begin
  sc:=fabrik_private.named_scope(p_scope);
 exception when insufficient_privilege then sc:=null;
 end;
 if sc.code is null or sc.code not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
 end if;
 if to_regprocedure('file_search.unextracted(text,integer)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 return jsonb_build_object('scope',sc.display_name,'code',sc.code,
  'classes',(select coalesce(jsonb_agg(term order by lower(term)),'[]'::jsonb) from fabrik.glossary_term where kind='class'),
  'relationships',(select coalesce(jsonb_agg(jsonb_build_object('relationship',term,'from_class',from_class,'to_class',to_class) order by lower(term)),'[]'::jsonb)
   from fabrik.glossary_term where kind='relationship'),
  'instances',(select coalesce(jsonb_agg(jsonb_build_object('term',i.term,'class',i.class,'broader',i.broader)
    order by lower(i.class), lower(i.term)),'[]'::jsonb) from fabrik_private.glossary_instances() i))||file_search.unextracted(sc.code,p_limit);
end $$;

insert into fabrik_private.schema_upgrade(id) values ('0018-unextracted-terms') on conflict (id) do nothing;
