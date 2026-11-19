-- The fabrik records skill's sections "Finish order" and "Links through a change of state", against the
-- real functions, as an administrator signed in: a plan, a sprint under it and a task under the sprint
-- added with fabrik_add_record; the sprint's finish moved before its task's with fabrik_change_record, which
-- fabrik refuses with the sentence the skill gives; then evidence linked to a task once with fabrik_link,
-- counted by fabrik_get_progress through two changes of state, and the task completed with fabrik_set_state
-- and no new link. Rolled back, so nothing is kept.
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
do $fo$
declare h uuid:=gen_random_uuid(); links jsonb; plan text; sprint text; task text; evidence text; msg text; r jsonb; item jsonb; general_id uuid;
begin
 insert into auth.users(id) values(h);
 perform fabrik_private.provision_first_administrator(h,'Finish order check administrator');
 insert into fabrik.scope(code,display_name,description,created_by)
 values('general','General','Rolled back',(select actor_id from fabrik.actor where auth_user_id=h)) returning scope_id into general_id;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';

 -- Finish order: a sprint may not finish before a task it contains.
 plan:=pg_temp.raised(fabrik.fabrik_add_record('general','activity','Spring launch','Finish order check',
  '{"activity_kind":"plan","baseline_finish_at":"2030-03-31T16:00:00Z"}'))->>'record_id';
 sprint:=pg_temp.raised(fabrik.fabrik_add_record('general','activity','Sprint 1','Finish order check',
  '{"activity_kind":"plan","index":"1","baseline_finish_at":"2030-03-13T16:00:00Z"}',plan))->>'record_id';
 task:=pg_temp.raised(fabrik.fabrik_add_record('general','activity','Photograph the stock','Finish order check',
  '{"activity_kind":"task","index":"1.1","completion_requirements":"Every item photographed","baseline_finish_at":"2030-03-12T16:00:00Z"}',sprint))->>'record_id';
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_change_record(sprint,'The sprint is cut short','{"forecast_finish_at":"2030-03-10T16:00:00Z"}'));
 exception when check_violation then msg:=sqlerrm; end;
 if msg is distinct from 'This finish cannot be saved: Sprint 1 finishes 10 Mar 16:00, before its task 1.1, which finishes 12 Mar 16:00.' then
  raise exception 'FAIL finish order: a sprint moved before its task: %',msg; end if;
 raise notice 'ok - fabrik_change_record refuses a sprint''s finish before its task''s: "%"',msg;
 if (fabrik.fabrik_show_record(sprint)->>'version_number')::int<>1 then raise exception 'FAIL finish order: the refused change was saved'; end if;
 -- The task moved first, then the sprint, both save.
 perform pg_temp.raised(fabrik.fabrik_change_record(task,'The photographs are needed sooner','{"forecast_finish_at":"2030-03-09T16:00:00Z"}'));
 r:=pg_temp.raised(fabrik.fabrik_change_record(sprint,'The sprint is cut short','{"forecast_finish_at":"2030-03-10T16:00:00Z"}'));
 if r->'payload'->>'forecast_finish_at' is distinct from '2030-03-10T16:00:00Z' then raise exception 'FAIL finish order: the sprint after its task moved: %',r; end if;
 raise notice 'ok - with the task''s finish moved first, the sprint''s earlier finish saves';

 -- Links through a change of state: evidence linked once supports the task as it starts, pauses and
 -- restarts, and the task completes with no new link.
 evidence:=pg_temp.raised(fabrik.fabrik_add_record('general','evidence','Stock photographs taken','Finish order check',
  '{"summary":"Forty photographs, in the shared folder.","standing":"observed"}'))->>'record_id';
 perform pg_temp.raised(fabrik.fabrik_link(evidence,task,'supports','The photographs are the task''s evidence'));
 perform pg_temp.raised(fabrik.fabrik_set_state(task,'in_progress','Started'));
 perform pg_temp.raised(fabrik.fabrik_set_state(task,'paused','Waiting for the studio'));
 perform pg_temp.raised(fabrik.fabrik_set_state(task,'in_progress','Restarted'));
 select x into item from jsonb_array_elements(fabrik.fabrik_get_progress(null,null,null,100,general_id)->'items') x where x->>'record_id'=task;
 if (item->>'version_number')::int<>5 or jsonb_array_length(item->'evidence')<>1 or item->'evidence'->0->>'title'<>'Stock photographs taken' then
  raise exception 'FAIL links through state: fabrik_get_progress after three changes of state: %',item; end if;
 raise notice 'ok - fabrik_get_progress lists the evidence linked to the task''s version 2 on its version 5, after three changes of state: %',
  jsonb_build_object('version_number',item->'version_number','evidence',item->'evidence'->0->'title');
 links:=fabrik.fabrik_show_record(task)->'links';
 r:=pg_temp.raised(fabrik.fabrik_set_state(task,'completed','Photographed','All forty photographs taken'));
 if r->'payload'->>'state'<>'completed' or fabrik.fabrik_show_record(task)->'links' is distinct from links then
  raise exception 'FAIL links through state: completion: %',r; end if;
 raise notice 'ok - fabrik_set_state completes the task on the evidence linked before its changes of state, with no new link: state %, version %',
  r->'payload'->>'state',r->>'version_number';
 execute 'reset role'; perform set_config('request.jwt.claims','',true);
end $fo$;
rollback;
