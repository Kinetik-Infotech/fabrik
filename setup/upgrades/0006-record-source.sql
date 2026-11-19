-- 0006-record-source
-- base: new
-- A record of any kind may carry where it came from: source {system, id}, and the type, labels and properties it had
-- there. fabrik_find_by_source finds a record by its source, among the records the caller may read, and an index on
-- the versions that have a source serves it. fabrik_link_many saves several links from one record as one version. The
-- same text is in setup.sql. Safe to run twice. Run as the postgres login.

-- A record that came from another system carries payload.source {system, id}. A lookup by that id reads only the
-- versions that have a source, so the index is partial; it covers every version of those records, and the lookup
-- keeps the current one. An expression index on the payload needs no new column to keep in step with a save.
set role fabrik_owner;
create index if not exists version_source_idx on fabrik.record_version((payload->'source'->>'id'),(payload->'source'->>'system'))
 where payload->'source' is not null;
reset role;

-- The shape of a save request, with the four optional fields on every kind's payload.
grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
CREATE OR REPLACE FUNCTION fabrik_private.validate_shape(p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare b jsonb; x jsonb; k text; g jsonb; dt date;
begin
 perform fabrik_private.require_object(p,array['request_id','record_id','scope_id','kind','expected_previous_version_id','title','payload','links','reason']);
 if octet_length(p::text)>262144 then raise exception 'Save request exceeds 256 KiB' using errcode='22023'; end if;
 foreach k in array array['request_id','record_id','scope_id'] loop
  perform fabrik_private.require_text(p,k,false,36,true); perform (p->>k)::uuid;
 end loop;
 perform fabrik_private.require_text(p,'expected_previous_version_id',true,36,true);
 if p->>'expected_previous_version_id' is not null then perform (p->>'expected_previous_version_id')::uuid; end if;
 perform fabrik_private.require_text(p,'title',false,500,true);
 perform fabrik_private.require_text(p,'reason',false,4000,true);
 perform fabrik_private.require_text(p,'kind',false,20,true);
 perform fabrik_private.require_array(p,'links',200);
 for x in select value from jsonb_array_elements(p->'links') loop
  perform fabrik_private.require_object(x,array['target_version_id','relation'],array['locator','note']);
  perform fabrik_private.require_text(x,'target_version_id',false,36,true); perform (x->>'target_version_id')::uuid;
  if not exists(select 1 from fabrik.relation_type t where t.code=coalesce(x->>'relation','')) then
   raise exception 'Unknown link relation "%": save it with fabrik_save_relation_type, or use one fabrik_list_relation_types lists',coalesce(x->>'relation','') using errcode='22023';
  end if;
  if x ? 'locator' then perform fabrik_private.require_text(x,'locator',true,2000); end if;
  if x ? 'note' then perform fabrik_private.require_text(x,'note',true,4000); end if;
 end loop;
 b:=p->'payload';
 case p->>'kind'
 when 'activity' then
  perform fabrik_private.require_object(b,array['activity_kind','description','completion_requirements','state','baseline_start_at','baseline_finish_at','forecast_start_at','forecast_finish_at','blockers','external_references','completion_note'],array['owner_actor_id','owner_label','index','task_type','assignee_actor_id','source','type','labels','properties']);
  if coalesce(b->>'activity_kind','') not in ('plan','task') then raise exception 'Invalid activity kind or state' using errcode='22023'; end if;
  if b ? 'assignee_actor_id' and b->'assignee_actor_id'<>'null'::jsonb then
   if b->>'activity_kind'<>'task' then raise exception 'Only a task has an assignee' using errcode='22023'; end if;
   perform fabrik_private.require_text(b,'assignee_actor_id',false,36,true); perform (b->>'assignee_actor_id')::uuid;
  end if;
  if b ? 'owner_actor_id' and b->'owner_actor_id'<>'null'::jsonb then
   perform fabrik_private.require_text(b,'owner_actor_id',false,36,true); perform (b->>'owner_actor_id')::uuid;
  end if;
  if b ? 'index' then
   perform fabrik_private.require_text(b,'index',false,20,true);
   if (b->>'index') ~ '[[:cntrl:]]' then raise exception 'An activity index is one line' using errcode='22023'; end if;
  end if;
  if b ? 'task_type' then
   if b->>'activity_kind'<>'task' then raise exception 'Only a task has a task type' using errcode='22023'; end if;
   if coalesce(b->>'task_type','') not in ('work','deliverable','blocker') then raise exception 'Task types are work, deliverable and blocker' using errcode='22023'; end if;
  end if;
  if coalesce(b->>'state','') not in ('pending','in_progress','paused','completed','cancelled') then
   raise exception 'Activity states are pending, in_progress, paused, completed and cancelled' using errcode='22023';
  end if;
  foreach k in array array['description','completion_requirements','completion_note'] loop perform fabrik_private.require_text(b,k); end loop;
  if b ? 'owner_label' then perform fabrik_private.require_text(b,'owner_label',true,200); end if;
  foreach k in array array['baseline_start_at','baseline_finish_at','forecast_start_at','forecast_finish_at'] loop perform fabrik_private.iso_time(b,k); end loop;
  if fabrik_private.iso_time(b,'baseline_start_at')>fabrik_private.iso_time(b,'baseline_finish_at') or
     fabrik_private.iso_time(b,'forecast_start_at')>fabrik_private.iso_time(b,'forecast_finish_at') then
   raise exception 'Start must not follow finish' using errcode='22023';
  end if;
  perform fabrik_private.require_array(b,'blockers',20);
  for x in select value from jsonb_array_elements(b->'blockers') loop
   perform fabrik_private.require_object(x,array['blocker_id','description']);
   perform fabrik_private.require_text(x,'blocker_id',false,36,true); perform (x->>'blocker_id')::uuid;
   perform fabrik_private.require_text(x,'description',false,4000,true);
  end loop;
  if exists(select 1 from jsonb_array_elements(b->'blockers') v group by v->>'blocker_id' having count(*)>1) then raise exception 'Duplicate blocker ID' using errcode='22023'; end if;
  perform fabrik_private.require_array(b,'external_references',10);
  for x in select value from jsonb_array_elements(b->'external_references') loop
   perform fabrik_private.require_object(x,array['label','reference']);
   perform fabrik_private.require_text(x,'label',false,200,true);
   perform fabrik_private.require_text(x,'reference',false,2000,true);
   perform fabrik_private.validate_reference('external_references.reference',x->>'reference');
  end loop;
 when 'decision' then
  perform fabrik_private.require_object(b,array['question','alternatives','decision','rationale','decided_on'],array['source','type','labels','properties']);
  foreach k in array array['question','decision','rationale'] loop perform fabrik_private.require_text(b,k); end loop;
  perform fabrik_private.require_array(b,'alternatives',10);
  for x in select value from jsonb_array_elements(b->'alternatives') loop
   if jsonb_typeof(x)<>'string' or length(x#>>'{}')>1000 then raise exception 'Invalid alternative' using errcode='22023'; end if;
  end loop;
  if b->'decided_on'<>'null'::jsonb then
   perform fabrik_private.require_text(b,'decided_on',false,10,true);
   if (b->>'decided_on') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid decision date' using errcode='22023'; end if;
   dt:=(b->>'decided_on')::date;
  end if;
  if b->>'decision'='' and b->'decided_on'<>'null'::jsonb then raise exception 'Undecided question cannot have decision date' using errcode='22023'; end if;
 when 'evidence' then
  perform fabrik_private.require_object(b,array['summary','source_reference','source_date','standing','limitations'],array['file_sha256','source','type','labels','properties']);
  foreach k in array array['summary','limitations'] loop perform fabrik_private.require_text(b,k); end loop;
  perform fabrik_private.require_text(b,'source_reference',true,2000);
  perform fabrik_private.validate_reference('source_reference',b->>'source_reference');
  if b->'source_date'<>'null'::jsonb then
   perform fabrik_private.require_text(b,'source_date',false,10,true);
   if (b->>'source_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid source date' using errcode='22023'; end if;
   dt:=(b->>'source_date')::date;
  end if;
  if coalesce(b->>'standing','') not in ('stated','observed','unverified') then raise exception 'Invalid evidence standing' using errcode='22023'; end if;
  if b ? 'file_sha256' and (jsonb_typeof(b->'file_sha256') is distinct from 'string' or (b->>'file_sha256') !~ '^[0-9a-f]{64}$') then raise exception 'Invalid file checksum' using errcode='22023'; end if;
 when 'model' then
  perform fabrik_private.require_object(b,array['model_kind','source_version','source_status','description','graph'],array['source','type','labels','properties']);
  if coalesce(b->>'model_kind','') not in ('observed_current','proposed_target') then raise exception 'Invalid model kind' using errcode='22023'; end if;
  foreach k in array array['source_version','source_status','description'] loop perform fabrik_private.require_text(b,k); end loop;
  g:=b->'graph';
  perform fabrik_private.require_object(g,array['format_version','nodes','edges']);
  if g->'format_version' is distinct from '1'::jsonb then raise exception 'Unsupported graph format' using errcode='22023'; end if;
  perform fabrik_private.require_array(g,'nodes',1000); perform fabrik_private.require_array(g,'edges',5000);
  for x in select value from jsonb_array_elements(g->'nodes') loop
   perform fabrik_private.require_object(x,array['id','type','label','attributes']);
   perform fabrik_private.require_text(x,'id',false,100,true); perform fabrik_private.require_text(x,'type',false,100,true);
   perform fabrik_private.require_text(x,'label',false,500);
   if jsonb_typeof(x->'attributes') is distinct from 'object' then raise exception 'Node attributes must be an object' using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(g->'nodes') n group by n->>'id' having count(*)>1) then raise exception 'Duplicate graph node ID' using errcode='22023'; end if;
  for x in select value from jsonb_array_elements(g->'edges') loop
   perform fabrik_private.require_object(x,array['id','source','target','type','attributes']);
   foreach k in array array['id','source','target','type'] loop perform fabrik_private.require_text(x,k,false,100,true); end loop;
   if jsonb_typeof(x->'attributes') is distinct from 'object' then raise exception 'Edge attributes must be an object' using errcode='22023'; end if;
   if not exists(select 1 from jsonb_array_elements(g->'nodes') n where n->>'id'=x->>'source') or
      not exists(select 1 from jsonb_array_elements(g->'nodes') n where n->>'id'=x->>'target') then raise exception 'Missing graph endpoint' using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(g->'edges') e group by e->>'id' having count(*)>1) then raise exception 'Duplicate graph edge ID' using errcode='22023'; end if;
 else raise exception 'Unknown record kind' using errcode='22023';
 end case;
 -- A record that came from another system names it: source {system, id}, both text.
 if b ? 'source' then
  if jsonb_typeof(b->'source') is distinct from 'object' then raise exception 'Invalid source' using errcode='22023'; end if;
  perform fabrik_private.require_object(b->'source',array['system','id']);
  perform fabrik_private.require_text(b->'source','system',false,100,true);
  perform fabrik_private.require_text(b->'source','id',false,200,true);
 end if;
 -- Any kind may also carry the type and labels it had there, and its properties, an object of any keys.
 if b ? 'type' then perform fabrik_private.require_text(b,'type',false,100,true); end if;
 if b ? 'labels' then
  perform fabrik_private.require_array(b,'labels',200);
  if exists(select 1 from jsonb_array_elements(b->'labels') l where jsonb_typeof(l) is distinct from 'string' or length(l#>>'{}')>200) then
   raise exception 'Invalid labels' using errcode='22023'; end if;
 end if;
 if b ? 'properties' and jsonb_typeof(b->'properties') is distinct from 'object' then raise exception 'Invalid properties' using errcode='22023'; end if;
end $function$
;
reset role;
revoke create on schema fabrik_private from fabrik_writer;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
-- The record that came from another system: the one whose current version's payload.source names the system and
-- the id it had there, among the records the caller may read that are not deleted. Null when there is none. A
-- deleted record's versions are emptied, so it never matches. The first record created wins if two carry one source.
create or replace function fabrik.fabrik_find_by_source(p_system text, p_id text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare found_id uuid;
begin
 perform fabrik_private.read_actor();
 select r.record_id into found_id from fabrik.record_version v join fabrik.record r using(record_id)
 where v.payload->'source' is not null and v.payload->'source'->>'id'=p_id and v.payload->'source'->>'system'=p_system
  and r.deleted_at is null
  and v.change_no=(select max(c.change_no) from fabrik.record_version c where c.record_id=v.record_id)
  and fabrik_private.can_read_record(r.record_id)
 order by r.created_at,r.record_id limit 1;
 return found_id;
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
revoke all on function fabrik.fabrik_find_by_source(text,text) from public, anon;
grant execute on function fabrik.fabrik_find_by_source(text,text) to authenticated;
notify pgrst, 'reload schema';

-- Several links from one record, saved as one version. Each is {target, relation, note, locator}, the target named
-- as fabrik_link names it, and goes to the target's latest version. As fabrik_link does, each replaces the record's
-- link of that relation to the same record, and a parent replaces any other parent. A list that names one link
-- twice is refused.
grant create on schema fabrik to fabrik_reader;
set role fabrik_owner;
grant create on schema fabrik_task to fabrik_reader;
reset role;
set role fabrik_reader;
create or replace function fabrik_task.link_many(p_record text, p_links jsonb, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare rid uuid:=fabrik_task.record_id(p_record); r jsonb; added jsonb; kept jsonb; made jsonb;
begin
 if jsonb_typeof(p_links) is distinct from 'array' or jsonb_array_length(p_links)=0 or exists(select 1 from jsonb_array_elements(p_links) l
   where jsonb_typeof(l) is distinct from 'object' or jsonb_typeof(l->'target') is distinct from 'string' or jsonb_typeof(l->'relation') is distinct from 'string') then
  raise exception 'Give the links as a list, each with a target and a relation' using errcode='22023';
 end if;
 if jsonb_array_length(p_links)>200 then raise exception 'Too many items: links' using errcode='22023'; end if;
 select jsonb_agg(jsonb_build_object('target_record_id',fabrik_task.record_id(l->>'target'),'relation',l->'relation','note',l->'note','locator',l->'locator') order by n)
  into added from jsonb_array_elements(p_links) with ordinality x(l,n);
 if exists(select 1 from jsonb_array_elements(added) a group by a->>'relation',a->>'target_record_id' having count(*)>1)
   or (select count(*) from jsonb_array_elements(added) a where a->>'relation'='parent')>1 then
  raise exception 'The list names one link twice' using errcode='22023';
 end if;
 r:=fabrik_task.latest(rid);
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',l->'target_version_id','relation',l->'relation','locator',l->'locator','note',l->'note'))
  order by (l->>'link_id')::uuid),'[]'::jsonb) into kept
 from jsonb_array_elements(r->'links') l
 where not exists(select 1 from jsonb_array_elements(fabrik_task.version_links((r->'version'->>'version_id')::uuid)) m
   join jsonb_array_elements(added) a on a->>'relation'=m->>'relation' and (a->>'target_record_id'=m->>'target_record_id' or a->>'relation'='parent')
  where m->>'link_id'=l->>'link_id');
 select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('target_version_id',fabrik_task.latest((a->>'target_record_id')::uuid)->'version'->'version_id',
  'relation',a->'relation','locator',a->'locator','note',a->'note')) order by n) into made from jsonb_array_elements(added) with ordinality y(a,n);
 return fabrik_task.change(rid,p_reason,'{}'::jsonb,null,kept||made,p_preview);
end $$;

create or replace function fabrik.fabrik_link_many(p_record text, p_links jsonb, p_reason text, p_preview boolean default false) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text; r uuid;
begin
 return fabrik_task.link_many(p_record,p_links,p_reason,p_preview);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 begin r:=fabrik_task.record_id(p_record); exception when others then r:=null; end;
 return fabrik_task.refused('fabrik_link_many',m,null,null,coalesce(r::text,p_record));
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;
revoke all on function fabrik_task.link_many(text,jsonb,text,boolean), fabrik.fabrik_link_many(text,jsonb,text,boolean) from public, anon;
grant execute on function fabrik_task.link_many(text,jsonb,text,boolean), fabrik.fabrik_link_many(text,jsonb,text,boolean) to authenticated;
notify pgrst, 'reload schema';

insert into fabrik_private.schema_upgrade(id) values ('0006-record-source') on conflict (id) do nothing;
