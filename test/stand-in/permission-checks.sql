-- Checks a restricted person's permission checks read their grants a fixed number of times, however
-- many records fabrik holds. The person holds a grant in one scope, a grant limited to their own records in a second,
-- and none in a third. Five records lie across the three: a plan, its task, evidence linked to the
-- task, and one evidence record in each other scope. Each read and the linked save runs twice, the
-- second time after three more records and two links. Each one reads the grants as often the second
-- time as the first, and each read calls fabrik_private.can_read_record no times. The counts are
-- the functions' calls in this transaction, from pg_stat_xact_user_functions. Run.sh grants
-- postgres track_functions. Upgrade 0005-set-based-lookups, from HED's 0072.
-- Ends in an error, so nothing is kept.
begin;
set local track_functions = 'all';
-- fabrik answers a permission refusal as {"refused": true, "problem": ...}. Each call goes through
-- pg_temp.raised, which raises that refusal as the error it was, as the fabrik plugin's rpc does.
create function pg_temp.raised(p_answer jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $raised$
begin
 if jsonb_typeof(p_answer)='object' and p_answer->'refused'='true'::jsonb then
  raise exception '%',p_answer->>'problem' using errcode='42501';
 end if;
 return p_answer;
end $raised$;
-- The calls of a fabrik_private function so far in this transaction.
create function pg_temp.calls(p_name text) returns bigint language sql as $calls$
 select coalesce(sum(calls),0) from pg_stat_xact_user_functions where schemaname='fabrik_private' and funcname=p_name
$calls$;
do $t$
declare h uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); admin_id uuid; person_id uuid; s uuid; scopes uuid[]:='{}';
 plan uuid; task uuid; ev uuid; i int; k text; n bigint; g bigint; req jsonb; round jsonb[]:=array['{}','{}']::jsonb[];
begin
 insert into auth.users(id) values(h),(p);
 admin_id:=fabrik_private.provision_first_administrator(h,'Checks administrator');
 person_id:=fabrik_private.provision_actor(admin_id,p,'Checks person','human',null,'restricted',false);
 for i in 1..2 loop
  insert into fabrik.scope(code,display_name,description,created_by) values('checks_'||i,'Checks '||i,'Rolled back',admin_id) returning scope_id into s;
  scopes:=scopes||s;
  perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),person_id,s,array['activity','evidence'],null::uuid,
   array['read','create','edit'],null::timestamptz,'Checks grant',i=2);
 end loop;
 insert into fabrik.scope(code,display_name,description,created_by) values('checks_other','Checks other','Rolled back',admin_id);

 -- The administrator saves the five records.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 plan:=pg_temp.raised(fabrik.fabrik_add_record('checks_1','activity','Checks plan','Checks','{"activity_kind":"plan","index":"1"}'))->>'record_id';
 task:=pg_temp.raised(fabrik.fabrik_add_record('checks_1','activity','Checks linked task','Checks','{"activity_kind":"task","index":"1.1","completion_requirements":"Done"}',plan::text))->>'record_id';
 ev:=pg_temp.raised(fabrik.fabrik_add_record('checks_1','evidence','Checks linked evidence','Checks','{"summary":"Seen","standing":"stated"}'))->>'record_id';
 perform pg_temp.raised(fabrik.fabrik_link(task::text,ev::text,'supports','Checks'));
 perform pg_temp.raised(fabrik.fabrik_add_record('checks_2','evidence','Checks other person''s evidence','Checks','{"summary":"Seen","standing":"stated"}'));
 perform pg_temp.raised(fabrik.fabrik_add_record('checks_other','evidence','Checks other evidence','Checks','{"summary":"Seen","standing":"stated"}'));
 execute 'reset role';

 for i in 1..2 loop
  if i=2 then
   -- Three more records: a task and the evidence linked to it, and one in the third scope.
   perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
   execute 'set local role authenticated';
   s:=pg_temp.raised(fabrik.fabrik_add_record('checks_1','activity','Checks second task','Checks','{"activity_kind":"task","index":"1.2","completion_requirements":"Done"}',plan::text))->>'record_id';
   ev:=pg_temp.raised(fabrik.fabrik_add_record('checks_1','evidence','Checks second linked evidence','Checks','{"summary":"Seen","standing":"stated"}'))->>'record_id';
   perform pg_temp.raised(fabrik.fabrik_link(s::text,ev::text,'supports','Checks'));
   perform pg_temp.raised(fabrik.fabrik_add_record('checks_other','evidence','Checks second other evidence','Checks','{"summary":"Seen","standing":"stated"}'));
   execute 'reset role';
  end if;
  -- The person reads and saves, and each one's grant reads and record checks are counted.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p,'role','authenticated')::text,true);
  foreach k in array array['records','versions','links','progress','title','record','history','named','audit','save'] loop
   n:=pg_temp.calls('can_read_record'); g:=pg_temp.calls('read_grants');
   if k in ('records','versions','links') then
    execute 'set local role fabrik_reader';
    case k
     when 'records' then perform count(*) from fabrik.record;
     when 'versions' then perform count(*) from fabrik.record_version;
     else perform count(*) from fabrik.version_link;
    end case;
   else
    execute 'set local role authenticated';
    case k
     when 'progress' then perform fabrik.fabrik_get_progress(null,null,null,100,scopes[1]);
     when 'title' then perform fabrik_task.record_id('Checks linked task');
     when 'record' then perform fabrik.fabrik_get_record(task);
     when 'history' then perform fabrik.fabrik_get_history(task);
     when 'named' then perform fabrik.fabrik_show_record('Checks linked task');
     when 'audit' then perform fabrik.fabrik_get_audit(clock_timestamp()-interval '1 day',clock_timestamp(),null,100);
     else perform pg_temp.raised(fabrik.fabrik_change_record(task::text,'Checks',jsonb_build_object('description','Checked '||i)));
    end case;
   end if;
   execute 'reset role';
   round[i]:=round[i]||jsonb_build_object(k,jsonb_build_object('grants',pg_temp.calls('read_grants')-g,'checks',pg_temp.calls('can_read_record')-n));
  end loop;
 end loop;
 for k in select key from jsonb_each(round[2]) loop
  if round[1]->k->'grants'<>round[2]->k->'grants' or round[1]->k->'checks'<>round[2]->k->'checks' then
   raise exception 'FAIL permission checks: the % read the grants % then % times, and checked records % then % times',
    k,round[1]->k->>'grants',round[2]->k->>'grants',round[1]->k->>'checks',round[2]->k->>'checks';
  end if;
  if k<>'save' and (round[2]->k->>'checks')::bigint<>0 then
   raise exception 'FAIL permission checks: the % called can_read_record % times, all %',k,round[2]->k->>'checks',round[2];
  end if;
 end loop;
 raise exception 'PASS: permission checks (grant reads and record checks) %',round[2];
end $t$;
