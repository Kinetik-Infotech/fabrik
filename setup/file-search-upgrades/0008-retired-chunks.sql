-- 0008-retired-chunks
-- base: d466d25
-- A chunk takes a fourth state, retired. A retired version's waiting chunks are retired with it, as its sentences were,
-- and wait again when it comes back, so claim_chunks no longer passes over them on every call. chunks_follow_version
-- replaces sentences_follow_version, and retire_chunks replaces retire_sentences. Every waiting chunk of a version
-- already retired or purged is retired, with its waiting sentences. Safe to run twice. Run as postgres.

alter table file_search.chunk drop constraint if exists chunk_state_check;
alter table file_search.chunk add constraint chunk_state_check check (state in ('waiting','embedded','failed','retired'));

-- A retired version's waiting chunks and sentences are retired, and a version that comes back makes them wait again,
-- so no claim passes over them. A purged version's chunks are deleted with it.
create or replace function file_search.retire_chunks(p_version_id uuid) returns integer
language plpgsql volatile set search_path=pg_catalog as $$
declare n integer;
begin
 update file_search.chunk_sentence s set state='retired' from file_search.chunk c
 where c.version_id=p_version_id and s.chunk_id=c.chunk_id and s.state='waiting';
 update file_search.chunk set state='retired' where version_id=p_version_id and state='waiting';
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function file_search.retire_chunks(uuid) from public, anon, authenticated;
create or replace function file_search.chunks_follow_version() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if new.state='retired' then
  perform file_search.retire_chunks(new.version_id);
 elsif old.state='retired' and new.state<>'purged' then
  update file_search.chunk set state='waiting' where version_id=new.version_id and state='retired';
  update file_search.chunk_sentence s set state='waiting' from file_search.chunk c
  where c.version_id=new.version_id and s.chunk_id=c.chunk_id and s.state='retired';
 end if;
 return null;
end $$;
revoke all on function file_search.chunks_follow_version() from public, anon, authenticated;
drop trigger if exists chunks_follow_version on file_search.file_version;
create trigger chunks_follow_version after update of state on file_search.file_version
 for each row when (old.state is distinct from new.state) execute function file_search.chunks_follow_version();

drop trigger if exists sentences_follow_version on file_search.file_version;
drop function if exists file_search.sentences_follow_version();
drop function if exists file_search.retire_sentences(uuid);

update file_search.chunk_sentence s set state='retired' from file_search.chunk c, file_search.file_version v
where s.chunk_id=c.chunk_id and v.version_id=c.version_id and v.state in ('retired','purged') and s.state='waiting';
update file_search.chunk c set state='retired' from file_search.file_version v
where v.version_id=c.version_id and v.state in ('retired','purged') and c.state='waiting';

insert into file_search.schema_upgrade(id) values ('0008-retired-chunks') on conflict (id) do nothing;
