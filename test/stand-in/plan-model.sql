-- Saves a plan of three sprints, saved out of order, with an index on each activity, as a human
-- administrator with the real fabrik_save_version. Sprint 2's task 2.2 waits on its deliverable 2.2a
-- and on its blocker 2.2-B1, which it also lists by the blocker's record id. Writes what
-- fabrik_get_progress returns to the file named by :result_file. Rolled back, so nothing is kept.
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
do $s$
declare h uuid:=gen_random_uuid(); admin_id uuid; s uuid; v jsonb; top text; sprint text; deliverable text; blocker text;
 blocker_id uuid:=gen_random_uuid(); n int;
 act jsonb:=jsonb_build_object('state','pending','completion_requirements','Done','completion_note','',
  'baseline_start_at','2026-09-22T08:00:00Z','baseline_finish_at','2026-12-14T17:00:00Z','forecast_start_at',null,'forecast_finish_at',null,
  'blockers','[]'::jsonb,'external_references','[]'::jsonb);
begin
 insert into auth.users(id) values(h);
 admin_id:=fabrik_private.provision_first_administrator(h,'Plan model check administrator');
 act:=act||jsonb_build_object('owner_actor_id',admin_id);
 insert into fabrik.scope(code,display_name,description,created_by) values('plan_model_check','Plan model check','Rolled back',admin_id) returning scope_id into s;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Order system','reason','Plan model check','links','[]'::jsonb,
  'payload',act||jsonb_build_object('activity_kind','plan','description','The order system','index','0'))));
 top:=v->>'version_id';
 foreach n in array array[10,2,1] loop
  v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
   'expected_previous_version_id',null,'title','Sprint '||n,'reason','Plan model check',
   'links',jsonb_build_array(jsonb_build_object('target_version_id',top,'relation','parent')),
   'payload',act||jsonb_build_object('activity_kind','plan','description','Sprint '||n||' of the plan','index',n::text))));
  if n=2 then sprint:=v->>'version_id'; end if;
 end loop;
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','The schemas in the General scope','reason','Plan model check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',sprint,'relation','parent')),
  'payload',act||jsonb_build_object('activity_kind','task','description','The schemas in the General scope','index','2.2a','task_type','deliverable'))));
 deliverable:=v->>'version_id';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',blocker_id,'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Is WI a category code?','reason','Plan model check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',sprint,'relation','parent')),
  'payload',act||jsonb_build_object('activity_kind','task','description','Is WI a category code?','index','2.2-B1','task_type','blocker'))));
 blocker:=v->>'version_id';
 perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Define the tables','reason','Plan model check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',sprint,'relation','parent'),
   jsonb_build_object('target_version_id',deliverable,'relation','depends_on'),jsonb_build_object('target_version_id',blocker,'relation','depends_on')),
  'payload',act||jsonb_build_object('activity_kind','task','description','Define the tables','index','2.2','task_type','work',
   'blockers',jsonb_build_array(jsonb_build_object('blocker_id',blocker_id,'description','Is WI a category code?'))))));
end $s$;
\pset tuples_only on
\pset format unaligned
\o :result_file
select fabrik.fabrik_get_progress(null,null,null,100);
\o
rollback;
