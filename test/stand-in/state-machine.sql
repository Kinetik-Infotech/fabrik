-- Saves a model made by the fabrik graph skill with the real fabrik_save_version, as a human
-- administrator, and writes what fabrik_get_record returns to the file named by :result_file.
-- The payload arrives as :payload. Rolled back, so nothing is kept.
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
select set_config('sm.payload', :'payload', true) is not null as payload_set \gset
do $s$
declare h uuid:=gen_random_uuid(); admin_id uuid; s uuid; rid uuid:=gen_random_uuid(); v jsonb;
begin
 insert into auth.users(id) values(h);
 admin_id:=fabrik_private.provision_first_administrator(h,'State machine check administrator');
 insert into fabrik.scope(code,display_name,description,created_by) values('state_machine_check','State machine check','Rolled back',admin_id) returning scope_id into s;
 perform set_config('sm.record',rid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 v:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',rid,'scope_id',s,'kind','model',
  'expected_previous_version_id',null,'title','Valuation booking','reason','State machine check','links','[]'::jsonb,
  'payload',current_setting('sm.payload')::jsonb)));
 if (v->>'version_number')::int<>1 then raise exception 'FAIL the model was not saved: %',v; end if;
end $s$;
\pset tuples_only on
\pset format unaligned
\o :result_file
select fabrik.fabrik_get_record(current_setting('sm.record')::uuid);
\o
rollback;
