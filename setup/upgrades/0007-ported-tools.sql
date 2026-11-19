-- 0007-ported-tools
-- base: 9b5d53d
-- redeploy: fabrik-apps
-- The database side of the fabrik-apps connector's ported tools: the relation types they link by, an index on a
-- record's payload.type, the lookups fabrik_find_by_name, fabrik_find_typed, fabrik_find_contacts and fabrik_linked,
-- fabrik_change_properties, fabrik_ready_tasks, and the rule that a title names the record not deleted that has it.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

set role fabrik_owner;
insert into fabrik.relation_type(code,description,single_parent) values
 ('has_task','The source project holds the target task.',false),
 ('blocks','The source task must finish before the target task can start.',false),
 ('has_step','The source workflow has the target as one of its steps.',false),
 ('member_of','The source person or organisation belongs to the target group.',false),
 ('authored','The source person wrote the target.',false),
 ('mentions','The source names the target.',false)
on conflict (code) do nothing;
create index if not exists version_type_idx on fabrik.record_version((payload->>'type')) where payload->>'type' is not null;
reset role;

-- ===================================================================
-- The lookups and the change the connector's ported tools share. A record whose latest payload holds
-- properties.trashed_at is trashed: the ported delete_record saves it so, and restore_record removes it.
-- The lookups leave trashed records out unless asked for them.
-- ===================================================================

-- A title names a record by one rule, here and in fabrik_task.record_id: the one record not trashed that has the
-- title, or, when no record not trashed has it, the one trashed record that has it. Where more than one could be
-- meant, the refusal lists each, a trashed one marked deleted. An id names any record.
set role fabrik_owner;
create or replace function fabrik_task.record_id(p_record text, p_scope uuid) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); page jsonb; cut bigint; cur bigint; hits jsonb:='[]'::jsonb; live jsonb;
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return t::uuid; end if;
 loop
  page:=fabrik.fabrik_find_records(null,p_scope,t,cut,cur,100);
  cut:=(page->>'cutoff')::bigint;
  hits:=hits||coalesce((select jsonb_agg(x) from jsonb_array_elements(page->'items') x where lower(btrim(x->>'title'))=lower(t)),'[]'::jsonb);
  cur:=(page->>'next_cursor')::bigint;
  exit when cur is null;
 end loop;
 if jsonb_array_length(hits)=1 then return (hits->0->>'record_id')::uuid; end if;
 if jsonb_array_length(hits)=0 then raise exception 'Record unavailable: no record you can read has the title "%"',t using errcode='42501'; end if;
 -- Only where more than one has the title is each read for whether it is trashed.
 select jsonb_agg(x||jsonb_build_object('deleted',
  fabrik.fabrik_get_record((x->>'record_id')::uuid)->'version'->'payload'->'properties'->'trashed_at' is not null)) into hits
 from jsonb_array_elements(hits) x;
 select coalesce(jsonb_agg(x),'[]'::jsonb) into live from jsonb_array_elements(hits) x where not (x->>'deleted')::boolean;
 if jsonb_array_length(live)=1 then return (live->0->>'record_id')::uuid; end if;
 raise exception 'More than one record has the title "%": %',t,
  (select string_agg(format('%s (%s, saved %s%s, id %s)',x->>'title',fabrik_task.scope_name((x->>'scope_id')::uuid),x->>'saved_at',
    case when (x->>'deleted')::boolean then ', deleted' else '' end,x->>'record_id'),'; ')
   from jsonb_array_elements(hits) x) using errcode='22023';
end $$;
revoke all on function fabrik_task.record_id(text,uuid) from public, anon;
grant execute on function fabrik_task.record_id(text,uuid) to authenticated;

-- The record named by its id, or by its title by fabrik_task.record_id's rule and in its words, for the security
-- definer reads, which cannot run fabrik_task. A record the caller may not read, or a deleted one, is refused as
-- unavailable.
create or replace function fabrik_private.readable_record_id(p_record text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare t text:=btrim(coalesce(p_record,'')); rid uuid; hits jsonb; live jsonb;
begin
 if t='' then raise exception 'Name a record by its id or its title' using errcode='22023'; end if;
 if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then rid:=t::uuid;
 else
  select coalesce(jsonb_agg(jsonb_build_object('record_id',r.record_id,'title',v.title,'scope',s.display_name,'saved_at',v.recorded_at,
   'deleted',v.payload->'properties'->'trashed_at' is not null) order by v.change_no desc),'[]'::jsonb)
  into hits from fabrik.record_version v join fabrik.record r using(record_id) join fabrik.scope s on s.scope_id=r.scope_id
  where lower(btrim(v.title))=lower(t) and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id);
  if jsonb_array_length(hits)=0 then raise exception 'Record unavailable: no record you can read has the title "%"',t using errcode='42501'; end if;
  select coalesce(jsonb_agg(x),'[]'::jsonb) into live from jsonb_array_elements(hits) x where not (x->>'deleted')::boolean;
  if jsonb_array_length(hits)=1 then rid:=(hits->0->>'record_id')::uuid;
  elsif jsonb_array_length(live)=1 then rid:=(live->0->>'record_id')::uuid;
  else
   raise exception 'More than one record has the title "%": %',t,(select string_agg(format('%s (%s, saved %s%s, id %s)',x->>'title',x->>'scope',x->>'saved_at',
    case when (x->>'deleted')::boolean then ', deleted' else '' end,x->>'record_id'),'; ') from jsonb_array_elements(hits) x) using errcode='22023';
  end if;
 end if;
 if not fabrik_private.can_read_record(rid) or exists(select 1 from fabrik.record where record_id=rid and deleted_at is not null) then
  raise exception 'Record unavailable' using errcode='42501';
 end if;
 return rid;
end $$;
reset role;
revoke all on function fabrik_private.readable_record_id(text) from public, anon, authenticated;
grant execute on function fabrik_private.readable_record_id(text) to fabrik_reader;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- The records whose title is p_name, ignoring case and outer spaces, and whose payload.type is p_type when it is
-- given: latest versions of records the caller may read, not deleted, newest save first, at most 50. Trashed records
-- are left out unless p_trashed; each item's deleted is true for a trashed one.
create or replace function fabrik.fabrik_find_by_name(p_name text, p_type text default null, p_trashed boolean default false) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform fabrik_private.read_actor();
 select coalesce(jsonb_agg(jsonb_build_object('record_id',x.record_id,'kind',x.kind,'type',x.payload->'type','title',x.title,
  'scope_id',x.scope_id,'saved_at',x.recorded_at,'deleted',x.payload->'properties'->'trashed_at' is not null) order by x.change_no desc),'[]'::jsonb) into result
 from (select r.record_id,r.kind,r.scope_id,v.title,v.payload,v.recorded_at,v.change_no
  from fabrik.record_version v join fabrik.record r using(record_id)
  where lower(btrim(v.title))=lower(btrim(coalesce(p_name,'')))
   and (p_type is null or v.payload->>'type'=p_type)
   and (coalesce(p_trashed,false) or v.payload->'properties'->'trashed_at' is null)
   and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id)
  order by v.change_no desc limit 50) x;
 return result;
end $$;

-- The records of one payload.type whose payload holds p_match, and whose title holds every word of p_words in any
-- case: latest versions of records the caller may read, not deleted, trashed ones only when p_trashed and otherwise
-- none. With p_own, only the caller's own: those whose first version was saved for the person the caller answers to,
-- which fabrik keeps and no payload can set. Each item's latest_own is true when its latest version was also saved for
-- that person, so a caller can leave out a record someone else changed last. With p_records, only those records.
-- Newest save first, at most p_limit (1 to 500); more is true when there were more.
create or replace function fabrik.fabrik_find_typed(p_type text, p_match jsonb default '{}', p_words text default null,
 p_trashed boolean default false, p_limit integer default 100, p_own boolean default false, p_records uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare n integer:=coalesce(p_limit,100); words text[]; result jsonb; me fabrik.actor;
begin
 me:=fabrik_private.read_actor();
 if n<1 or n>500 then raise exception 'The limit is 1 to 500' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_match,'{}'::jsonb))<>'object' then raise exception 'The match is a JSON object' using errcode='22023'; end if;
 words:=array(select w from regexp_split_to_table(lower(btrim(coalesce(p_words,''))),'\s+') w where w<>'');
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('record_id',x.record_id,'kind',x.kind,'scope_id',x.scope_id,'title',x.title,
  'version_id',x.version_id,'saved_at',x.recorded_at,'payload',x.payload,'latest_own',x.accountable_human_id=me.accountable_human_id)
  order by x.change_no desc) filter (where x.rn<=n),'[]'::jsonb),
  'more',count(*)>n) into result
 from (select r.record_id,r.kind,r.scope_id,v.title,v.version_id,v.recorded_at,v.payload,v.change_no,v.accountable_human_id,
  row_number() over (order by v.change_no desc) rn
  from fabrik.record_version v join fabrik.record r using(record_id)
  where v.payload->>'type'=p_type
   and (p_records is null or v.record_id=any(p_records))
   and v.payload@>coalesce(p_match,'{}'::jsonb)
   and (select bool_and(strpos(lower(coalesce(v.title,'')),w)>0) from unnest(words) w) is not false
   and (v.payload->'properties'->'trashed_at' is not null)=coalesce(p_trashed,false)
   and (not coalesce(p_own,false) or exists(select 1 from fabrik.record_version f where f.record_id=v.record_id and f.version_number=1
    and f.accountable_human_id=me.accountable_human_id))
   and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id)
  order by v.change_no desc limit n+1) x;
 return result;
end $$;

-- The contacts, records of type Person or Organization, whose properties.email is p_value in any case and with no outer
-- spaces (p_key email), or whose properties.telephone has p_value's digits and leading + (p_key telephone): latest
-- versions of records the caller may read, not deleted and not trashed. Items as fabrik_find_typed gives them, newest
-- save first, at most p_limit (1 to 500); more is true when there were more.
create or replace function fabrik.fabrik_find_contacts(p_key text, p_value text, p_limit integer default 10) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare n integer:=coalesce(p_limit,10); want text; result jsonb; me fabrik.actor;
begin
 me:=fabrik_private.read_actor();
 if n<1 or n>500 then raise exception 'The limit is 1 to 500' using errcode='22023'; end if;
 if coalesce(p_key,'') not in ('email','telephone') then raise exception 'The key is email or telephone' using errcode='22023'; end if;
 want:=case when p_key='email' then lower(btrim(coalesce(p_value,''))) else regexp_replace(coalesce(p_value,''),'[^0-9+]','','g') end;
 if want in ('','+') then raise exception 'Give the % to find',p_key using errcode='22023'; end if;
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('record_id',x.record_id,'kind',x.kind,'scope_id',x.scope_id,'title',x.title,
  'version_id',x.version_id,'saved_at',x.recorded_at,'payload',x.payload,'latest_own',x.accountable_human_id=me.accountable_human_id)
  order by x.change_no desc) filter (where x.rn<=n),'[]'::jsonb),
  'more',count(*)>n) into result
 from (select r.record_id,r.kind,r.scope_id,v.title,v.version_id,v.recorded_at,v.payload,v.change_no,v.accountable_human_id,
  row_number() over (order by v.change_no desc) rn
  from fabrik.record_version v join fabrik.record r using(record_id)
  where v.payload->>'type' in ('Person','Organization')
   and case when p_key='email' then lower(btrim(v.payload->'properties'->>'email'))
    else regexp_replace(v.payload->'properties'->>'telephone','[^0-9+]','','g') end=want
   and v.payload->'properties'->'trashed_at' is null
   and r.deleted_at is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id)
  order by v.change_no desc limit n+1) x;
 return result;
end $$;

-- The records linked to or from p_record by a relation in p_relations. 'out': the targets of the links of
-- p_record's latest version, each at its latest version. 'in': the records whose latest version links to any version
-- of p_record. 'both': the two together. Records the caller may read, not deleted and not trashed, newest save first.
-- p_record is named as fabrik_task.record_id names a record, through fabrik_private.readable_record_id.
create or replace function fabrik.fabrik_linked(p_record text, p_relations text[], p_direction text default 'both') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rid uuid; latest uuid; result jsonb;
begin
 perform fabrik_private.read_actor();
 if coalesce(p_direction,'') not in ('out','in','both') then raise exception 'The direction is out, in or both' using errcode='22023'; end if;
 rid:=fabrik_private.readable_record_id(p_record);
 select v.version_id into latest from fabrik.record_version v where v.record_id=rid order by v.change_no desc limit 1;
 with found as (
  select tv.record_id,l.relation,'out' as direction,l.note from fabrik.version_link l join fabrik.record_version tv on tv.version_id=l.target_version_id
  where p_direction in ('out','both') and l.source_version_id=latest and l.relation=any(p_relations)
  union all
  select sv.record_id,l.relation,'in',l.note from fabrik.version_link l join fabrik.record_version sv on sv.version_id=l.source_version_id
   join fabrik.record_version tv on tv.version_id=l.target_version_id
  where p_direction in ('in','both') and tv.record_id=rid and l.relation=any(p_relations)
   and sv.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=sv.record_id))
 select coalesce(jsonb_agg(jsonb_build_object('record_id',f.record_id,'kind',r.kind,'type',v.payload->'type','title',v.title,'relation',f.relation,
  'direction',f.direction,'note',f.note,'saved_at',v.recorded_at,'payload',v.payload) order by v.change_no desc,f.relation,f.direction),'[]'::jsonb) into result
 from found f join fabrik.record r on r.record_id=f.record_id
 join fabrik.record_version v on v.record_id=f.record_id and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=f.record_id)
 where r.deleted_at is null and v.payload->'properties'->'trashed_at' is null and fabrik_private.can_read_record(r.record_id);
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_find_by_name(text,text,boolean), fabrik.fabrik_find_typed(text,jsonb,text,boolean,integer,boolean,uuid[]),
 fabrik.fabrik_find_contacts(text,text,integer), fabrik.fabrik_linked(text,text[],text) from public, anon;
grant execute on function fabrik.fabrik_find_by_name(text,text,boolean), fabrik.fabrik_find_typed(text,jsonb,text,boolean,integer,boolean,uuid[]),
 fabrik.fabrik_find_contacts(text,text,integer), fabrik.fabrik_linked(text,text[],text) to authenticated;
notify pgrst, 'reload schema';

-- A new version of a record whose properties are its old ones with p_properties merged in, a key given as JSON null
-- removed; p_fields merged into the payload's top level, as fabrik_change_record merges them; its title p_title when
-- given; its links kept. It answers as fabrik_change_record does.
grant create on schema fabrik to fabrik_reader;
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_reader;
reset role;
set role fabrik_reader;
create or replace function fabrik_task.change_properties(p_record text, p_reason text, p_properties jsonb, p_fields jsonb default '{}',
 p_title text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); p jsonb:=coalesce(p_properties,'{}'::jsonb); f jsonb:=coalesce(p_fields,'{}'::jsonb); old jsonb; merged jsonb;
begin
 if jsonb_typeof(p)<>'object' then raise exception 'The properties are a JSON object' using errcode='22023'; end if;
 if jsonb_typeof(f)<>'object' then raise exception 'The fields are a JSON object' using errcode='22023'; end if;
 old:=fabrik_task.latest(rid)->'version'->'payload'->'properties';
 merged:=(case when jsonb_typeof(old)='object' then old else '{}'::jsonb end||p)-array(select key from jsonb_each(p) where value='null'::jsonb);
 -- A record with no properties gains none from a change that sets none.
 f:=f-'properties'||case when old is null and merged='{}'::jsonb then '{}'::jsonb else jsonb_build_object('properties',merged) end;
 return fabrik_task.change(rid,p_reason,f,p_title,null,p_preview);
end $$;

create or replace function fabrik.fabrik_change_properties(p_record text, p_reason text, p_properties jsonb, p_fields jsonb default '{}',
 p_title text default null, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.change_properties(p_record,p_reason,p_properties,p_fields,p_title,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_change_properties',m,null,null,coalesce(r::text,p_record));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on function fabrik_task.change_properties(text,text,jsonb,jsonb,text,boolean), fabrik.fabrik_change_properties(text,text,jsonb,jsonb,text,boolean) from public, anon;
grant execute on function fabrik_task.change_properties(text,text,jsonb,jsonb,text,boolean), fabrik.fabrik_change_properties(text,text,jsonb,jsonb,text,boolean) to authenticated;
notify pgrst, 'reload schema';

-- The tasks ready to start: open, untrashed tasks the caller may read, not deleted, with no blocks link to any of
-- their versions from the latest version of an open, untrashed task the caller may read. Open is neither completed
-- nor cancelled. With p_project, only the project's tasks: those its latest version links by has_task, and those
-- whose latest version has a parent link to it. Soonest forecast finish first, then by title.
grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
create or replace function fabrik.fabrik_ready_tasks(p_project text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare pid uuid; result jsonb;
begin
 perform fabrik_private.read_actor();
 if p_project is not null then
  pid:=fabrik_private.readable_record_id(p_project);
  -- A has_task link also comes from a person or a business that has a task, as maxy-code kept it: only a plan's are a project's.
  if not exists(select 1 from fabrik.record_version v where v.record_id=pid and v.payload->>'activity_kind'='plan'
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=pid)) then
   raise exception 'Not a project: "%" is not a plan',p_project using errcode='22023';
  end if;
 end if;
 with latest as (
  select r.record_id,v.version_id,v.title,v.payload,v.recorded_at
  from fabrik.record_version v join fabrik.record r using(record_id)
  where r.kind='activity' and v.payload->>'activity_kind'='task' and r.deleted_at is null
   and coalesce(v.payload->>'state','') not in ('completed','cancelled')
   and v.payload->'properties'->'trashed_at' is null
   and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
   and fabrik_private.can_read_record(r.record_id))
 select coalesce(jsonb_agg(jsonb_build_object('record_id',t.record_id,'title',t.title,'state',t.payload->'state','saved_at',t.recorded_at,'payload',t.payload)
  order by t.payload->>'forecast_finish_at' nulls last,t.title,t.record_id),'[]'::jsonb) into result
 from latest t
 where (pid is null
   or exists(select 1 from fabrik.version_link l join fabrik.record_version tv on tv.version_id=l.target_version_id
    where l.relation='has_task' and tv.record_id=t.record_id
     and l.source_version_id=(select p.version_id from fabrik.record_version p where p.record_id=pid order by p.change_no desc limit 1))
   or exists(select 1 from fabrik.version_link l join fabrik.record_version pv on pv.version_id=l.target_version_id
    where l.relation='parent' and l.source_version_id=t.version_id and pv.record_id=pid))
  and not exists(select 1 from fabrik.version_link l join fabrik.record_version tv on tv.version_id=l.target_version_id
   join latest b on b.version_id=l.source_version_id
   where l.relation='blocks' and tv.record_id=t.record_id);
 return result;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_ready_tasks(text) from public, anon;
grant execute on function fabrik.fabrik_ready_tasks(text) to authenticated;
notify pgrst, 'reload schema';

insert into fabrik_private.schema_upgrade(id) values ('0007-ported-tools') on conflict (id) do nothing;
