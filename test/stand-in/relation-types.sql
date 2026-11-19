-- Checks the governed list of link relations against the real functions: the ten seeded relations
-- exist with parent alone a single parent; a link with a relation not on the list is refused with a
-- clear error; an administrator saves the relation with fabrik_save_relation_type and the same link
-- then saves; an agent, though it holds create and edit on the reference scope, cannot save one;
-- any signed-in actor lists them. The administrator rule and a code's one owner hold on the route through
-- fabrik_save_version too, and a version has at most one parent link.
-- Ends in an error, so nothing is kept.
begin;
create function pg_temp.raised(p_answer jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $raised$
begin
 if jsonb_typeof(p_answer)='object' and p_answer->'refused'='true'::jsonb then
  raise exception '%',p_answer->>'problem' using errcode='42501';
 end if;
 return p_answer;
end $raised$;
do $w$
declare h uuid:=gen_random_uuid(); ag uuid:=gen_random_uuid(); admin_id uuid; agent_id uuid; sid uuid; gid uuid; g jsonb;
 tgt jsonb; req jsonb; v jsonb; msg text; ans jsonb; seeds text; rel jsonb; p1 jsonb; p2 jsonb; act jsonb;
begin
 -- The seeds, as a new build holds them.
 select string_agg(code||':'||single_parent,',' order by code) into seeds from fabrik.relation_type;
 if seeds is distinct from 'authored:false,blocks:false,depends_on:false,describes:false,has_step:false,has_task:false,member_of:false,mentions:false,parent:true,supports:false' then
  raise exception 'FAIL the seeded relations are %',seeds; end if;

 insert into auth.users(id) values(h),(ag);
 admin_id:=fabrik_private.provision_first_administrator(h,'Relation check administrator');
 select scope_id into sid from fabrik.scope where code='reference';
 if sid is null then
  insert into fabrik.scope(code,display_name,description,created_by) values('reference','Reference data','Rolled back',admin_id) returning scope_id into sid;
 end if;
 agent_id:=fabrik_private.provision_actor(admin_id,ag,'Relation check agent','agent',admin_id,'restricted',false);
 g:=fabrik_private.provision_grant(admin_id,gen_random_uuid(),agent_id,sid,array['model'],null::uuid,array['read','create','edit'],null::timestamptz,'Relation check grant');
 gid:=(g->>'authorisation_id')::uuid;

 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 -- A target record, and a record linking to it with a relation nobody has saved.
 tgt:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
  'expected_previous_version_id',null,'title','Link target','reason','Relation check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','relation check','source_status','saved','description','A target',
   'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)))));
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
  'expected_previous_version_id',null,'title','Link source','reason','Relation check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',tgt->>'version_id','relation','quotes')),
  'payload',jsonb_build_object('model_kind','observed_current','source_version','relation check','source_status','saved','description','A source',
   'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)));
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(req)); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'Unknown link relation "quotes": save it with fabrik_save_relation_type, or use one fabrik_list_relation_types lists' then
  raise exception 'FAIL a link with an unknown relation: %',msg; end if;

 -- An administrator saves the relation, and the same link then saves.
 ans:=pg_temp.raised(fabrik.fabrik_save_relation_type('quotes','The source names the target in passing.'));
 if not fabrik.fabrik_list_relation_types() @> '[{"code":"quotes","description":"The source names the target in passing.","single_parent":false}]' then
  raise exception 'FAIL the saved relation: %',ans; end if;
 v:=pg_temp.raised(fabrik.fabrik_save_version(req));
 execute 'reset role';
 if (select version_id from fabrik.relation_type where code='quotes')<>(ans->>'version_id')::uuid then
  raise exception 'FAIL the relation is not kept at its record''s latest version: %',ans; end if;
 if (select relation from fabrik.version_link where source_version_id=(v->>'version_id')::uuid) is distinct from 'quotes' then
  raise exception 'FAIL the link with the saved relation: %',v; end if;
 execute 'set local role authenticated';
 -- Saving the same code again changes its description, as a new version.
 ans:=pg_temp.raised(fabrik.fabrik_save_relation_type('quotes','The source refers to the target.'));
 if (ans->>'version_number')::int<>2 or not fabrik.fabrik_list_relation_types() @> '[{"code":"quotes","description":"The source refers to the target."}]' then
  raise exception 'FAIL a second save of a relation: %',ans; end if;
 -- A code that is not lower-case words with underscores is refused.
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_relation_type('Has Task','Bad code.')); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'A relation is lower-case words joined by underscores, such as depends_on' then raise exception 'FAIL a bad code: %',msg; end if;
 execute 'reset role';

 -- A new version of the owning record, saved through fabrik_save_version, updates the description.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 rel:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',ans->'record_id','scope_id',sid,'kind','model',
  'expected_previous_version_id',ans->'version_id','title','Relation: quotes','reason','Relation check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','fabrik_save_relation_type','source_status','saved','description','Changed by a new version',
   'graph',jsonb_build_object('format_version',1,'nodes',jsonb_build_array(jsonb_build_object('id','relation','type','relation_type','label','quotes',
    'attributes',jsonb_build_object('code','quotes','description','Changed by a new version'))),'edges','[]'::jsonb)));
 perform pg_temp.raised(fabrik.fabrik_save_version(rel));
 if not fabrik.fabrik_list_relation_types() @> '[{"code":"quotes","description":"Changed by a new version"}]' then
  raise exception 'FAIL a new version of the owning record did not change the description: %',fabrik.fabrik_list_relation_types(); end if;
 -- A second record naming the same code is refused, and the first keeps it.
 rel:=jsonb_set(jsonb_set(rel,'{record_id}',to_jsonb(gen_random_uuid()::text)),'{expected_previous_version_id}','null'::jsonb);
 rel:=jsonb_set(rel,'{request_id}',to_jsonb(gen_random_uuid()::text));
 rel:=jsonb_set(rel,'{payload,graph,nodes,0,attributes,description}','"Taken over"');
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(rel)); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'The relation "quotes" belongs to another record' then raise exception 'FAIL a second record took an existing code: %',msg; end if;
 if not fabrik.fabrik_list_relation_types() @> '[{"code":"quotes","description":"Changed by a new version"}]' then
  raise exception 'FAIL the relation was taken over'; end if;
 -- A second parent link on one version is refused.
 act:=jsonb_build_object('activity_kind','plan','state','pending','description','A plan','owner_actor_id',admin_id,
  'completion_requirements','Done','completion_note','','baseline_start_at',null,'baseline_finish_at','2026-10-01T09:00:00Z',
  'forecast_start_at',null,'forecast_finish_at',null,'blockers','[]'::jsonb,'external_references','[]'::jsonb);
 p1:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','activity',
  'expected_previous_version_id',null,'title','Plan one','reason','Relation check','links','[]'::jsonb,'payload',act)));
 p2:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','activity',
  'expected_previous_version_id',null,'title','Plan two','reason','Relation check','links','[]'::jsonb,'payload',act)));
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','activity',
  'expected_previous_version_id',null,'title','Two parents','reason','Relation check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',p1->>'version_id','relation','parent'),jsonb_build_object('target_version_id',p2->>'version_id','relation','parent')),
  'payload',act||'{"activity_kind":"task"}'::jsonb))); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'Only one parent is allowed' then raise exception 'FAIL two parents on one version: %',msg; end if;
 execute 'reset role';

 -- An agent holding create and edit on the reference scope saves a relation straight through
 -- fabrik_save_version, and is refused: the administrator rule holds on every route.
 rel:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
  'expected_previous_version_id',null,'title','Relation: sneaky','reason','Relation check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','fabrik_save_relation_type','source_status','saved','description','Sneaky',
   'graph',jsonb_build_object('format_version',1,'nodes',jsonb_build_array(jsonb_build_object('id','relation','type','relation_type','label','sneaky',
    'attributes',jsonb_build_object('code','sneaky','description','Sneaky'))),'edges','[]'::jsonb)));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(rel,gid)); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'Administrator authority required to save a relation' then raise exception 'FAIL an agent saved a relation through fabrik_save_version: %',msg; end if;
 execute 'reset role';
 if exists(select 1 from fabrik.relation_type where code='sneaky') then raise exception 'FAIL the sneaky relation was kept'; end if;

 -- An agent with create and edit on the reference scope still cannot save a relation, and reads the list.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 ans:=fabrik.fabrik_save_relation_type('cites','The source cites the target.');
 if ans->'refused' is distinct from 'true'::jsonb or ans->>'problem' is distinct from 'Administrator authority required' then
  raise exception 'FAIL an agent saved a relation: %',ans; end if;
 ans:=fabrik.fabrik_list_relation_types();
 if jsonb_array_length(ans)<>11 or not ans @> '[{"code":"parent","single_parent":true},{"code":"quotes","single_parent":false}]' then
  raise exception 'FAIL the list of relations: %',ans; end if;
 execute 'reset role';
 if exists(select 1 from fabrik.relation_type where code='cites') then raise exception 'FAIL the refused relation was kept'; end if;
 raise exception 'PASS: relation types (ten seeds with parent alone a single parent, an unknown relation refused, a saved relation used, an agent refused, the list read)';
end $w$;
rollback;
