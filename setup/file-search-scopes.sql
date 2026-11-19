-- fabrik: index every scope's bucket, and every record's latest version, for file search.
-- Run once, after setup.sql and file-search.sql, as postgres.
-- File search then covers each scope's files and records, and fabrik's storage rules and record
-- permissions decide who finds them.
-- A search across every scope ranks the reference scope's files apart, returned as reference_hits,
-- and leaves out each person's sessions scope, whose code starts sessions_, searched only by name.

-- The scopes that exist now, with the files already in their buckets.
select file_search.index_bucket(code) from fabrik.scope;
update file_search.indexed_bucket set ranked_apart=(bucket_id='reference'), searched_by_default=not starts_with(bucket_id, 'sessions_')
where bucket_id in (select code from fabrik.scope);

-- Each scope created later, with its bucket. Owned by postgres, like the bucket trigger.
create function fabrik_storage.index_scope_bucket() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform file_search.index_bucket(new.code);
 update file_search.indexed_bucket set ranked_apart=(new.code='reference'), searched_by_default=not starts_with(new.code, 'sessions_')
 where bucket_id=new.code;
 return new;
end $$;
revoke all on function fabrik_storage.index_scope_bucket() from public, anon, authenticated;
create trigger scope_file_search after insert on fabrik.scope
 for each row execute function fabrik_storage.index_scope_bucket();

-- Records. Each version saved is queued for file search, in its record's scope's bucket, and retires
-- the record's earlier versions. A record moved to another scope is found there, and a deleted record's
-- text and embeddings go with its deletion. A search finds a record's version exactly when
-- fabrik_private.can_read_record would let the searcher read the record, and the record is not deleted.
create or replace function file_search.readable_records() returns setof uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 -- A user who is no enabled actor reads no record, rather than being refused the whole search.
 if not exists(select 1 from fabrik.actor x join fabrik.actor h on h.actor_id=x.accountable_human_id
  where x.auth_user_id=fabrik_private.request_auth_uid() and x.enabled and h.enabled and h.actor_kind='human') then
  return;
 end if;
 return query select r.record_id from fabrik.record r
  where r.deleted_at is null and r.record_id in (select fabrik_private.readable_records());
end $$;

create function fabrik_storage.index_record_version() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform file_search.queue_record(new.record_id, new.version_id, new.version_number,
  (select s.code from fabrik.record r join fabrik.scope s on s.scope_id=r.scope_id where r.record_id=new.record_id), new.title, new.payload);
 return new;
end $$;
create function fabrik_storage.index_record_change() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if new.deleted_at is not null and old.deleted_at is null then
  perform file_search.purge_record(new.record_id);
 elsif new.scope_id is distinct from old.scope_id then
  perform file_search.move_record(new.record_id, (select code from fabrik.scope where scope_id=new.scope_id));
 end if;
 return new;
end $$;
revoke all on function fabrik_storage.index_record_version(), fabrik_storage.index_record_change() from public, anon, authenticated;
create trigger record_version_file_search after insert on fabrik.record_version
 for each row execute function fabrik_storage.index_record_version();
create trigger record_file_search after update of scope_id, deleted_at on fabrik.record
 for each row execute function fabrik_storage.index_record_change();

-- The latest version of each record that exists now.
select file_search.queue_record(v.record_id, v.version_id, v.version_number, s.code, v.title, v.payload)
from (select distinct on (x.record_id) x.* from fabrik.record_version x order by x.record_id, x.version_number desc) v
join fabrik.record r on r.record_id=v.record_id and r.deleted_at is null
join fabrik.scope s on s.scope_id=r.scope_id;
