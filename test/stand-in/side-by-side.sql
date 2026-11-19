-- The fixture for run.sh's checks of saves side by side, in a copy of the built database: an
-- administrator, a scope, an agent with a standing grant, and one decision and two plans the agent saved.
-- Kept, so that two sessions can save beside each other. side.fixture holds what each session
-- needs, in the schema side: the agent's claims, the grant, the decision's first request, and the
-- two plans' first requests.
create table side.fixture(k text primary key, v jsonb not null);
grant usage on schema side to authenticated;
grant select on side.fixture to authenticated;
-- fabrik answers a permission refusal as {"refused": true, "problem": ...}. Each save goes through
-- side.raised, which raises that refusal as the error it was, as the fabrik plugin's rpc does.
create function side.raised(p_answer jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $raised$
begin
 if jsonb_typeof(p_answer)='object' and p_answer->'refused'='true'::jsonb then
  raise exception '%',p_answer->>'problem' using errcode='42501';
 end if;
 return p_answer;
end $raised$;
grant execute on function side.raised(jsonb) to authenticated;
do $s$
declare h uuid:=gen_random_uuid(); ag uuid:=gen_random_uuid(); admin_id uuid; agent_id uuid; s1 uuid; gid uuid; req jsonb; v jsonb; p1 jsonb; p2 jsonb; pay jsonb;
begin
 insert into auth.users(id) values(h),(ag);
 admin_id:=fabrik_private.provision_first_administrator(h,'Side by side administrator');
 insert into fabrik.scope(code,display_name,description,created_by) values('side_check','Side check','Saves side by side',admin_id) returning scope_id into s1;
 agent_id:=fabrik_private.provision_actor(admin_id,ag,'Side by side agent','agent',admin_id,'restricted',false);
 gid:=(fabrik_private.provision_grant(admin_id,gen_random_uuid(),agent_id,s1,array['decision','activity'],null::uuid,
  array['read','create','edit','decide'],null::timestamptz,'Side by side grant')->>'authorisation_id')::uuid;
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','decision',
  'expected_previous_version_id',null,'title','Pick a carrier','reason','Side by side check','links','[]'::jsonb,
  'payload',jsonb_build_object('question','Which carrier?','alternatives',jsonb_build_array('A','B'),'decision','A','rationale','Cheaper','decided_on','2026-10-12'));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',ag,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 v:=side.raised(fabrik.fabrik_save_version(req,gid));
 -- Two plans, with no parent yet.
 pay:=jsonb_build_object('activity_kind','plan','state','pending','description','A plan','owner_actor_id',admin_id,
  'completion_requirements','Evidence exists','completion_note','','baseline_start_at',null,'baseline_finish_at','2026-10-20T17:00:00Z',
  'forecast_start_at',null,'forecast_finish_at',null,'blockers','[]'::jsonb,'external_references','[]'::jsonb);
 p1:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',s1,'kind','activity','expected_previous_version_id',null,
  'title','Plan one','reason','Side by side check','links','[]'::jsonb,'payload',pay);
 p2:=p1||jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'title','Plan two');
 perform side.raised(fabrik.fabrik_save_version(p1,gid));
 perform side.raised(fabrik.fabrik_save_version(p2,gid));
 execute 'reset role';
 insert into side.fixture values('claims',jsonb_build_object('sub',ag,'role','authenticated')),('grant',to_jsonb(gid)),
  ('request',req),('plan1',p1),('plan2',p2);
end $s$;

-- Saves the record of the fixture's p_key again as the agent, from its latest version. The save gives
-- the reason p_reason, and p_payload's fields replace those of the first payload. Run it signed in as
-- the agent, as run.sh's agent() does.
create function side.save(p_reason text, p_key text default 'request', p_payload jsonb default '{}') returns jsonb language sql as $f$
 select side.raised(fabrik.fabrik_save_version((select v||jsonb_build_object('payload',(v->'payload')||p_payload) from side.fixture where k=p_key)
  ||jsonb_build_object('request_id',gen_random_uuid(),'expected_previous_version_id',fabrik.fabrik_get_record((select (v->>'record_id')::uuid from side.fixture where k=p_key))->'version'->'version_id','reason',p_reason),
  (select (v#>>'{}')::uuid from side.fixture where k='grant')))
$f$;

-- Saves the plan p_plan again as the agent, from its latest version, with the plan p_parent as its
-- parent. Run it signed in as the agent, as run.sh's agent() does.
create function side.save_parent(p_plan text, p_parent text) returns jsonb language sql as $f$
 select side.raised(fabrik.fabrik_save_version((select v from side.fixture where k=p_plan)
  ||jsonb_build_object('request_id',gen_random_uuid(),
   'expected_previous_version_id',fabrik.fabrik_get_record((select (v->>'record_id')::uuid from side.fixture where k=p_plan))->'version'->'version_id',
   'reason','Side by side parent',
   'links',jsonb_build_array(jsonb_build_object('target_version_id',
    fabrik.fabrik_get_record((select (v->>'record_id')::uuid from side.fixture where k=p_parent))->'version'->'version_id',
    'relation','parent'))),
  (select (v#>>'{}')::uuid from side.fixture where k='grant')))
$f$;

-- A row here lets a session that run.sh holds open go on, so a check waits on an event, not a sleep.
create table side.go(k text primary key);
