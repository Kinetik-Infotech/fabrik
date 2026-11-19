-- Times fabrik's permission checks for a restricted person on a project of a known size: 13 scopes,
-- 1,000 activities and evidence records, the person's 13 grants, one of them limited to their own
-- records, and an activity with six links. Each read and the linked save finishes within 200 ms,
-- and one day's audit log within 1 second, the fastest of three tries each.
-- The tables' planner statistics are taken from the run's own rows, once 100 records are in and again
-- once all are, as a project of this size has them. Without that, a database where earlier runs were
-- rolled back reads as empty to the planner once vacuumed: observed, the run took 97 s in place of 30 s,
-- each of the five links took 9 to 14 s, progress took 15.5 s, and the check failed; after more such
-- runs it ran past three minutes.
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
do $t$
declare h uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); admin_id uuid; person_id uuid; s uuid; scopes uuid[]:='{}';
 plan uuid; task uuid; ev uuid[]:='{}'; i int; k text; t timestamptz; ms numeric; best numeric; req jsonb; times jsonb:='{}';
begin
 insert into auth.users(id) values(h),(p);
 admin_id:=fabrik_private.provision_first_administrator(h,'Timing administrator');
 person_id:=fabrik_private.provision_actor(admin_id,p,'Timing person','human',null,'restricted',false);
 for i in 1..13 loop
  insert into fabrik.scope(code,display_name,description,created_by) values('timing_'||i,'Timing '||i,'Rolled back',admin_id) returning scope_id into s;
  scopes:=scopes||s;
  perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),person_id,s,array['activity','evidence'],null::uuid,
   array['read','create','edit'],null::timestamptz,'Timing grant',i=13);
 end loop;

 -- The administrator saves 1,000 records across the scopes.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',h,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 for i in 1..1000 loop
  if i%2=0 then
   perform pg_temp.raised(fabrik.fabrik_add_record('timing_'||(i%13+1),'evidence','Timing evidence '||i,'Timing','{"summary":"Seen","standing":"stated"}'));
  else
   perform pg_temp.raised(fabrik.fabrik_add_record('timing_'||(i%13+1),'activity','Timing task '||i,'Timing','{"activity_kind":"task","index":"1","completion_requirements":"Done"}'));
  end if;
  if i=100 then
   execute 'reset role';
   analyze fabrik.record, fabrik.record_version, fabrik.authorisation, fabrik.version_link;
   execute 'set local role authenticated';
  end if;
 end loop;
 plan:=pg_temp.raised(fabrik.fabrik_add_record('timing_1','activity','Timing plan','Timing','{"activity_kind":"plan","index":"1"}'))->>'record_id';
 task:=pg_temp.raised(fabrik.fabrik_add_record('timing_1','activity','Timing linked task','Timing','{"activity_kind":"task","index":"1.1","completion_requirements":"Done"}',plan::text))->>'record_id';
 for i in 1..5 loop
  ev:=ev||(pg_temp.raised(fabrik.fabrik_add_record('timing_1','evidence','Timing linked evidence '||i,'Timing','{"summary":"Seen","standing":"stated"}'))->>'record_id')::uuid;
  perform pg_temp.raised(fabrik.fabrik_link(task::text,ev[i]::text,'supports','Timing'));
 end loop;
 execute 'reset role';
 analyze fabrik.record, fabrik.record_version, fabrik.authorisation, fabrik.version_link;

 -- The person reads and saves, each timed.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',p,'role','authenticated')::text,true);
 execute 'set local role fabrik_reader';
 best:=null;
 for i in 1..3 loop
  t:=clock_timestamp(); perform count(*) from fabrik_private.readable_records();
  best:=least(coalesce(best,extract(epoch from clock_timestamp()-t)*1000),extract(epoch from clock_timestamp()-t)*1000);
 end loop;
 times:=times||jsonb_build_object('readable records',round(best));
 execute 'reset role';
 execute 'set local role authenticated';
 -- Each is timed three times and its fastest kept, so other work on the computer, such as the stand-in's
 -- other steps running beside this one, does not count against fabrik.
 foreach k in array array['progress','title','audit','save'] loop
  best:=null;
  for i in 1..3 loop
   t:=clock_timestamp();
   case k
    when 'progress' then perform fabrik.fabrik_get_progress(null,null,null,100,scopes[1]);
    when 'title' then perform fabrik_task.record_id('Timing linked task');
    when 'audit' then perform fabrik.fabrik_get_audit(clock_timestamp()-interval '1 day',clock_timestamp(),null,100);
    else perform pg_temp.raised(fabrik.fabrik_change_record(task::text,'Timing',jsonb_build_object('description','Timed '||i)));
   end case;
   ms:=extract(epoch from clock_timestamp()-t)*1000;
   best:=least(coalesce(best,ms),ms);
  end loop;
  times:=times||jsonb_build_object(k,round(best));
 end loop;
 req:=pg_temp.raised(fabrik.fabrik_change_record(task::text,'Timing','{"description":"Checked"}',null,true))->'request';
 execute 'reset role';
 execute 'set local role fabrik_writer';
 best:=null;
 for i in 1..3 loop
  t:=clock_timestamp(); perform fabrik_private.validate_version(req);
  best:=least(coalesce(best,extract(epoch from clock_timestamp()-t)*1000),extract(epoch from clock_timestamp()-t)*1000);
 end loop;
 times:=times||jsonb_build_object('save checks',round(best));
 execute 'reset role';
 if jsonb_array_length(req->'links')<>6 then raise exception 'FAIL permission times: the timed save has % links',jsonb_array_length(req->'links'); end if;
 for k in select key from jsonb_each(times) loop
  if (times->>k)::numeric>(case k when 'audit' then 1000 else 200 end) then
   raise exception 'FAIL permission times: the % took % ms, all %',k,times->>k,times;
  end if;
 end loop;
 raise exception 'PASS: permission times (ms) %',times;
end $t$;
