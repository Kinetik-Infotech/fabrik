-- Saves, with the real functions, as a human administrator: a glossary of two classes, a relationship
-- between them and three terms, with fabrik_save_term; a record kind of the data dictionary, with
-- fabrik_save_dictionary; and the routine model made by the fabrik graph skill, as :payload. Writes what
-- fabrik_get_reference and fabrik_get_record return to the files named by :glossary_file, :dictionary_file
-- and :record_file, for the fabrik print skill's scripts. Rolled back, so nothing is kept.
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
select set_config('pp.payload', :'payload', true) is not null as payload_set \gset
do $s$
declare h uuid:=gen_random_uuid(); admin_id uuid; ref uuid; routines uuid; model jsonb;
begin
 insert into auth.users(id) values(h);
 admin_id:=fabrik_private.provision_first_administrator(h,'Print check administrator');
 insert into fabrik.scope(code,display_name,description,created_by) values('reference','Reference','Rolled back',admin_id) returning scope_id into ref;
 insert into fabrik.scope(code,display_name,description,created_by) values('routines','Routines','Rolled back',admin_id) returning scope_id into routines;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 perform pg_temp.raised(fabrik.fabrik_save_term('vendor','class','A person selling a property through the business.','Print check',array['seller']));
 perform pg_temp.raised(fabrik.fabrik_save_term('property','class','A home the business markets for sale or to let.','Print check'));
 perform pg_temp.raised(fabrik.fabrik_save_term('owns','relationship','A vendor owns the property they sell.','Print check','{}',p_from_class=>'vendor',p_to_class=>'property'));
 perform pg_temp.raised(fabrik.fabrik_save_term('memorandum of sale','term','The note that confirms an agreed sale to both sides.','Print check',array['MoS']));
 perform pg_temp.raised(fabrik.fabrik_save_term('agency diary','term','The diary the valuations are booked in.','Print check'));
 perform pg_temp.raised(fabrik.fabrik_save_term('listings system','term','The system the business keeps its properties and their prices in.','Print check'));
 perform pg_temp.raised(fabrik.fabrik_save_dictionary('sale','property','A property the business has been instructed to sell.',
  '[{"column":"asking_price","type":"numeric","required":true,"term":null,"meaning":"The price the vendor asks.","sources":[{"system":"listings system","field":"price"}]}]'::jsonb,'Print check'));
 model:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',routines,'kind','model',
  'expected_previous_version_id',null,'title','Valuation booking','reason','Print check','links','[]'::jsonb,
  'payload',current_setting('pp.payload')::jsonb||'{"model_kind":"proposed_target"}'::jsonb)));
 perform set_config('pp.model',model->>'record_id',true);
end $s$;
\pset tuples_only on
\pset format unaligned
\o :glossary_file
select fabrik.fabrik_get_reference('glossary');
\o :dictionary_file
select fabrik.fabrik_get_reference('dictionary');
\o :record_file
select fabrik.fabrik_get_record(current_setting('pp.model')::uuid);
\o
rollback;
