-- Checks the fabrik records skill's requests against the real functions: an agent under a
-- standing grant saves each kind from the skill's field lists, reads the history back, and is
-- refused outside its scope. An application does the same under its own grant. A person then
-- deletes a record under an administrator's approval.
-- Ends in an error, so nothing is kept.
begin;
-- fabrik answers a permission refusal as {"refused": true, "problem": ...}. Each call goes through
-- pg_temp.raised, which raises that refusal as the error it was, as the fabrik plugin's rpc does.
create function pg_temp.raised(p_answer jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $raised$
begin
 if jsonb_typeof(p_answer)='object' and p_answer->'refused'='true'::jsonb then
  raise exception '%',p_answer->>'problem' using errcode='42501';
 end if;
 return p_answer;
end $raised$;
do $w$
declare h uuid:=gen_random_uuid(); ag uuid:=gen_random_uuid(); hu uuid:=gen_random_uuid(); rd uuid:=gen_random_uuid();
 admin_id uuid; agent_id uuid; human_id uuid; reader_id uuid; s1 uuid; s2 uuid; hg uuid; ev jsonb; appr jsonb; areq jsonb; msg text;
 g jsonb; gid uuid; req jsonb; v jsonb; found jsonb; rid uuid; hist jsonb; n int:=0; ok boolean; first_change bigint;
 ap uuid:=gen_random_uuid(); app_id uuid; apg uuid; av jsonb;
 pu uuid:=gen_random_uuid(); xu uuid:=gen_random_uuid(); doer_id uuid; outsider_id uuid; aplan uuid:=gen_random_uuid(); atask uuid; pv jsonb; tpay jsonb; people jsonb;
 drec uuid:=gen_random_uuid(); dreq jsonb; dv jsonb; dappr jsonb; vappr jsonb; prev jsonb; delreq jsonb; stale jsonb; rcpt jsonb; linker jsonb; left_over int;
begin
 insert into auth.users(id) values(h),(ag);
 admin_id:=fabrik_private.provision_first_administrator(h,'Work check administrator');
 insert into fabrik.scope(code,display_name,description,created_by) values('work_check','Work check','Rolled back',admin_id) returning scope_id into s1;
 insert into fabrik.scope(code,display_name,description,created_by) values('work_other','Work other','Rolled back',admin_id) returning scope_id into s2;
 agent_id:=fabrik_private.provision_actor(admin_id,ag,'Work check agent','agent',admin_id,'restricted',false);
 g:=fabrik_private.provision_grant(admin_id,gen_random_uuid(),agent_id,s1,array['activity','decision','model','evidence'],null::uuid,
   array['read','create','edit','start','hold','complete','reopen','cancel','decide'],null::timestamptz,'Work check grant');
 gid:=(g->>'authorisation_id')::uuid;

 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';

 -- Section 1: the agent learns who it is in fabrik, and sees its scope and its grant.
 v:=fabrik.fabrik_get_actor();
 if v->>'display_name'<>'Work check agent' or v->>'actor_kind'<>'agent' or v->>'authority_class'<>'restricted'
  or v->>'accountable_human_name'<>'Work check administrator' then raise exception 'FAIL the agent''s own record: %',v; end if;
 if jsonb_array_length(fabrik.fabrik_get_scopes()->'items')<>1 then raise exception 'FAIL scopes: %',fabrik.fabrik_get_scopes(); end if;
 if jsonb_typeof(fabrik.fabrik_get_scopes()->'next_cursor') is distinct from 'null' or jsonb_typeof(fabrik.fabrik_get_authorisations()->'next_cursor') is distinct from 'null' then
  raise exception 'FAIL a page shorter than its limit still offers a next page: %, %',fabrik.fabrik_get_scopes(),fabrik.fabrik_get_authorisations(); end if;
 
 if (fabrik.fabrik_get_authorisations()->'items'->0->>'authorisation_id')::uuid<>gid then raise exception 'FAIL grants'; end if;

 -- Section 3, activity: a new plan task, exactly the skill's fields.
 rid:=gen_random_uuid();
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',rid,'scope_id',s1,'kind','activity','expected_previous_version_id',null,
  'title','Check the work skill','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('activity_kind','task','state','pending','description','A task','owner_actor_id',admin_id,
   'completion_requirements','Evidence exists','completion_note','','baseline_start_at',null,'baseline_finish_at','2026-10-01T09:00:00Z',
   'forecast_start_at',null,'forecast_finish_at',null,'blockers','[]'::jsonb,'external_references','[]'::jsonb));
 v:=pg_temp.raised(fabrik.fabrik_save_version(req,gid)); first_change:=(v->>'change_no')::bigint;
 -- Section 4: start it, carrying the whole record again with the new state.
 req:=req||jsonb_build_object('request_id',gen_random_uuid(),'expected_previous_version_id',v->>'version_id','reason','Started');
 req:=jsonb_set(req,'{payload,state}','"in_progress"');
 v:=pg_temp.raised(fabrik.fabrik_save_version(req,gid));
 if (v->>'version_number')::int<>2 then raise exception 'FAIL activity version %',v; end if;
 -- Section 2: the history names the agent on both versions.
 hist:=fabrik.fabrik_get_history(rid);
 if jsonb_array_length(hist->'items')<>2 or exists(select 1 from jsonb_array_elements(hist->'items') i where (i->>'executor_actor_id')::uuid<>agent_id)
  then raise exception 'FAIL history %',hist; end if;
 if fabrik.fabrik_get_record(rid)->'version'->'payload'->>'state'<>'in_progress' then raise exception 'FAIL record read'; end if;

 -- Section 4: the started task's dates move, planned and expected, with the reason why. Progress
 -- reads the new dates, and the history keeps the version with the old ones.
 req:=req||jsonb_build_object('request_id',gen_random_uuid(),'expected_previous_version_id',v->>'version_id','reason','The project starts on 2 October');
 req:=jsonb_set(req,'{payload}',(req->'payload')||jsonb_build_object('baseline_start_at','2026-10-02T08:00:00Z','baseline_finish_at','2026-10-08T16:00:00Z',
  'forecast_start_at','2026-10-02T08:00:00Z','forecast_finish_at','2026-10-08T16:00:00Z'));
 v:=pg_temp.raised(fabrik.fabrik_save_version(req,gid));
 select x into found from jsonb_array_elements(fabrik.fabrik_get_progress(null,null,null,100)->'items') x where x->>'record_id'=rid::text;
 if (found->'payload'->>'baseline_start_at')::timestamptz<>'2026-10-02T08:00:00Z' or (found->'payload'->>'baseline_finish_at')::timestamptz<>'2026-10-08T16:00:00Z'
  or (found->'payload'->>'forecast_finish_at')::timestamptz<>'2026-10-08T16:00:00Z' or found->'payload'->>'state'<>'in_progress' then
  raise exception 'FAIL moved dates: %',found->'payload'; end if;
 hist:=fabrik.fabrik_get_history(rid);
 if jsonb_array_length(hist->'items')<>3 or not exists(select 1 from jsonb_array_elements(hist->'items') i where i->>'change_reason'='The project starts on 2 October') then
  raise exception 'FAIL history of the moved dates: %',hist; end if;
 if (fabrik.fabrik_get_record(rid,first_change)->'version'->'payload'->>'baseline_finish_at')::timestamptz<>'2026-10-01T09:00:00Z' then
  raise exception 'FAIL the first version lost its planned finish'; end if;

 -- Section 3, decision, evidence and model: each kind's fields as the skill lists them.
 perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','decision',
  'expected_previous_version_id',null,'title','Pick a supplier','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('question','Which supplier?','alternatives',jsonb_build_array('A','B'),'decision','A','rationale','Cheaper','decided_on','2026-09-27')),gid));
 perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','evidence',
  'expected_previous_version_id',null,'title','Price list','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('summary','Spring prices','source_reference',null,'source_date','2026-09-01','standing','observed','limitations','None')),gid));
 perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','model',
  'expected_previous_version_id',null,'title','Order flow','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','1','source_status','draft','description','Orders',
   'graph',jsonb_build_object('format_version',1,
     'nodes',jsonb_build_array(jsonb_build_object('id','a','type','step','label','Order','attributes','{}'::jsonb),jsonb_build_object('id','b','type','step','label','Ship','attributes','{}'::jsonb)),
     'edges',jsonb_build_array(jsonb_build_object('id','e','source','a','target','b','type','next','attributes','{}'::jsonb))))),gid));
 n:=4;

 -- Section 2, finding: the agent finds the model it saved by its kind and words of its title, with
 -- no record id, and lists the four records in its scope, newest save first.
 found:=fabrik.fabrik_find_records(p_kind=>'model',p_title=>'order flow');
 if jsonb_array_length(found->'items')<>1 or found->'items'->0->>'title'<>'Order flow' or found->'items'->0->>'saved_by'<>'Work check agent'
  or fabrik.fabrik_get_record((found->'items'->0->>'record_id')::uuid)->'version'->'payload'->>'model_kind'<>'observed_current' then
  raise exception 'FAIL finding the model: %',found; end if;
 found:=fabrik.fabrik_find_records(p_scope_id=>s1);
 if (select array_agg(i->>'kind' order by o) from jsonb_array_elements(found->'items') with ordinality x(i,o))<>array['model','evidence','decision','activity'] then
  raise exception 'FAIL finding the scope''s records: %',found; end if;

 -- Outside its scope, the save is refused with fabrik's own message.
 ok:=false;
 begin
  perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_set(req,'{scope_id}',to_jsonb(s2::text))||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'expected_previous_version_id',null)
    ||jsonb_build_object('payload',jsonb_set(req->'payload','{state}','"pending"')),gid));
 exception when sqlstate '42501' then ok:=sqlerrm='Scope or record unavailable';
   if not ok then raise exception 'FAIL refusal said: %',sqlerrm; end if;
 end;
 if not ok then raise exception 'FAIL a save outside the grant''s scope was accepted'; end if;

 -- Section 4: completing needs its note, no blockers and a supports link to evidence.
 ev:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','evidence',
  'expected_previous_version_id',null,'title','Task done','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('summary','Checked','source_reference',null,'source_date',null,'standing','observed','limitations','None')),gid));
 req:=req||jsonb_build_object('request_id',gen_random_uuid(),'expected_previous_version_id',v->>'version_id','reason','Done');
 req:=jsonb_set(jsonb_set(req,'{payload,state}','"completed"'),'{payload,completion_note}','"Evidence checked"');
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(req,gid)); exception when sqlstate '23514' then msg:=sqlerrm; end;
 if msg is distinct from 'Completion requires requirements, note, no blockers and supporting evidence' then raise exception 'FAIL completion without evidence: %',msg; end if;
 v:=pg_temp.raised(fabrik.fabrik_save_version(req||jsonb_build_object('links',jsonb_build_array(jsonb_build_object('target_version_id',ev->>'version_id','relation','supports'))),gid));
 if fabrik.fabrik_get_record(rid)->'version'->'payload'->>'state'<>'completed' then raise exception 'FAIL completion'; end if;
 execute 'reset role';

 -- A restricted person passes their grant's id; without it, the save is refused.
 perform set_config('request.jwt.claims','{}',true);
 insert into auth.users(id) values(hu),(rd);
 human_id:=fabrik_private.provision_actor(admin_id,hu,'Work check person','human',null,'restricted',false);
 hg:=(fabrik_private.provision_grant(admin_id,gen_random_uuid(),human_id,s1,array['decision'],null::uuid,array['read','create','edit','decide'],null::timestamptz,'Person grant')->>'authorisation_id')::uuid;
 reader_id:=fabrik_private.provision_actor(admin_id,rd,'Work check reader','human',null,'restricted',false);
 perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),reader_id,s1,array['evidence'],null::uuid,array['read'],null::timestamptz,'Reader grant');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','decision',
  'expected_previous_version_id',null,'title','A person''s decision','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('question','Which?','alternatives','[]'::jsonb,'decision','','rationale','','decided_on',null));
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(req)); exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Supply the id of a grant or approval that covers this change' then raise exception 'FAIL a restricted person without a grant id: %',msg; end if;
 perform pg_temp.raised(fabrik.fabrik_save_version(req,hg));
 execute 'reset role';

 -- Assigning a task: the agent saves a plan, owned by the person it answers for, and a task
 -- assigned to a person who can read activities in the scope, who then finds it.
 perform set_config('request.jwt.claims','{}',true);
 insert into auth.users(id) values(pu),(xu);
 doer_id:=fabrik_private.provision_actor(admin_id,pu,'Work check doer','human',null,'restricted',false);
 perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),doer_id,s1,array['activity'],null::uuid,array['read'],null::timestamptz,'Doer grant');
 outsider_id:=fabrik_private.provision_actor(admin_id,xu,'Work check outsider','human',null,'restricted',false);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 tpay:=jsonb_build_object('activity_kind','plan','state','pending','description','A plan','owner_actor_id',doer_id,
   'completion_requirements','Evidence exists','completion_note','','baseline_start_at',null,'baseline_finish_at','2026-10-20T17:00:00Z',
   'forecast_start_at',null,'forecast_finish_at',null,'blockers','[]'::jsonb,'external_references','[]'::jsonb);
 pv:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',aplan,'scope_id',s1,'kind','activity','expected_previous_version_id',null,
  'title','Assignment plan','reason','Work skill check','links','[]'::jsonb,'payload',tpay),gid));
 tpay:=tpay||jsonb_build_object('activity_kind','task','index','1.1');
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','activity','expected_previous_version_id',null,
  'title','Assigned task','reason','Work skill check','links',jsonb_build_array(jsonb_build_object('target_version_id',pv->>'version_id','relation','parent')),
  'payload',tpay||jsonb_build_object('assignee_actor_id',doer_id));
 v:=pg_temp.raised(fabrik.fabrik_save_version(req,gid)); atask:=(v->>'record_id')::uuid;
 foreach msg in array array[outsider_id::text,agent_id::text] loop
  ok:=false;
  begin perform pg_temp.raised(fabrik.fabrik_save_version(req||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),
    'payload',tpay||jsonb_build_object('assignee_actor_id',msg)),gid));
  exception when sqlstate '23514' then ok:=sqlerrm='Assignee is not a person who can read this scope'; end;
  if not ok then raise exception 'FAIL a task assigned to % saved, or was refused with another message',msg; end if;
 end loop;
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(req||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'links','[]'::jsonb,
   'payload',tpay||jsonb_build_object('activity_kind','plan','assignee_actor_id',doer_id)),gid));
 exception when sqlstate '22023' then msg:=sqlerrm; end;
 if msg is distinct from 'Only a task has an assignee' then raise exception 'FAIL a plan with an assignee: %',msg; end if;
 people:=fabrik.fabrik_find_people(s1);
 if (select array_agg(i->>'display_name' order by i->>'display_name') from jsonb_array_elements(people->'items') i)<>array['Work check administrator','Work check doer'] then
  raise exception 'FAIL the people a task can be assigned to: %',people; end if;
 if jsonb_array_length(fabrik.fabrik_find_people(s1,'DOER')->'items')<>1 then raise exception 'FAIL finding a person by name: %',fabrik.fabrik_find_people(s1,'DOER'); end if;
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',xu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 if jsonb_array_length(fabrik.fabrik_find_people(s1)->'items')<>0 then raise exception 'FAIL an outsider sees who can read the scope'; end if;
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',pu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 v:=fabrik.fabrik_get_assigned();
 if jsonb_array_length(v->'items')<>1 or (v->'items'->0->>'record_id')::uuid<>atask or v->'items'->0->>'scope_name'<>'Work check'
  or v->'items'->0->'parent'->>'title'<>'Assignment plan' then raise exception 'FAIL the doer''s assigned tasks: %',v; end if;
 select jsonb_object_agg(i->>'title',i) into v from jsonb_array_elements(fabrik.fabrik_get_progress(null,null,null,100,s1)->'items') i;
 if v->'Assigned task'->>'assignee_name' is distinct from 'Work check doer' or v->'Assignment plan'->>'creator_name' is distinct from 'Work check administrator'
  or (v->'Assignment plan'->>'creator_actor_id')::uuid is distinct from admin_id or v->'Assignment plan'->'payload'->>'owner_label' is distinct from 'Work check doer' then
  raise exception 'FAIL progress names the assignee, and the plan''s creator and owner: %, %',v->'Assigned task',v->'Assignment plan'; end if;
 execute 'reset role';

 -- An application, accountable to the administrator, reads its scope and saves under its grant.
 perform set_config('request.jwt.claims','{}',true);
 insert into auth.users(id) values(ap);
 app_id:=fabrik_private.provision_actor(admin_id,ap,'Order system','application',admin_id,'restricted',false);
 apg:=(fabrik_private.provision_grant(admin_id,gen_random_uuid(),app_id,s1,array['evidence'],null::uuid,array['read','create'],null::timestamptz,'Order system reads and records evidence')->>'authorisation_id')::uuid;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ap,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 if jsonb_array_length(fabrik.fabrik_get_scopes()->'items')<>1 then raise exception 'FAIL application scopes: %',fabrik.fabrik_get_scopes(); end if;
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','evidence',
  'expected_previous_version_id',null,'title','Order 1001 checked','reason','Order check','links','[]'::jsonb,
  'payload',jsonb_build_object('summary','SKU and customer found','source_reference',null,'source_date',null,'standing','observed','limitations','None'));
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(req)); exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Supply the id of a grant or approval that covers this change' then raise exception 'FAIL an application without a grant id: %',msg; end if;
 av:=pg_temp.raised(fabrik.fabrik_save_version(req,apg));
 hist:=fabrik.fabrik_get_history((av->>'record_id')::uuid);
 if (hist->'items'->0->>'executor_actor_id')::uuid<>app_id or (hist->'items'->0->>'accountable_human_id')::uuid<>admin_id then
  raise exception 'FAIL an application''s save names it and its accountable person: %',hist; end if;
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),app_id,req||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid()),clock_timestamp()+interval '1 hour','Self'));
 exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Administrator authority required' then raise exception 'FAIL an application approved a change: %',msg; end if;
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(req||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'kind','decision',
   'payload',jsonb_build_object('question','Which?','alternatives','[]'::jsonb,'decision','','rationale','','decided_on',null)),apg));
 exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Scope or record unavailable' then raise exception 'FAIL an application saving a kind its grant cannot read: %',msg; end if;
 execute 'reset role';

 -- Section 5: an administrator approves one exact change; it is used once.
 areq:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','evidence',
  'expected_previous_version_id',null,'title','Approved evidence','reason','Work skill check','links','[]'::jsonb,
  'payload',jsonb_build_object('summary','Approved','source_reference',null,'source_date',null,'standing','stated','limitations','None'));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 appr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),reader_id,areq,clock_timestamp()+interval '1 hour','Approve one save'));
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',rd,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 perform pg_temp.raised(fabrik.fabrik_save_version(areq,(appr->>'authorisation_id')::uuid));
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(areq||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid()),(appr->>'authorisation_id')::uuid));
 exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Approval already used or does not match exact request' then raise exception 'FAIL a second use of an approval: %',msg; end if;
 execute 'reset role';

 -- Deleting a record: the person saves a decision holding bank details, the second version
 -- under an approval, and the agent's evidence links to it.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 dreq:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',drec,'scope_id',s1,'kind','decision',
  'expected_previous_version_id',null,'title','Refund to Acme, sort code 12-34-56','reason','Refund bank details 12-34-56','links','[]'::jsonb,
  'payload',jsonb_build_object('question','Refund to account 12-34-56 87654321?','alternatives','[]'::jsonb,'decision','','rationale','','decided_on',null));
 dv:=pg_temp.raised(fabrik.fabrik_save_version(dreq,hg));
 dreq:=dreq||jsonb_build_object('request_id',gen_random_uuid(),'expected_previous_version_id',dv->>'version_id','reason','Decided for 12-34-56');
 dreq:=jsonb_set(dreq,'{payload,decision}','"Pay 12-34-56"');
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 vappr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),human_id,dreq,clock_timestamp()+interval '1 hour','Approve paying 12-34-56'));
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 dv:=pg_temp.raised(fabrik.fabrik_save_version(dreq,(vappr->>'authorisation_id')::uuid));
 execute 'reset role';
 -- The agent's evidence links to it, saved under an approval that carries the link's note.
 areq:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','evidence',
  'expected_previous_version_id',null,'title','Refund letter','reason','Work skill check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',dv->>'version_id','relation','describes','note','Account 12-34-56')),
  'payload',jsonb_build_object('summary','Letter','source_reference',null,'source_date',null,'standing','observed','limitations','None'));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 appr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),agent_id,areq,clock_timestamp()+interval '1 hour','Approve the letter'));
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 linker:=pg_temp.raised(fabrik.fabrik_save_version(areq,(appr->>'authorisation_id')::uuid));
 execute 'reset role';

 select (select count(*) from fabrik.record_version where record_version::text like '%12-34-56%')
  +(select count(*) from fabrik.version_link where version_link::text like '%12-34-56%')
  +(select count(*) from fabrik.authorisation where authorisation::text like '%12-34-56%') into left_over;
 if left_over<>5 then raise exception 'FAIL before the deletion, the bank details should be in two versions, a link and two approvals, not % rows',left_over; end if;

 -- The person previews the deletion, and cannot delete without an approval.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 prev:=fabrik.fabrik_preview_deletion(drec);
 if (prev->>'versions')::int<>2 or (prev->>'links')::int<>1 or (prev->>'approvals')::int<>2
  or prev->'dependents'<>jsonb_build_array(linker->>'record_id') then raise exception 'FAIL deletion preview %',prev; end if;
 delreq:=jsonb_set(prev->'request','{reason}','"The customer asked for their bank details to be erased"');
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_delete_record(delreq)); exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Record deletion needs an approval' then raise exception 'FAIL a deletion without an approval: %',msg; end if;
 execute 'reset role';

 -- The administrator approves that exact request; one naming other dependents is refused.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 stale:=jsonb_set(delreq,'{dependents}','[]'::jsonb);
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),human_id,stale,clock_timestamp()+interval '1 hour','Stale')); exception when sqlstate '23514' then msg:=sqlerrm; end;
 if msg is distinct from 'The records that link to this record have changed; preview the deletion again' then raise exception 'FAIL an approval with stale dependents: %',msg; end if;
 dappr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),human_id,delreq,clock_timestamp()+interval '1 hour','Erasure request'));
 execute 'reset role';

 -- Without a grant to delete decisions, the person is refused; with one, the deletion runs.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_delete_record(delreq,(dappr->>'authorisation_id')::uuid)); exception when sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'Action outside authority scope' then raise exception 'FAIL a deletion without a delete grant: %',msg; end if;
 execute 'reset role';
 perform set_config('request.jwt.claims','{}',true);
 perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),human_id,s1,array['decision'],null::uuid,array['read','delete'],null::timestamptz,'Person may delete decisions');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';

 -- After the approval, the agent links a second evidence record to the decision, so the approved
 -- request's dependents are stale: the deletion is refused, and a fresh preview and approval let it through.
 execute 'reset role';
 areq:=areq||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'title','Second letter');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 appr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),agent_id,areq,clock_timestamp()+interval '1 hour','Approve the second letter'));
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 perform pg_temp.raised(fabrik.fabrik_save_version(areq,(appr->>'authorisation_id')::uuid));
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_delete_record(delreq,(dappr->>'authorisation_id')::uuid)); exception when sqlstate '23514' then msg:=sqlerrm; end;
 if msg is distinct from 'The records that link to this record have changed; preview the deletion again' then raise exception 'FAIL a deletion after its dependents changed: %',msg; end if;
 prev:=fabrik.fabrik_preview_deletion(drec);
 if jsonb_array_length(prev->'dependents')<>2 then raise exception 'FAIL deletion preview after a second dependent %',prev; end if;
 delreq:=jsonb_set(prev->'request','{reason}','"The customer asked for their bank details to be erased"');
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 dappr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),human_id,delreq,clock_timestamp()+interval '1 hour','Erasure request, previewed again'));
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',hu,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 rcpt:=pg_temp.raised(fabrik.fabrik_delete_record(delreq,(dappr->>'authorisation_id')::uuid));
 if (rcpt->>'versions_emptied')::int<>2 or (rcpt->>'links_emptied')::int<>2 or (rcpt->>'approvals_emptied')::int<>3
  or rcpt->>'content_sha256' !~ '^[0-9a-f]{64}$' or (rcpt->>'executor_actor_id')::uuid<>human_id then raise exception 'FAIL deletion receipt %',rcpt; end if;
 if fabrik.fabrik_get_record(drec)->'deleted'->>'deletion_id' is distinct from rcpt->>'deletion_id' then raise exception 'FAIL a deleted record reads as deleted: %',fabrik.fabrik_get_record(drec); end if;
 if fabrik.fabrik_get_history(drec)->'deleted' is null then raise exception 'FAIL history of a deleted record'; end if;
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(dreq||jsonb_build_object('request_id',gen_random_uuid(),'expected_previous_version_id',dv->>'version_id'),hg));
 exception when sqlstate '23514' then msg:=sqlerrm; end;
 if msg is distinct from 'The record was deleted' then raise exception 'FAIL a save to a deleted record: %',msg; end if;
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_delete_record(delreq||jsonb_build_object('request_id',gen_random_uuid()),(dappr->>'authorisation_id')::uuid));
 exception when sqlstate '23514' or sqlstate '42501' then msg:=sqlerrm; end;
 if msg is distinct from 'The record was deleted' then raise exception 'FAIL a second deletion: %',msg; end if;
 execute 'reset role';

 -- The bank details are gone from every version, link and approval; the deletion's log keeps
 -- the fingerprint and the approval that allowed it.
 select (select count(*) from fabrik.record_version where record_version::text like '%12-34-56%')
  +(select count(*) from fabrik.version_link where version_link::text like '%12-34-56%')
  +(select count(*) from fabrik.authorisation where authorisation::text like '%12-34-56%')
  +(select count(*) from fabrik.record_deletion where record_deletion::text like '%12-34-56%') into left_over;
 if left_over<>0 then raise exception 'FAIL the deleted content remains in % rows',left_over; end if;
 if (select consumed_deletion_id::text from fabrik.authorisation where authorisation_id=(dappr->>'authorisation_id')::uuid) is distinct from rcpt->>'deletion_id'
  then raise exception 'FAIL the approval was not used by the deletion'; end if;
 raise exception 'PASS: work requests (% kinds saved, a started task''s dates moved, records found by kind and title, completion, a person''s grant, a task assigned and a plan''s owner, an approval used once, outside save refused, an application''s saves, a record deleted after its dependents changed)',n;
end $w$;
rollback;
