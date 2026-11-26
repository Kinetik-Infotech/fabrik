-- Times fabrik_find_records for a person whose grant is limited to their own records, before and after upgrade
-- 0020-own-records-set. The person reads one scope whole, with 500 records, and their own 500 of 5,000 in another.
-- Each read is timed three times, and the fastest is kept: every page of the person's records, the first page of the
-- limited scope, and a title search. Before, readable_records is as own-records-old.sql holds it; after, as the upgrade
-- makes it. The person reads the same records both times, and each read is faster after. Ends in an error, so nothing
-- is kept.
begin;
create temp table own_fixture(p uuid, sa uuid, sb uuid);
create temp table own_times(phase text, k text, ms numeric, ids uuid[]);
do $t$
declare h uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); admin_id uuid; person_id uuid; other_id uuid;
 sa uuid; sb uuid; zp uuid; zo uuid; zob uuid; n int; mine uuid[];
begin
 insert into auth.users(id) values(h),(p),(o);
 admin_id:=fabrik_private.provision_first_administrator(h,'Own records time administrator');
 person_id:=fabrik_private.provision_actor(admin_id,p,'Own records time person','human',null,'restricted',false);
 other_id:=fabrik_private.provision_actor(admin_id,o,'Own records time other','human',null,'restricted',false);
 insert into fabrik.scope(code,display_name,description,created_by) values('own_time_a','Own records time limited','Rolled back',admin_id) returning scope_id into sa;
 insert into fabrik.scope(code,display_name,description,created_by) values('own_time_b','Own records time whole','Rolled back',admin_id) returning scope_id into sb;
 zp:=(fabrik_private.provision_grant(admin_id,gen_random_uuid(),person_id,sa,array['activity','evidence'],null,array['read','create','edit'],null::timestamptz,'Own records time',true)->>'authorisation_id')::uuid;
 perform fabrik_private.provision_grant(admin_id,gen_random_uuid(),person_id,sb,array['activity','evidence'],null,array['read'],null::timestamptz,'Own records time',false);
 zo:=(fabrik_private.provision_grant(admin_id,gen_random_uuid(),other_id,sa,array['activity','evidence'],null,array['read','create','edit'],null::timestamptz,'Own records time',false)->>'authorisation_id')::uuid;
 zob:=(fabrik_private.provision_grant(admin_id,gen_random_uuid(),other_id,sb,array['activity','evidence'],null,array['read','create','edit'],null::timestamptz,'Own records time',false)->>'authorisation_id')::uuid;
 -- The records, saved by the writer as a save writes them: the person's 500 and the other's 4,500 in the limited
 -- scope, and the other's 500 in the scope the person reads whole.
 for n in 0..2 loop
  mine:=array(select gen_random_uuid() from generate_series(1,case n when 1 then 4500 else 500 end));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',case n when 0 then p else o end,'role','authenticated')::text,true);
  execute 'set local role fabrik_writer';
  insert into fabrik.record(record_id,kind,created_by,scope_id) select m,'activity',case n when 0 then person_id else other_id end,case n when 2 then sb else sa end from unnest(mine) m;
  insert into fabrik.record_version(record_id,version_number,change_no,request_id,request_hash,executor_actor_id,accountable_human_id,authority_mode,authorisation_id,title,change_reason,payload)
   select x.m,1,nextval('fabrik.change_no_seq'),gen_random_uuid(),repeat('0',64),case n when 0 then person_id else other_id end,case n when 0 then person_id else other_id end,'standing_permission',
    case n when 0 then zp when 1 then zo else zob end,case n when 0 then 'Mine ' else 'Theirs ' end||x.k,'Own records time',
    jsonb_build_object('activity_kind','task','index',x.k::text,'completion_requirements','Done')
   from unnest(mine) with ordinality x(m,k);
  execute 'reset role';
 end loop;
 perform set_config('request.jwt.claims','{}',true);
 insert into own_fixture values(p,sa,sb);
end $t$;
analyze fabrik.record, fabrik.record_version, fabrik.actor, fabrik.authorisation;

-- The person's reads, each timed three times, with the fastest kept, and the records each found.
create function pg_temp.time_reads(p_phase text) returns void language plpgsql as $f$
declare f own_fixture; k text; i int; t timestamptz; ms numeric; best numeric; r jsonb; ids uuid[]; cur bigint;
begin
 select * into f from own_fixture;
 foreach k in array array['every page','limited scope','title search'] loop
  best:=null;
  for i in 1..3 loop
   ids:='{}'; cur:=null;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',f.p,'role','authenticated')::text,true);
   execute 'set local role authenticated';
   t:=clock_timestamp();
   loop
    r:=case k when 'every page' then fabrik.fabrik_find_records(null,null,null,null,cur,100)
     when 'limited scope' then fabrik.fabrik_find_records(null,f.sa,null,null,null,100)
     else fabrik.fabrik_find_records(null,null,'Mine 7',null,null,100) end;
    ids:=ids||array(select (x->>'record_id')::uuid from jsonb_array_elements(r->'items') x);
    cur:=(r->>'next_cursor')::bigint;
    exit when k<>'every page' or cur is null;
   end loop;
   ms:=extract(epoch from clock_timestamp()-t)*1000;
   execute 'reset role';
   perform set_config('request.jwt.claims','{}',true);
   if r ? 'refused' then raise exception 'FAIL own records times: the % read was refused: %',k,r; end if;
   best:=least(coalesce(best,ms),ms);
  end loop;
  insert into own_times values(p_phase,k,round(best,1),array(select x from unnest(ids) x order by x));
 end loop;
end $f$;

\i :olddefs
select pg_temp.time_reads('before');
\i :upgrade
select pg_temp.time_reads('after');

do $c$
declare b own_times; a own_times; times jsonb:='{}'; want int;
begin
 for b in select * from own_times where phase='before' loop
  select * into a from own_times where phase='after' and k=b.k;
  want:=case b.k when 'every page' then 1000 when 'limited scope' then 100 else 95 end;
  if cardinality(b.ids)<>want then raise exception 'FAIL own records times: before the upgrade the % read found % records, not %',b.k,cardinality(b.ids),want; end if;
  if a.ids is distinct from b.ids then raise exception 'FAIL own records times: the % read found other records after the upgrade',b.k; end if;
  times:=times||jsonb_build_object(b.k,jsonb_build_object('before',b.ms,'after',a.ms));
 end loop;
 for b in select * from own_times where phase='before' loop
  select * into a from own_times where phase='after' and k=b.k;
  if a.ms>=b.ms then raise exception 'FAIL own records times: the % read took % ms after the upgrade and % ms before, all %',b.k,a.ms,b.ms,times; end if;
 end loop;
 raise exception 'PASS: own records times (ms) %',times;
end $c$;
