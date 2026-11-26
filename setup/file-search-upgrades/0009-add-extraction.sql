-- 0009-add-extraction
-- base: 1026ac4
-- add_extraction adds entities and relations to a chunk whose extraction was saved before, and keeps what is there,
-- so a file's parts can be tagged with the business's topics after they were read. The same text is in
-- file-search.sql. Safe to run twice. Run as postgres.

-- Adds entities and relations to a chunk whose extraction was saved before, and keeps what is there. p_entities and
-- p_relations take the shape save_extraction takes. A relation may name an entity this call gives or one the chunk
-- already holds, this call's first. An entity the chunk already holds keeps its description, and a relation it
-- already holds gains this call's keywords and description. The chunk's counts are those it holds after. Only the
-- project's own functions call it, after checking the caller may read the chunk and may add to its bucket. Returns how
-- many entities and relations were added, and how many the chunk holds.
create or replace function file_search.add_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb,
 p_saved_by uuid, p_saved_by_name text) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $$
declare c record; e jsonb; r jsonb; ents jsonb:=coalesce(p_entities, '[]'::jsonb); rels jsonb:=coalesce(p_relations, '[]'::jsonb);
 eid uuid; rid uuid; a uuid; b uuid; kw text[]; n_e integer:=0; n_r integer:=0; k text; keys jsonb:='{}'::jsonb; given jsonb:='{}'::jsonb;
 n integer; held_e integer; held_r integer;
begin
 if p_saved_by is null then raise exception 'Name who saved the extraction' using errcode='22023'; end if;
 if jsonb_typeof(ents)<>'array' or jsonb_typeof(rels)<>'array' then raise exception 'Entities and relations are each a list' using errcode='22023'; end if;
 if jsonb_array_length(ents)>100 or jsonb_array_length(rels)>200 then
  raise exception 'A chunk takes at most 100 entities and 200 relations' using errcode='22023'; end if;
 select k.chunk_id, k.object_id, v.state as version_state into c from file_search.chunk k join file_search.file_version v on v.version_id=k.version_id
  where k.chunk_id=p_chunk for update of k;
 if c.chunk_id is null or c.object_id is null or c.version_state in ('retired','purged') then raise exception 'No such chunk' using errcode='22023'; end if;
 if not exists (select 1 from file_search.chunk_extraction where chunk_id=p_chunk) then
  raise exception 'This chunk is not read yet: save its extraction first' using errcode='22023'; end if;
 -- The entities the chunk holds, by name, which this call's own entities then take the place of.
 select coalesce(jsonb_object_agg(x.k, x.entity_id), '{}'::jsonb) into keys from (
  select distinct on (file_search.graph_key(s.name)) file_search.graph_key(s.name) as k, s.entity_id
  from file_search.entity_source s where s.chunk_id=p_chunk order by file_search.graph_key(s.name), s.saved_at, s.entity_id) x;
 for e in select jsonb_build_object('name', min(x->>'name'), 'type', min(x->>'type'),
   'description', string_agg(btrim(x->>'description'), ' ' order by o))
  from jsonb_array_elements(ents) with ordinality t(x, o)
  group by file_search.graph_key(x->>'name'), file_search.graph_key(x->>'type') loop
  if length(btrim(coalesce(e->>'name', ''))) not between 1 and 200 or length(btrim(coalesce(e->>'type', ''))) not between 1 and 100
   or file_search.graph_key(e->>'name')='' or file_search.graph_key(e->>'type')='' then
   raise exception 'Each entity has a name of 1 to 200 characters and a type of 1 to 100' using errcode='22023'; end if;
  if length(btrim(coalesce(e->>'description', ''))) not between 1 and 2000 then
   raise exception 'Each entity has a description of 1 to 2,000 characters: %', e->>'name' using errcode='22023'; end if;
  k:=file_search.graph_key(e->>'name');
  if given ? k then raise exception 'Two entities in this chunk share the name "%": give each a different name', e->>'name' using errcode='22023'; end if;
  insert into file_search.entity(name, name_key, entity_type, type_key)
  values (btrim(e->>'name'), k, btrim(e->>'type'), file_search.graph_key(e->>'type'))
  on conflict (name_key, type_key) do nothing returning entity_id into eid;
  if eid is null then
   select entity_id into eid from file_search.entity where name_key=k and type_key=file_search.graph_key(e->>'type');
  end if;
  insert into file_search.entity_source(entity_id, chunk_id, object_id, name, entity_type, description, saved_by, saved_by_name)
  values (eid, p_chunk, c.object_id, btrim(e->>'name'), btrim(e->>'type'), btrim(e->>'description'), p_saved_by, p_saved_by_name)
  on conflict (entity_id, chunk_id) do nothing;
  get diagnostics n=row_count;
  n_e:=n_e+n;
  given:=given||jsonb_build_object(k, eid);
 end loop;
 keys:=keys||given;
 for r in select x from jsonb_array_elements(rels) x loop
  a:=(keys->>file_search.graph_key(r->>'source'))::uuid;
  b:=(keys->>file_search.graph_key(r->>'target'))::uuid;
  if a is null or b is null then
   raise exception 'A relation names an entity this chunk does not: % to %', r->>'source', r->>'target' using errcode='22023'; end if;
  if a=b then raise exception 'A relation joins two different entities: %', r->>'source' using errcode='22023'; end if;
  if length(btrim(coalesce(r->>'description', ''))) not between 1 and 2000 then
   raise exception 'Each relation has a description of 1 to 2,000 characters: % to %', r->>'source', r->>'target' using errcode='22023'; end if;
  select coalesce(array_agg(distinct lower(btrim(w))) filter (where btrim(w)<>''), '{}') into kw
  from jsonb_array_elements_text(case jsonb_typeof(r->'keywords') when 'array' then r->'keywords'
   when 'string' then to_jsonb(string_to_array(r->>'keywords', ',')) else '[]'::jsonb end) w;
  select relation_id into rid from file_search.relation
  where least(source_id, target_id)=least(a, b) and greatest(source_id, target_id)=greatest(a, b);
  if rid is null then
   insert into file_search.relation(source_id, target_id) values (a, b)
   on conflict (least(source_id, target_id), greatest(source_id, target_id)) do nothing returning relation_id into rid;
   if rid is null then
    select relation_id into rid from file_search.relation
    where least(source_id, target_id)=least(a, b) and greatest(source_id, target_id)=greatest(a, b);
   end if;
  end if;
  if exists (select 1 from file_search.relation_source where relation_id=rid and chunk_id=p_chunk) then
   update file_search.relation_source s set keywords=(select coalesce(array_agg(distinct w order by w), '{}') from unnest(s.keywords||kw) w),
    description=case when strpos(s.description, btrim(r->>'description'))>0 then s.description else left(s.description||' '||btrim(r->>'description'), 2000) end
   where s.relation_id=rid and s.chunk_id=p_chunk;
  else
   insert into file_search.relation_source(relation_id, chunk_id, object_id, keywords, description, saved_by, saved_by_name)
   values (rid, p_chunk, c.object_id, kw, btrim(r->>'description'), p_saved_by, p_saved_by_name);
   n_r:=n_r+1;
  end if;
 end loop;
 select count(*) into held_e from file_search.entity_source where chunk_id=p_chunk;
 select count(*) into held_r from file_search.relation_source where chunk_id=p_chunk;
 update file_search.chunk_extraction set entities=held_e, relations=held_r where chunk_id=p_chunk;
 return jsonb_build_object('chunk_id', p_chunk, 'saved', true, 'added_entities', n_e, 'added_relations', n_r,
  'entities', held_e, 'relations', held_r);
end $$;
revoke all on function file_search.add_extraction(uuid,jsonb,jsonb,uuid,text) from public, anon, authenticated;

insert into file_search.schema_upgrade(id) values ('0009-add-extraction') on conflict (id) do nothing;
