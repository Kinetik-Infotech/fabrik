-- Saves a plan with a child plan holding two tasks, one supported by an evidence record and one assigned, and a child task, with the real
-- fabrik_save_version as a human administrator, then writes what fabrik_get_progress returns to the
-- file named by :result_file. Rolled back, so nothing is kept.
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
declare h uuid:=gen_random_uuid(); admin_id uuid; s uuid; v jsonb; top text; child text; first_task text; ev text;
 act jsonb:=jsonb_build_object('state','pending','completion_requirements','Evidence exists','completion_note','',
  'baseline_start_at',null,'baseline_finish_at',null,'forecast_start_at',null,'forecast_finish_at',null,
  'blockers','[]'::jsonb,'external_references','[]'::jsonb);
begin
 insert into auth.users(id) values(h);
 admin_id:=fabrik_private.provision_first_administrator(h,'Progress board check administrator');
 act:=act||jsonb_build_object('owner_actor_id',admin_id);
 insert into fabrik.scope(code,display_name,description,created_by) values('progress_board_check','Progress board check','Rolled back',admin_id) returning scope_id into s;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','First release','reason','Progress board check','links','[]'::jsonb,
  'payload',act||jsonb_build_object('activity_kind','plan','description','The first release',
   'baseline_start_at','2026-09-22T08:00:00Z','baseline_finish_at','2026-12-14T17:00:00Z'))));
 top:=v->>'version_id';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Sprint 1','reason','Progress board check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',top,'relation','parent')),
  'payload',act||jsonb_build_object('activity_kind','plan','description','The first sprint',
   'baseline_start_at','2026-09-22T08:00:00Z','baseline_finish_at','2026-09-28T16:00:00Z'))));
 child:=v->>'version_id';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','evidence',
  'expected_previous_version_id',null,'title','The SKU list, loaded','reason','Progress board check','links','[]'::jsonb,
  'payload',jsonb_build_object('summary','The SKU list is in fabrik','source_reference',null,'source_date',null,'standing','observed','limitations',''))));
 ev:=v->>'version_id';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Load the SKU list','reason','Progress board check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',child,'relation','parent'),jsonb_build_object('target_version_id',ev,'relation','supports')),
  'payload',act||jsonb_build_object('activity_kind','task','description','A task in sprint 1'))));
 first_task:=v->>'version_id';
 perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Check customer addresses','reason','Progress board check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',child,'relation','parent'),jsonb_build_object('target_version_id',first_task,'relation','depends_on')),
  'payload',act||jsonb_build_object('activity_kind','task','description','A second task in sprint 1','assignee_actor_id',admin_id))));
 perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s,'kind','activity',
  'expected_previous_version_id',null,'title','Sprint 2','reason','Progress board check',
  'links',jsonb_build_array(jsonb_build_object('target_version_id',top,'relation','parent')),
  'payload',act||jsonb_build_object('activity_kind','task','description','The second sprint, as a task',
   'baseline_start_at','2026-09-29T08:00:00Z','baseline_finish_at','2026-10-05T16:00:00Z','forecast_finish_at','2026-10-07T16:00:00Z'))));
end $s$;
\pset tuples_only on
\pset format unaligned
\o :result_file
select fabrik.fabrik_get_progress(null,null,null,100);
\o
rollback;
