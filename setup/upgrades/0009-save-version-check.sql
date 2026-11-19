-- 0009-save-version-check
-- base: 17323e9
-- A save checks again, just before it writes, that the record's latest version is the one it was read from. A save
-- of the same record kept while this one waited, such as for the lock a save that adds a parent takes, is refused
-- with 40001, as a save under way is. A save from an older version is refused with the same message from the start.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

grant create on schema fabrik_private to fabrik_identity;
set role fabrik_identity;
CREATE OR REPLACE FUNCTION fabrik_private.check_version(p jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare oldv fabrik.record_version; b jsonb:=p->'payload'; link_item jsonb; target_row record; rid uuid:=(p->>'record_id')::uuid;
 actions text[]; oldstate text; newstate text; k text; added uuid[]; problems text[];
begin
 perform fabrik_private.validate_shape(p);
 perform fabrik_private.assert_request_scope(p,(fabrik_private.current_actor()).actor_id);
 select * into oldv from fabrik.record_version where record_id=rid order by change_no desc limit 1;
 -- A save from an older version is refused before its checks. save_version checks again just before it
 -- writes, after every lock a save waits for.
 if oldv.version_id is distinct from (p->>'expected_previous_version_id')::uuid then
  raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
 end if;
 if oldv.version_id is null then
  if exists(select 1 from fabrik.record where record_id=rid) then raise exception 'Record has no saved version' using errcode='23514'; end if;
  actions:=array['create'];
 else
  if (select kind from fabrik.record where record_id=rid)<>p->>'kind' then raise exception 'Record kind is fixed' using errcode='23514'; end if;
  actions:=array['edit'];
 end if;
 if p->>'kind'='activity' then
  newstate:=b->>'state'; oldstate:=fabrik_private.activity_state(oldv.payload->>'state');
  if oldv.version_id is null and newstate<>'pending' then raise exception 'New activity starts pending' using errcode='23514'; end if;
  if oldv.version_id is not null then
   -- The baseline may change, in any state, and the version's reason says why.
   if b->>'activity_kind'<>oldv.payload->>'activity_kind' then raise exception 'Activity kind is fixed' using errcode='23514'; end if;
   if oldstate<>newstate then
    if not ((oldstate='pending' and newstate in ('in_progress','cancelled')) or (oldstate='in_progress' and newstate in ('paused','completed','cancelled')) or
      (oldstate='paused' and newstate in ('in_progress','cancelled')) or (oldstate='completed' and newstate='in_progress')) then
     raise exception 'Invalid activity state transition' using errcode='23514';
    end if;
    actions:=actions||case when newstate='in_progress' and oldstate='completed' then 'reopen' when newstate='in_progress' then 'start'
      when newstate='paused' then 'hold' when newstate='completed' then 'complete' else 'cancel' end;
   end if;
   if oldstate='completed' and b->'completion_requirements' is distinct from oldv.payload->'completion_requirements' and newstate<>'in_progress' then
    raise exception 'Changed completion requirements must reopen the activity' using errcode='23514';
   end if;
  end if;
  -- A new assignee is an enabled person who can read activities in the scope.
  if b->>'assignee_actor_id' is not null and b->'assignee_actor_id' is distinct from oldv.payload->'assignee_actor_id' and (
    not exists(select 1 from fabrik.actor x where x.actor_id=(b->>'assignee_actor_id')::uuid and x.actor_kind='human' and x.enabled)
    or not fabrik_private.scope_read_for((b->>'assignee_actor_id')::uuid,(p->>'scope_id')::uuid,'activity',rid)) then
   raise exception 'Assignee is not a person who can read this scope' using errcode='23514';
  end if;
  -- Every activity's owner is an enabled person who can read activities in the scope.
  if not fabrik_private.owner_ok((b->>'owner_actor_id')::uuid,(p->>'scope_id')::uuid,rid) then
   raise exception 'Owner is not a person who can read this scope' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_array_elements(b->'blockers') n join fabrik.record_version v on v.record_id=rid
    cross join lateral jsonb_array_elements(v.payload->'blockers') prev
    where n->>'blocker_id'=prev->>'blocker_id' and n->>'description'<>prev->>'description') then
   raise exception 'Blocker IDs cannot be reused for different descriptions' using errcode='23514';
  end if;
  -- Supporting evidence: a supports link from this version to evidence, or from evidence to a version
  -- of this record that differs from this one only in its state.
  if newstate='completed' and (length(btrim(b->>'completion_requirements'))=0 or length(btrim(b->>'completion_note'))=0 or jsonb_array_length(b->'blockers')<>0 or
    (not exists(select 1 from jsonb_array_elements(p->'links') z join fabrik.record_version v on v.version_id=(z->>'target_version_id')::uuid
      join fabrik.record r on r.record_id=v.record_id where z->>'relation'='supports' and r.kind='evidence')
     and not exists(select 1 from fabrik_private.evidence_through_state(rid,p->>'title',fabrik_private.with_owner_label(p)->'payload',null)))) then
   raise exception 'Completion requires requirements, note, no blockers and supporting evidence' using errcode='23514';
  end if;
 elsif p->>'kind'='decision' then
  if (oldv.version_id is null and b->>'decision'<>'') or (oldv.version_id is not null and b->'decision' is distinct from oldv.payload->'decision') then actions:=actions||'decide'::text; end if;
 end if;
 for link_item in select value from jsonb_array_elements(p->'links') loop
  select v.*,r.kind,r.scope_id into target_row from fabrik.record_version v join fabrik.record r using(record_id) where v.version_id=(link_item->>'target_version_id')::uuid;
  if not found or target_row.scope_id<>(p->>'scope_id')::uuid or not fabrik_private.can_read_record(target_row.record_id) then raise exception 'Link target unavailable' using errcode='42501'; end if;
  if link_item->>'relation' in ('parent','depends_on') then
   if p->>'kind'<>'activity' or target_row.kind<>'activity' or target_row.record_id=rid then raise exception 'Invalid activity link' using errcode='23514'; end if;
   if link_item->>'relation'='parent' and target_row.payload->>'activity_kind'<>'plan' then raise exception 'Parent must be a plan' using errcode='23514'; end if;
  end if;
 end loop;
 select z->>'relation' into k from jsonb_array_elements(p->'links') z join fabrik.relation_type rt on rt.code=z->>'relation'
  where rt.single_parent group by 1 having count(*)>1 limit 1;
 if k is not null then raise exception 'Only one % is allowed',k using errcode='23514'; end if;
 -- A link that adds a target record can close a loop: walk from each added target.
 foreach k in array array['depends_on','parent'] loop
  added:=array(select distinct t.record_id from jsonb_array_elements(p->'links') z join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
   where z->>'relation'=k and t.record_id not in (select pt.record_id from fabrik.version_link pl join fabrik.record_version pt on pt.version_id=pl.target_version_id
    where pl.source_version_id=oldv.version_id and pl.relation=k));
  if cardinality(added)>0 then
   -- Saves that add a parent or a dependency wait for each other, so two of them never close a loop together.
   perform pg_advisory_xact_lock(19483,31002);
   if fabrik_private.activity_loop(rid,k,added) then raise exception 'Circular activity relationship' using errcode='23514'; end if;
  end if;
 end loop;
 -- No activity finishes before what it contains or waits on.
 if p->>'kind'='activity' then
  -- Only a save that changes a finish, a task type, a parent or a dependency can break the order.
  -- Those saves wait for each other, so two of them never break it together.
  if oldv.version_id is null or coalesce(b->>'forecast_finish_at',b->>'baseline_finish_at')::timestamptz
    is distinct from coalesce(oldv.payload->>'forecast_finish_at',oldv.payload->>'baseline_finish_at')::timestamptz
   or b->>'task_type' is distinct from oldv.payload->>'task_type'
   or array(select z->>'relation'||' '||t.record_id from jsonb_array_elements(p->'links') z join fabrik.record_version t on t.version_id=(z->>'target_version_id')::uuid
     where z->>'relation' in ('parent','depends_on') order by 1)
    is distinct from array(select pl.relation||' '||pt.record_id from fabrik.version_link pl join fabrik.record_version pt on pt.version_id=pl.target_version_id
     where pl.source_version_id=oldv.version_id and pl.relation in ('parent','depends_on') order by 1) then
   perform pg_advisory_xact_lock(19483,31003);
   problems:=fabrik_private.finish_order_problems(p);
   if cardinality(problems)>0 then
    raise exception 'This finish cannot be saved: %.',array_to_string(problems,'; ') using errcode='23514';
   end if;
  end if;
 end if;
 return actions;
end $function$
;
reset role;
revoke create on schema fabrik_private from fabrik_identity;

grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
CREATE OR REPLACE FUNCTION fabrik_private.save_version(p_request jsonb, p_authorisation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
declare a fabrik.actor; z fabrik.authorisation; v fabrik.record_version; oldv fabrik.record_version;
 h text; actions text[]; aid uuid:=p_authorisation_id; l jsonb; rid uuid; vnum integer; vid uuid; t timestamptz; w jsonb:='[]'::jsonb; k text; own uuid;
begin
 perform fabrik_private.lock_writes(); a:=fabrik_private.current_actor();
 perform fabrik_private.validate_shape(p_request);
 rid:=(p_request->>'record_id')::uuid;
 -- The record and each record it links to stay as they are until the save ends: a deletion or a
 -- move waits. Other saves go on.
 perform fabrik_private.hold_records(rid||fabrik_private.link_targets(p_request),false);
 perform fabrik_private.assert_request_scope(p_request,a.actor_id);
 h:=fabrik_private.canonical_request_hash(p_request,a.actor_id,a.accountable_human_id);
 select * into v from fabrik.record_version where request_id=(p_request->>'request_id')::uuid;
 if found then
  if v.executor_actor_id<>a.actor_id or v.request_hash<>h or not fabrik_private.can_read_record(v.record_id) then
   raise exception 'Save retry unavailable or different' using errcode='42501';
  end if;
  return to_jsonb(v)||jsonb_build_object('scope_id',(p_request->>'scope_id')::uuid,'warnings',w);
 end if;
 actions:=fabrik_private.validate_version(p_request);
 if aid is null then
  -- A person approves their own change where they approve others': as an administrator outside a
  -- private scope, or as a private scope's owner in it.
  own:=fabrik_private.scope_owner((p_request->>'scope_id')::uuid);
  if a.actor_kind<>'human' or (own is null and a.authority_class<>'administrator') or (own is not null and a.actor_id<>own) then
   raise exception 'Supply the id of a grant or approval that covers this change' using errcode='42501';
  end if;
  aid:=(fabrik_private.approve_change((p_request->>'request_id')::uuid,a.actor_id,p_request,clock_timestamp()+interval '5 minutes',p_request->>'reason')->>'authorisation_id')::uuid;
 end if;
 perform fabrik_private.hold_approval(aid);
 z:=fabrik_private.assert_authority(p_request,aid,actions);
 select * into oldv from fabrik.record_version where record_id=rid order by change_no desc limit 1;
 -- check_version refused a save from an older version. A save of the same record kept since, while this
 -- one waited for a lock, is refused here.
 if oldv.version_id is distinct from (p_request->>'expected_previous_version_id')::uuid then
  raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
 end if;
 t:=clock_timestamp(); vid:=gen_random_uuid(); vnum:=coalesce(oldv.version_number,0)+1;
 begin
  if oldv.version_id is null then
   insert into fabrik.record(record_id,kind,scope_id,created_by,created_at) values(rid,p_request->>'kind',(p_request->>'scope_id')::uuid,a.actor_id,t);
  end if;
  insert into fabrik.record_version(version_id,record_id,version_number,previous_version_id,change_no,request_id,request_hash,recorded_at,
   executor_actor_id,accountable_human_id,authority_mode,authorisation_id,title,change_reason,payload)
  values(vid,rid,vnum,oldv.version_id,nextval('fabrik.change_no_seq'::regclass),(p_request->>'request_id')::uuid,h,t,
   a.actor_id,a.accountable_human_id,z.mode,z.authorisation_id,p_request->>'title',p_request->>'reason',fabrik_private.with_owner_label(p_request)->'payload') returning * into v;
 exception when unique_violation then
  -- Another save of the same record, or of the same request, finished first.
  get stacked diagnostics k=constraint_name;
  if k in ('record_pkey','record_version_record_id_version_number_key','record_version_request_id_key') then
   raise exception 'This record was changed by another save. Read it again, then save again.' using errcode='40001';
  end if;
  raise;
 end;
 perform set_config('fabrik.saving_version',vid::text,true);
 for l in select value from jsonb_array_elements(p_request->'links') loop
  insert into fabrik.version_link(source_version_id,target_version_id,relation,locator,note)
   values(vid,(l->>'target_version_id')::uuid,l->>'relation',l->>'locator',l->>'note');
 end loop;
 perform set_config('fabrik.saving_version','',true);
 if z.mode='explicit_approval' then
  update fabrik.authorisation set consumed_version_id=vid where authorisation_id=z.authorisation_id;
 end if;
 return to_jsonb(v)||jsonb_build_object('scope_id',(p_request->>'scope_id')::uuid,'warnings',w);
end $function$
;
reset role;
revoke create on schema fabrik_private from fabrik_writer;

insert into fabrik_private.schema_upgrade(id) values ('0009-save-version-check') on conflict (id) do nothing;
