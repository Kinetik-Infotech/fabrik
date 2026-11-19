-- 0007-any-word
-- base: 597c115
-- The word half of search finds a part that holds any of the question's words, ranked by ts_rank_cd. A question with a
-- quoted phrase or a word marked with a leading - is still read by websearch_to_tsquery. record_worker_answers records each
-- job's latest success in worker_success. worker_problems and failed_worker_runs then set aside a failed run that
-- claimed nothing once a later run of its job succeeded. Search lists the newest 5 of them. Safe to run twice. Run as postgres.

create table if not exists file_search.worker_success (
 job text primary key check (job in ('extract','embed','graph')),
 called_at timestamptz not null
);
alter table file_search.worker_success enable row level security;

create or replace function file_search.record_worker_answers() returns integer
language plpgsql volatile set search_path=pg_catalog as $$
declare failed integer; unanswered integer;
begin
 with succeeded as (
  delete from file_search.worker_call w using net._http_response r
  where w.answered_at is null and r.id=w.request_id and r.status_code between 200 and 299 and r.error_msg is null
  returning w.job, w.called_at)
 insert into file_search.worker_success(job, called_at) select job, max(called_at) from succeeded group by job
 on conflict (job) do update set called_at=greatest(file_search.worker_success.called_at, excluded.called_at);
 update file_search.worker_call w set answered_at=clock_timestamp(), status=r.status_code,
  problem=left(coalesce(r.error_msg, nullif(r.content, ''), 'The worker gave no reason'), 2000)
 from net._http_response r where w.answered_at is null and r.id=w.request_id;
 get diagnostics failed=row_count;
 update file_search.worker_call set answered_at=clock_timestamp(), problem='No answer was recorded'
 where answered_at is null and called_at<clock_timestamp()-interval '1 hour';
 get diagnostics unanswered=row_count;
 delete from file_search.worker_call where answered_at<clock_timestamp()-interval '30 days';
 return failed+unanswered;
end $$;

create or replace function file_search.failed_worker_runs() returns integer
language sql stable security definer set search_path=pg_catalog as $$
 select count(*)::integer from file_search.worker_call w
 where w.problem is not null and w.answered_at>clock_timestamp()-interval '1 day'
  and ((not exists (select 1 from file_search.worker_claim k where k.call_id=w.call_id)
    and not exists (select 1 from file_search.worker_success s where s.job=w.job and s.called_at>w.called_at))
   or exists (select 1 from file_search.worker_claim k
    left join file_search.file_version v on k.chunk_id is null and v.version_id=k.version_id
    left join file_search.chunk c on c.chunk_id=k.chunk_id
    where k.call_id=w.call_id and coalesce(c.state, v.state)='waiting'))
$$;

create or replace function file_search.worker_problems()
returns table(call_id bigint, job text, called_at timestamptz, answered_at timestamptz, status integer, problem text)
language sql stable security definer set search_path=pg_catalog as $$
 select w.call_id, w.job, w.called_at, w.answered_at, w.status, w.problem from file_search.worker_call w
 where w.problem is not null and w.answered_at>clock_timestamp()-interval '1 day'
  and ((not exists (select 1 from file_search.worker_claim k where k.call_id=w.call_id)
    and not exists (select 1 from file_search.worker_success s where s.job=w.job and s.called_at>w.called_at))
   or exists (select 1 from file_search.worker_claim k
    left join file_search.file_version v on k.chunk_id is null and v.version_id=k.version_id
    left join file_search.chunk c on c.chunk_id=k.chunk_id
    where k.call_id=w.call_id and coalesce(c.state, v.state)='waiting'))
 order by w.answered_at desc, w.call_id desc
$$;

create or replace function file_search.search(p_query text, p_embedding real[] default null,
 p_bucket text default null, p_limit integer default 10, p_explain boolean default false) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q tsquery; word text; wq tsquery; v extensions.vector; result jsonb; e_started timestamptz; e_list text; e_at integer; e_hit jsonb; e_text text;
 e_pos integer; e_upto integer; e_a integer; e_b integer; e_sentences jsonb; e_row record; e_found jsonb; e_waiting bigint;
 fusion_k constant integer:=60; pool constant integer:=50; meaning_floor constant double precision:=0;
 section_cap constant integer:=8000; seeds constant integer:=10; steps constant integer:=2;
begin
 if auth.uid() is null then raise exception 'Sign in to search files' using errcode='42501'; end if;
 if p_query is null or length(btrim(p_query)) not between 1 and 1000 then raise exception 'The question must be 1 through 1000 characters' using errcode='22023'; end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'Limit must be 1 through 50' using errcode='22023'; end if;
 if p_embedding is not null and cardinality(p_embedding)<>384 then raise exception 'A question vector has 384 numbers' using errcode='22023'; end if;
 -- The word half finds a part that holds any of the question's words. A word joined by a hyphen,
 -- such as e-mail, is one word, so its parts are found only together. A question with a quoted
 -- phrase, or a word marked with a leading - before a letter, is read as a web search. The phrase
 -- and the exclusion then hold, and a negative number such as -10 stays a word.
 if p_query ~ '"' or p_query ~ '(^|[[:space:]])-[[:alpha:]]' then q:=websearch_to_tsquery('english'::regconfig, p_query);
 else
  for word in select t from regexp_split_to_table(btrim(p_query), '[[:space:]]+') t loop
   -- A stop word such as "the" holds no lexeme, and is passed over without a notice.
   continue when length(to_tsvector('english'::regconfig, word))=0;
   wq:=plainto_tsquery('english'::regconfig, word);
   q:=case when q is null then wq else q || wq end;
  end loop;
  if q is null then q:=plainto_tsquery('english'::regconfig, p_query); end if;
 end if;
 if p_embedding is not null then v:=p_embedding::extensions.vector; end if;
 with recursive latest as (
  select distinct on (coalesce(f.object_id, f.record_id)) f.version_id, f.object_id, f.record_id, f.version_number, f.bucket_id, f.name, f.state
  from file_search.file_version f where f.state not in ('retired','purged')
  order by coalesce(f.object_id, f.record_id), f.queued_at desc),
 -- apart marks a file or a record in a bucket ranked apart, in a search across every bucket. A file's
 -- bucket and name are read live from Storage; a record's are its scope's and its version's title.
 placed as (
  select l.version_id, l.state, o.bucket_id, o.name, null::uuid as record_id, null::integer as version_number
  from latest l join storage.objects o on o.id=l.object_id
  union all
  select l.version_id, l.state, l.bucket_id, l.name, l.record_id, l.version_number from latest l where l.record_id is not null),
 visible as (
  select l.version_id, l.state, l.bucket_id, l.name, l.record_id, l.version_number, p_bucket is null and coalesce(b.ranked_apart, false) as apart
  from placed l
  left join file_search.indexed_bucket b on b.bucket_id=l.bucket_id
  where case when p_bucket is null then coalesce(b.searched_by_default, true) else l.bucket_id=p_bucket end),
 current_chunks as (
  select c.chunk_id, c.version_id, c.section_ordinal, c.place, c.body, c.words, c.embedding, c.state, s.bucket_id, s.name, s.apart,
   s.record_id, s.version_number
  from file_search.chunk c join visible s on s.version_id=c.version_id and s.state='extracted'),
 by_words as (
  select w.chunk_id, w.apart, w.rank from (
   select c.chunk_id, c.apart, row_number() over (partition by c.apart order by ts_rank_cd(c.words, q) desc, c.chunk_id) as rank
   from current_chunks c where c.words @@ q) w
  where w.rank<=pool),
 near as (
  (select c.chunk_id, c.apart, 1-(c.embedding operator(extensions.<=>) v) as similarity
   from current_chunks c where v is not null and c.embedding is not null and not c.apart
   order by c.embedding operator(extensions.<=>) v limit pool)
  union all
  (select c.chunk_id, c.apart, 1-(c.embedding operator(extensions.<=>) v) as similarity
   from current_chunks c where v is not null and c.embedding is not null and c.apart
   order by c.embedding operator(extensions.<=>) v limit pool)),
 by_meaning as (
  select n.chunk_id, n.apart, n.similarity, row_number() over (partition by n.apart order by n.similarity desc, n.chunk_id) as rank
  from near n where n.similarity>=meaning_floor),
 -- The graph, as far as it rests on the chunks searched, walked once for each run.
 entity_seen as (
  select distinct s.entity_id, c.apart from file_search.entity_source s join current_chunks c on c.chunk_id=s.chunk_id),
 seed as (
  select x.entity_id, x.apart, x.similarity from (
   select e.entity_id, s.apart, 1-(e.embedding operator(extensions.<=>) v) as similarity,
    row_number() over (partition by s.apart order by e.embedding operator(extensions.<=>) v, e.entity_id) as n
   from file_search.entity e join entity_seen s on s.entity_id=e.entity_id
   where v is not null and e.embedding is not null) x
  where x.n<=seeds),
 -- Each step follows the relations of the entities reached so far, either way, through their
 -- indexes, that rest on a chunk searched in the same run.
 walk(entity_id, from_id, relation_id, similarity, step, apart) as (
  select entity_id, null::uuid, null::uuid, similarity, 0, apart from seed
  union all
  select g.to_id, w.entity_id, g.relation_id, w.similarity, w.step+1, w.apart from walk w
  cross join lateral (
   select r.relation_id, r.target_id as to_id from file_search.relation r where r.source_id=w.entity_id
   union all
   select r.relation_id, r.source_id from file_search.relation r where r.target_id=w.entity_id) g
  where w.step<steps
   and exists (select 1 from file_search.relation_source s join current_chunks c on c.chunk_id=s.chunk_id
    where s.relation_id=g.relation_id and c.apart=w.apart)),
 -- Each entity and relation at the step of its strongest path, in each run.
 reached as (
  select distinct on (w.apart, w.entity_id) w.entity_id, w.apart, w.step, w.similarity/(w.step+1) as weight from walk w
  order by w.apart, w.entity_id, w.similarity/(w.step+1) desc, w.step),
 walked as (
  select distinct on (w.apart, w.relation_id) w.relation_id, w.from_id, w.entity_id as to_id, w.apart, w.step, w.similarity/w.step as weight from walk w where w.relation_id is not null
  order by w.apart, w.relation_id, w.similarity/w.step desc, w.step),
 graph_chunks as (
  select x.chunk_id, x.apart, sum(x.weight) as weight from (
   select s.chunk_id, r.apart, r.weight from reached r join file_search.entity_source s on s.entity_id=r.entity_id
   union all
   select s.chunk_id, w.apart, w.weight from walked w join file_search.relation_source s on s.relation_id=w.relation_id) x
  join current_chunks c on c.chunk_id=x.chunk_id and c.apart=x.apart group by x.chunk_id, x.apart having sum(x.weight)>0),
 by_graph as (
  select g.chunk_id, g.apart, g.weight, g.rank from (
   select g.chunk_id, g.apart, g.weight, row_number() over (partition by g.apart order by g.weight desc, g.chunk_id) as rank
   from graph_chunks g) g
  where g.rank<=pool),
 fused as (
  select x.chunk_id, x.apart, sum(1.0/(fusion_k+x.rank)) as score, array_agg(x.half order by x.half desc) as found,
   jsonb_build_object('words', max(x.rank) filter (where x.half='words'), 'meaning', max(x.rank) filter (where x.half='meaning'),
    'graph', max(x.rank) filter (where x.half='graph')) as ranks,
   max(x.measure) filter (where x.half='meaning') as similarity, max(x.measure) filter (where x.half='graph') as graph_weight
  from (select chunk_id, apart, rank, 'words' as half, null::double precision as measure from by_words
        union all select chunk_id, apart, rank, 'meaning', similarity from by_meaning
        union all select chunk_id, apart, rank, 'graph', weight from by_graph) x
  group by x.chunk_id, x.apart),
 top as (
  select t.* from (
   select f.chunk_id, f.apart, f.score, f.found, f.ranks, f.similarity, f.graph_weight, c.version_id, c.section_ordinal, c.bucket_id, c.name, c.place, c.body,
    c.record_id, c.version_number, row_number() over (partition by f.apart order by f.score desc, f.chunk_id) as pos
   from fused f join current_chunks c on c.chunk_id=f.chunk_id) t
  where t.pos<=p_limit),
 -- Each section a hit falls in, once, in the order of its best hit, the reference hits' first.
 hit_sections as (
  select x.version_id, x.ordinal, x.place, x.body, t.bucket_id, t.name, t.record_id, t.version_number, t.apart, min(t.pos) as best,
   array_agg(t.body order by t.pos) as hit_bodies
  from top t join file_search.section x on x.version_id=t.version_id and x.ordinal=t.section_ordinal
  group by x.version_id, x.ordinal, x.place, x.body, t.bucket_id, t.name, t.record_id, t.version_number, t.apart),
 numbered as (select h.*, (row_number() over (order by h.apart desc, h.best) - 1)::integer as idx from hit_sections h),
 -- Each section's part as returned, and its text again with the question's words marked.
 parts as (
  select n.*, x.part, case when p_explain and numnode(q)>0 then ts_headline('english'::regconfig, x.part->>'text', q,
    'HighlightAll=true, StartSel='||chr(57344)||', StopSel='||chr(57345)) end as marked
  from numbered n cross join lateral (select file_search.section_part(n.body, n.place, n.hit_bodies, section_cap) as part) x),
 hit as (
  select t.chunk_id, t.apart, t.score, jsonb_build_object(
     'bucket', t.bucket_id, 'file', t.name, 'place', t.place,
     'snippet', case when 'words'=any(t.found) then ts_headline('english'::regconfig, t.body, q, 'MaxFragments=1,MaxWords=40,MinWords=15') else left(t.body, 300) end,
     'found', to_jsonb(t.found), 'fusion_score', round(t.score::numeric, 6), 'ranks', t.ranks, 'chunk_id', t.chunk_id,
     'similarity', round(t.similarity::numeric, 4), 'graph_weight', round(t.graph_weight::numeric, 4),
     'section', p.idx)
     -- A record's hit names the record and the version found.
     || case when t.record_id is not null then jsonb_build_object('record_id', t.record_id, 'version_number', t.version_number) else '{}'::jsonb end
     -- An explained search gives where the hit's chunk falls in its section's text, in characters
     -- from 0, its spaces matched as any run of spaces; null where the section's part leaves it out.
     || case when p_explain then jsonb_build_object('chunk', case when c.at>0 then jsonb_build_object('start', c.at-1, 'end', c.upto-1) end) else '{}'::jsonb end
     -- A hit the graph found names the entities and relations behind it that its run's walk reached.
     || case when 'graph'=any(t.found) then jsonb_build_object(
      -- Each name and type as the hit's own chunk spells it.
      'entities', coalesce((select jsonb_agg(jsonb_build_object('entity_id', s.entity_id, 'name', s.name, 'type', s.entity_type, 'steps', r.step, 'description', s.description)
        order by r.step, s.name) from reached r
        join file_search.entity_source s on s.entity_id=r.entity_id and s.chunk_id=t.chunk_id where r.apart=t.apart), '[]'::jsonb),
      'relations', coalesce((select jsonb_agg(jsonb_build_object('source', a.name, 'target', b.name, 'keywords', to_jsonb(s.keywords),
         'steps', w.step, 'description', s.description) order by w.step, a.name, b.name)
        from walked w join file_search.relation l on l.relation_id=w.relation_id
        join file_search.relation_source s on s.relation_id=w.relation_id and s.chunk_id=t.chunk_id
        join file_search.entity_source a on a.entity_id=l.source_id and a.chunk_id=t.chunk_id
        join file_search.entity_source b on b.entity_id=l.target_id and b.chunk_id=t.chunk_id
        where w.apart=t.apart), '[]'::jsonb))
      else '{}'::jsonb end as body
  from top t left join parts p on p.version_id=t.version_id and p.ordinal=t.section_ordinal
  cross join lateral (select case when p_explain then regexp_replace(regexp_replace(t.body, '([^[:alnum:][:space:]])', '\\\1', 'g'), '[[:space:]]+', '[[:space:]]+', 'g') end as pattern) r
  cross join lateral (select regexp_instr(p.part->>'text', r.pattern) as at, regexp_instr(p.part->>'text', r.pattern, 1, 1, 1) as upto) c)
 select jsonb_build_object(
  'hits', coalesce((select jsonb_agg(h.body order by h.score desc, h.chunk_id) from hit h where not h.apart), '[]'::jsonb),
  'reference_hits', coalesce((select jsonb_agg(h.body order by h.score desc, h.chunk_id) from hit h where h.apart), '[]'::jsonb),
  'sections', coalesce((select jsonb_agg(jsonb_build_object(
     'bucket', p.bucket_id, 'file', p.name, 'place', p.place)
     || case when p.record_id is not null then jsonb_build_object('record_id', p.record_id, 'version_number', p.version_number) else '{}'::jsonb end
     || p.part || case when p_explain then jsonb_build_object('marked', p.marked) else '{}'::jsonb end
     order by p.idx) from parts p), '[]'::jsonb),
  'stages', jsonb_build_object(
     'words', (select count(*) from by_words),
     'meaning', (select count(*) from by_meaning),
     'graph', (select count(*) from by_graph),
     -- Each seed's name and type as the earliest chunk its run searched spells it, the reference
     -- run's first.
     'graph_seeds', coalesce((select jsonb_agg(jsonb_build_object('entity_id', x.entity_id, 'name', n.name, 'type', n.entity_type, 'similarity', round(x.similarity::numeric, 4))
        order by x.apart desc, x.similarity desc, n.name) from seed x
        cross join lateral (select s.name, s.entity_type from file_search.entity_source s join current_chunks c on c.chunk_id=s.chunk_id
         where s.entity_id=x.entity_id and c.apart=x.apart order by s.saved_at, s.chunk_id limit 1) n), '[]'::jsonb),
     -- Each relation the walk took, from the entity it was walked from to the one it reached, at the
     -- step of its strongest path, the reference run's first. Its names and keywords are as the
     -- earliest chunk its run searched that holds the relation spells them.
     'graph_walk', coalesce((select jsonb_agg(jsonb_build_object('from', w.from_id, 'from_name', n.from_name, 'relation', w.relation_id,
        'keywords', to_jsonb(n.keywords), 'to', w.to_id, 'to_name', n.to_name, 'step', w.step, 'weight', round(w.weight::numeric, 4))
        order by w.apart desc, w.step, w.weight desc, n.from_name, n.to_name) from walked w
        cross join lateral (select a.name as from_name, b.name as to_name, s.keywords from file_search.relation_source s
         join current_chunks c on c.chunk_id=s.chunk_id and c.apart=w.apart
         join file_search.entity_source a on a.entity_id=w.from_id and a.chunk_id=s.chunk_id
         join file_search.entity_source b on b.entity_id=w.to_id and b.chunk_id=s.chunk_id
         where s.relation_id=w.relation_id order by s.saved_at, s.chunk_id limit 1) n), '[]'::jsonb),
     'suppressed', (select count(*) from near where similarity<meaning_floor),
     'fused', (select count(*) from fused),
     'returned', (select count(*) from top),
     'floor', case when meaning_floor>0 then meaning_floor end,
     'awaiting_text', (select count(*) from visible where state='waiting'),
     'failed_text', (select count(*) from visible where state='failed'),
     'unsupported', (select count(*) from visible where state='unsupported'),
     'no_text', (select count(*) from visible where state='no_text'),
     -- The files this user can open that search cannot read, newest first, each with its reason.
     'unreadable', coalesce((select jsonb_agg(jsonb_build_object('bucket', u.bucket_id, 'file', u.name, 'state', u.state, 'error', u.error)
        order by u.finished_at desc nulls last, u.name)
       from (select s.bucket_id, s.name, s.state, f.error, f.finished_at from visible s
        join file_search.file_version f on f.version_id=s.version_id
        where s.state in ('unsupported','no_text','failed')
        order by f.finished_at desc nulls last, s.name limit 20) u), '[]'::jsonb),
     'awaiting_vector', (select count(*) from current_chunks where state='waiting'),
     'failed_vector', (select count(*) from current_chunks where state='failed'),
     -- Chunks not yet read for the graph, without those an open batch holds or whose read failed 3
     -- times, then those failed, with their reasons, and entities still waiting for a vector.
     'awaiting_extraction', (select count(*) from current_chunks c
       where c.record_id is null and not exists (select 1 from file_search.chunk_extraction x where x.chunk_id=c.chunk_id)
        and not exists (select 1 from file_search.chunk_extraction_attempt t where t.chunk_id=c.chunk_id and t.state='failed')
        and c.chunk_id not in (select file_search.graph_held_chunks())),
     'failed_extraction', (select count(*) from current_chunks c join file_search.chunk_extraction_attempt t on t.chunk_id=c.chunk_id
       where t.state='failed' and not exists (select 1 from file_search.chunk_extraction x where x.chunk_id=c.chunk_id)),
     'failed_extraction_parts', coalesce((select jsonb_agg(jsonb_build_object('bucket', u.bucket_id, 'file', u.name, 'place', u.place, 'error', u.error)
        order by u.bucket_id, u.name, u.place)
       from (select c.bucket_id, c.name, c.place, t.error from current_chunks c join file_search.chunk_extraction_attempt t on t.chunk_id=c.chunk_id
        where t.state='failed' and not exists (select 1 from file_search.chunk_extraction x where x.chunk_id=c.chunk_id)
        order by c.bucket_id, c.name, c.place limit 20) u), '[]'::jsonb),
     'awaiting_entity_vector', (select count(*) from file_search.entity e join entity_seen x on x.entity_id=e.entity_id where e.state='waiting'),
     'failed_worker_runs', file_search.failed_worker_runs(),
     -- The newest 5 runs that went wrong, with the files each claimed that this user can open.
     -- in_flight marks a file with a claim and no outcome: the run stopped while it was at that file.
     'worker_problems', coalesce((select jsonb_agg(jsonb_build_object(
        'job', p.job, 'called_at', p.called_at, 'answered_at', p.answered_at, 'status', p.status, 'problem', p.problem,
        'files', coalesce((select jsonb_agg(jsonb_build_object('bucket', f.bucket_id, 'file', f.name, 'in_flight', f.in_flight)
           order by f.bucket_id, f.name)
          from (select o.bucket_id, o.name, bool_or(k.recorded_at is null) as in_flight
           from file_search.worker_claim k join storage.objects o on o.id=k.object_id
           where k.call_id=p.call_id and (p_bucket is null or o.bucket_id=p_bucket)
           group by o.bucket_id, o.name) f), '[]'::jsonb))
        order by p.answered_at desc, p.call_id desc)
       from (select * from file_search.worker_problems() w order by w.answered_at desc, w.call_id desc limit 5) p), '[]'::jsonb)),
  'degraded', case when v is null then 'The semantic search did not run: no question vector was given.' end)
 into result;
 if p_explain then
  e_started:=clock_timestamp();
  -- Every hit's sentences in one read, since each read checks again which files the user may open.
  select coalesce(jsonb_object_agg(x.chunk_id, x.found), '{}'), coalesce(sum(x.waiting), 0) into e_found, e_waiting from (
   select s.chunk_id, count(*) filter (where s.state='waiting') as waiting,
    coalesce(jsonb_agg(jsonb_build_object(
      'pattern', regexp_replace(regexp_replace(s.body, '([^[:alnum:][:space:]])', '\\\1', 'g'), '[[:space:]]+', '[[:space:]]+', 'g'),
      'similarity', round(greatest(0, least(1, 1-(s.embedding operator(extensions.<=>) v)))::numeric, 4)) order by s.ordinal)
     filter (where s.state='embedded' and v is not null), '[]') as found
   from file_search.chunk_sentence s
   where s.chunk_id=any(array(select (h->>'chunk_id')::uuid from jsonb_array_elements((result->'hits')||(result->'reference_hits')) h))
   group by s.chunk_id) x;
  foreach e_list in array array['hits','reference_hits'] loop
   for e_at in 0..jsonb_array_length(result->e_list)-1 loop
    e_hit:=result->e_list->e_at;
    continue when jsonb_typeof(e_hit->'chunk')<>'object';
    -- Each sentence placed in order from the chunk's start, its spaces matched as any run of spaces.
    e_text:=result->'sections'->((e_hit->>'section')::integer)->>'text';
    e_pos:=(e_hit->'chunk'->>'start')::integer+1; e_upto:=(e_hit->'chunk'->>'end')::integer+1; e_sentences:='[]';
    for e_row in select x->>'pattern' as pattern, x->'similarity' as similarity from jsonb_array_elements(coalesce(e_found->(e_hit->>'chunk_id'), '[]')) x loop
     e_a:=regexp_instr(e_text, e_row.pattern, e_pos);
     continue when e_a=0 or e_a>=e_upto;
     e_b:=regexp_instr(e_text, e_row.pattern, e_pos, 1, 1);
     e_sentences:=e_sentences||jsonb_build_object('start', e_a-1, 'end', e_b-1, 'similarity', e_row.similarity);
     e_pos:=e_b;
    end loop;
    result:=jsonb_set(result, array[e_list, e_at::text, 'sentences'], e_sentences);
   end loop;
  end loop;
  result:=jsonb_set(result, '{stages,awaiting_sentence_vector}', to_jsonb(e_waiting))
   || jsonb_build_object('explain_ms', round(extract(epoch from clock_timestamp()-e_started)*1000));
 end if;
 return jsonb_set(jsonb_set(result, '{hits}', coalesce((select jsonb_agg(h - 'chunk_id' order by n) from jsonb_array_elements(result->'hits') with ordinality e(h, n)), '[]'::jsonb)),
  '{reference_hits}', coalesce((select jsonb_agg(h - 'chunk_id' order by n) from jsonb_array_elements(result->'reference_hits') with ordinality e(h, n)), '[]'::jsonb));
end $$;

insert into file_search.schema_upgrade(id) values ('0007-any-word') on conflict (id) do nothing;
