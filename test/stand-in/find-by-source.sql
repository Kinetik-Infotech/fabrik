-- Checks fabrik_find_by_source against the real functions: a record saved with payload.source {system, id}
-- is found by that system and id; another id, another system and an id nobody saved return null; a new
-- version that changes the source stops the old id matching; a caller with no read on the record's scope gets
-- null, and one with read on it gets the record; a deleted record is not found; and the lookup's condition uses the index.
-- Checks fabrik_link_many too: several links are one new version, a link replaces its like, and a repeated link is refused.
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
declare h uuid:=gen_random_uuid(); rd uuid:=gen_random_uuid(); ot uuid:=gen_random_uuid();
 admin_id uuid; reader_id uuid; sa uuid; sb uuid; ra jsonb; rb jsonb; rc jsonb; rv jsonb; prev jsonb; delreq jsonb; appr jsonb; found uuid; plan text; n integer; msg text; rd4 jsonb;
begin
 insert into auth.users(id) values(h),(rd),(ot);
 admin_id:=fabrik_private.provision_first_administrator(h,'Source check administrator');
 insert into fabrik.scope(code,display_name,description,created_by) values('source_a','Source A','Rolled back',admin_id) returning scope_id into sa;
 insert into fabrik.scope(code,display_name,description,created_by) values('source_b','Source B','Rolled back',admin_id) returning scope_id into sb;
 reader_id:=fabrik_private.provision_actor(admin_id,rd,'Source check reader','agent',admin_id,'restricted',false);
 perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),reader_id,sa,array['model'],null::uuid,array['read'],null::timestamptz,'Read scope A');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 ra:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sa,'kind','model',
  'expected_previous_version_id',null,'title','Imported A','reason','Source check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','source check','source_status','saved','description','From maxy-code',
   'source',jsonb_build_object('system','maxy-code','id','4:abc:1'),'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)))));
 rb:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sb,'kind','model',
  'expected_previous_version_id',null,'title','Imported B','reason','Source check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','source check','source_status','saved','description','From maxy-code, other scope',
   'source',jsonb_build_object('system','maxy-code','id','4:abc:2'),'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)))));
 rc:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sa,'kind','model',
  'expected_previous_version_id',null,'title','Imported C','reason','Source check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','source check','source_status','saved','description','From maxy-code, to be deleted',
   'source',jsonb_build_object('system','maxy-code','id','4:abc:3'),'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)))));

 -- Found by its source; other ids and systems give null.
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:1') is distinct from (ra->>'record_id')::uuid then
  raise exception 'FAIL a record saved with a source was not found by it: %',fabrik.fabrik_find_by_source('maxy-code','4:abc:1'); end if;
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:99') is not null then raise exception 'FAIL an id nobody saved was found'; end if;
 if fabrik.fabrik_find_by_source('other-system','4:abc:1') is not null then raise exception 'FAIL another system matched the id'; end if;

 -- Only the current version counts: a new version with another source stops the old id matching.
 rv:=pg_temp.raised(fabrik.fabrik_save_version(jsonb_build_object('request_id',gen_random_uuid(),'record_id',ra->>'record_id','scope_id',sa,'kind','model',
  'expected_previous_version_id',ra->>'version_id','title','Imported A','reason','Source check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','source check','source_status','saved','description','Source changed',
   'source',jsonb_build_object('system','maxy-code','id','4:abc:1b'),'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)))));
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:1') is not null then raise exception 'FAIL an old version''s source still matched'; end if;
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:1b') is distinct from (ra->>'record_id')::uuid then raise exception 'FAIL the current version''s source was not found'; end if;
 execute 'reset role';

 -- All four keys together are accepted and the record is found; properties that is not an object is refused.
 rd4:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sa,'kind','model',
  'expected_previous_version_id',null,'title','Four keys','reason','Source check','links','[]'::jsonb,
  'payload',jsonb_build_object('model_kind','observed_current','source_version','source check','source_status','saved','description','All four',
   'source',jsonb_build_object('system','maxy-code','id','4:abc:4'),'type','Person','labels',jsonb_build_array('Person','Contact'),
   'properties',jsonb_build_object('name','Ann','age',jsonb_build_object('$int','41')),'graph',jsonb_build_object('format_version',1,'nodes','[]'::jsonb,'edges','[]'::jsonb)));
 execute 'set local role authenticated';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 rv:=pg_temp.raised(fabrik.fabrik_save_version(rd4));
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:4') is distinct from (rv->>'record_id')::uuid then raise exception 'FAIL a record with source, type, labels and properties was not found'; end if;
 if (fabrik.fabrik_get_record((rv->>'record_id')::uuid)::text) not like '%"Contact"%' then raise exception 'FAIL labels were not kept'; end if;
 msg:=null;
 begin perform pg_temp.raised(fabrik.fabrik_save_version(jsonb_set(jsonb_set(rd4,'{request_id}',to_jsonb(gen_random_uuid()::text)),'{payload,properties}','"text"'))); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'Invalid properties' then raise exception 'FAIL properties that is not an object: %',msg; end if;
 execute 'reset role';

 -- fabrik_link_many: several links from one record are one new version; a link in the list replaces the record's
 -- link of that relation to the same record; a list that names one link twice, and an empty list, are refused.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 found:=fabrik.fabrik_find_by_source('maxy-code','4:abc:4');
 n:=(fabrik.fabrik_show_record(ra->>'record_id')->>'version_number')::integer;
 perform pg_temp.raised(fabrik.fabrik_link_many(ra->>'record_id',jsonb_build_array(
  jsonb_build_object('target',found::text,'relation','describes','note','first'),
  jsonb_build_object('target',rc->>'record_id','relation','describes')),'Source check links'));
 rv:=fabrik.fabrik_show_record(ra->>'record_id');
 if (rv->>'version_number')::integer<>n+1 or jsonb_array_length(rv->'links')<>2 then
  raise exception 'FAIL two links in one call were not one new version with two links: version % after %, links %',rv->>'version_number',n,rv->'links'; end if;
 perform pg_temp.raised(fabrik.fabrik_link_many(ra->>'record_id',jsonb_build_array(
  jsonb_build_object('target',found::text,'relation','describes','note','second')),'Source check links'));
 rv:=fabrik.fabrik_show_record(ra->>'record_id');
 if jsonb_array_length(rv->'links')<>2 or (select l->>'note' from jsonb_array_elements(rv->'links') l where l->>'target_record_id'=found::text) is distinct from 'second' then
  raise exception 'FAIL a link in the list did not replace the link of that relation to the same record: %',rv->'links'; end if;
 msg:=null;
 begin perform fabrik.fabrik_link_many(ra->>'record_id',jsonb_build_array(jsonb_build_object('target',found::text,'relation','describes'),
  jsonb_build_object('target',found::text,'relation','describes')),'Source check links'); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'The list names one link twice' then raise exception 'FAIL a list naming one link twice: %',msg; end if;
 msg:=null;
 begin perform fabrik.fabrik_link_many(ra->>'record_id','[]'::jsonb,'Source check links'); exception when others then msg:=sqlerrm; end;
 if msg is distinct from 'Give the links as a list, each with a target and a relation' then raise exception 'FAIL an empty list: %',msg; end if;
 execute 'reset role';

 -- A caller who reads scope A finds A's record and gets null for B's.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',rd,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:1b') is distinct from (ra->>'record_id')::uuid then raise exception 'FAIL a reader of the scope did not find its record'; end if;
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:2') is not null then raise exception 'FAIL a caller with no read on the scope found its record'; end if;
 execute 'reset role';

 -- A deleted record is not found.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 prev:=fabrik.fabrik_preview_deletion((rc->>'record_id')::uuid);
 delreq:=jsonb_set(prev->'request','{reason}','"Source check deletion"');
 appr:=pg_temp.raised(fabrik.fabrik_approve_change(gen_random_uuid(),admin_id,delreq,clock_timestamp()+interval '1 hour','Source check deletion'));
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:3') is distinct from (rc->>'record_id')::uuid then raise exception 'FAIL the record to delete was not found first'; end if;
 perform pg_temp.raised(fabrik.fabrik_delete_record(delreq,(appr->>'authorisation_id')::uuid));
 if fabrik.fabrik_find_by_source('maxy-code','4:abc:3') is not null then raise exception 'FAIL a deleted record was found'; end if;
 execute 'reset role';

 -- The lookup's own condition can use the partial index: with a table scan ruled out, the plan names it.
 n:=0;
 execute 'set local enable_seqscan=off';
 for plan in execute $q$explain select 1 from fabrik.record_version v where v.payload->'source' is not null and v.payload->'source'->>'id'='4:abc:2' and v.payload->'source'->>'system'='maxy-code'$q$ loop
  if plan like '%version_source_idx%' then n:=-1; end if;
 end loop;
 if n<>-1 then raise exception 'FAIL the lookup does not use version_source_idx'; end if;
 raise exception 'PASS: find by source (found by system and id, null for another id or system, only the current version counts, null without read on the scope, a deleted record not found, the index used; many links saved as one version, replacing, a repeated link refused)';
end $w$;
rollback;
