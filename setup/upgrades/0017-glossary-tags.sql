-- 0017-glossary-tags
-- base: 1026ac4
-- redeploy: fabrik-apps, graph-reader
-- A glossary term can name the class it is one of, such as the topic Masks, and the broader term of that class it comes
-- under. save_term sets both and get_reference gives them. An entity of a class with such terms is one of them, with the
-- terms it comes under. fabrik_add_extraction adds entities and relations to a part already read and keeps what is
-- there, fabrik_tag_file tags a file with such terms, and fabrik_get_tagged_files lists a term's files.
-- fabrik_get_unextracted lists the terms as instances. Needs file search's upgrade 0009-add-extraction.
-- The same text is in setup.sql. Safe to run twice. Run as the postgres login.

-- The glossary's terms can each name one thing of a class, as instance_of, and the broader term of that class they
-- come under, as broader.
set role fabrik_owner;
alter table fabrik.glossary_term add column if not exists instance_of text;
alter table fabrik.glossary_term add column if not exists instance_kind text generated always as (case when instance_of is not null then 'class' end) stored;
alter table fabrik.glossary_term add column if not exists broader text;
alter table fabrik.glossary_term drop constraint if exists glossary_term_instance_of_fkey;
alter table fabrik.glossary_term add constraint glossary_term_instance_of_fkey foreign key (instance_of, instance_kind) references fabrik.glossary_term(term, kind);
alter table fabrik.glossary_term drop constraint if exists glossary_term_broader_fkey;
alter table fabrik.glossary_term add constraint glossary_term_broader_fkey foreign key (broader) references fabrik.glossary_term(term);
alter table fabrik.glossary_term drop constraint if exists glossary_term_instance_check;
alter table fabrik.glossary_term add constraint glossary_term_instance_check check (instance_of is null or kind='term');
alter table fabrik.glossary_term drop constraint if exists glossary_term_broader_check;
alter table fabrik.glossary_term add constraint glossary_term_broader_check check (broader is null or (instance_of is not null and broader<>term));
create index if not exists glossary_term_instance_idx on fabrik.glossary_term(instance_of, instance_kind);
create index if not exists glossary_term_broader_idx on fabrik.glossary_term(broader);
grant create on schema fabrik_task to fabrik_reader;
reset role;

grant create on schema fabrik to fabrik_reader;
set role fabrik_reader;
drop function if exists fabrik.fabrik_save_term(text,text,text,text,text[],text,text,boolean);
drop function if exists fabrik_task.save_term(text,text,text,text,text[],text,text,boolean);

-- A glossary term, named in any case, as {term, kind, record_id, from_class, to_class, instance_of, broader,
-- in_use_as_class}, or null. in_use_as_class is true for a class at the end of a relationship or of a record kind, or
-- that a term is one of. Needs read in the reference scope.
create or replace function fabrik_task.glossary_entry(p_term text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if not fabrik_private.can_read_scope(fabrik_private.reference_scope()) then raise exception 'Scope or record unavailable' using errcode='42501'; end if;
 return (select jsonb_build_object('term',g.term,'kind',g.kind,'record_id',g.record_id,'from_class',g.from_class,'to_class',g.to_class,
   'instance_of',g.instance_of,'broader',g.broader,
  'in_use_as_class',exists(select 1 from fabrik.glossary_term x where g.term in (x.from_class,x.to_class,x.instance_of))
    or exists(select 1 from fabrik.dictionary_table t where t.class_term=g.term))
  from fabrik.glossary_term g where lower(g.term)=lower(btrim(coalesce(p_term,''))));
end $$;

-- The glossary or the data dictionary as it stands, for an actor with read in the reference scope.
-- The glossary lists each term with its kind, definition and other names, each relationship's two classes,
-- and, for a term that names one thing of a class, that class as instance_of and the term it comes under as broader. The data dictionary lists each record kind with its class, each field and each source.
create or replace function fabrik.fabrik_get_reference(p_part text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fabrik_private.read_actor();
 if p_part is null or p_part not in ('glossary','dictionary') then
  raise exception 'Name the glossary or the dictionary' using errcode='22023';
 end if;
 if not fabrik_private.can_read_scope(fabrik_private.reference_scope()) then raise exception 'Scope or record unavailable' using errcode='42501'; end if;
 if p_part='glossary' then
  return jsonb_build_object('part','glossary','rows',(select coalesce(jsonb_agg(jsonb_build_object('term',term,'kind',kind,'definition',definition,
    'other_names',to_jsonb(other_names),'from_class',from_class,'to_class',to_class,'instance_of',instance_of,'broader',broader,
    'record_id',record_id,'version_id',version_id)
    order by lower(term)),'[]'::jsonb) from fabrik.glossary_term));
 end if;
 return jsonb_build_object('part','dictionary',
  'tables',(select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'class',class_term,'meaning',meaning,'record_id',record_id,'version_id',version_id)
    order by table_name),'[]'::jsonb) from fabrik.dictionary_table),
  'columns',(select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',type,'required',required,'term',term,'meaning',meaning)
    order by table_name,column_name),'[]'::jsonb) from fabrik.dictionary_column),
  'sources',(select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'system',system,'field',field)
    order by table_name,column_name,system),'[]'::jsonb) from fabrik.dictionary_source));
end $$;

-- Saves a glossary term, class or relationship, named in any case, as a new version of its model
-- record in the reference scope, under the caller's grant there, or with p_preview returns the
-- request and grant it would save with. A relationship names a class at each end, from p_from_class
-- to p_to_class; a term or a class has no ends. A term that names one thing of a class, such as the topic
-- Masks, names that class as p_instance_of, and may name the broader term of the same class it comes under as
-- p_broader. A class at the end of a relationship or a record kind, or that a term is one of, stays a class. A term's
-- name is fixed: a new name is a new term.
create or replace function fabrik_task.save_term(p_term text, p_kind text, p_definition text, p_reason text,
 p_other_names text[] default '{}', p_from_class text default null, p_to_class text default null, p_preview boolean default false,
 p_instance_of text default null, p_broader text default null) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare sid uuid:=(fabrik_task.scope('reference')->>'scope_id')::uuid; t text:=btrim(coalesce(p_term,'')); e jsonb; f jsonb; g jsonb;
 c jsonb; b jsonb; names jsonb; payload jsonb; req jsonb; latest jsonb;
begin
 if length(t) not between 1 and 100 then raise exception 'A term is 1 to 100 characters' using errcode='22023'; end if;
 if p_kind is null or p_kind not in ('term','class','relationship') then raise exception 'A term''s kind is term, class or relationship' using errcode='22023'; end if;
 if length(btrim(coalesce(p_definition,''))) not between 1 and 1000 then raise exception 'A definition is 1 to 1000 characters' using errcode='22023'; end if;
 select coalesce(jsonb_agg(distinct btrim(n)),'[]'::jsonb) into names from unnest(coalesce(p_other_names,'{}')) n where btrim(n)<>'' and lower(btrim(n))<>lower(t);
 if jsonb_array_length(names)>20 then raise exception 'A term has at most 20 other names' using errcode='22023'; end if;
 if p_kind='relationship' then
  if p_from_class is null or p_to_class is null then
   raise exception 'A relationship names the class at each of its ends, as p_from_class and p_to_class' using errcode='22023';
  end if;
  f:=fabrik_task.glossary_entry(p_from_class); g:=fabrik_task.glossary_entry(p_to_class);
  if f is null or f->>'kind'<>'class' then
   raise exception 'A relationship''s ends are classes, and "%" is not a class in the glossary',btrim(p_from_class) using errcode='23514';
  end if;
  if g is null or g->>'kind'<>'class' then
   raise exception 'A relationship''s ends are classes, and "%" is not a class in the glossary',btrim(p_to_class) using errcode='23514';
  end if;
 elsif p_from_class is not null or p_to_class is not null then
  raise exception 'Only a relationship names classes at its ends' using errcode='22023';
 end if;
 if nullif(btrim(p_instance_of),'') is not null then
  if p_kind<>'term' then raise exception 'Only a term names the class it is one of, as p_instance_of' using errcode='22023'; end if;
  c:=fabrik_task.glossary_entry(p_instance_of);
  if c is null or c->>'kind'<>'class' then
   raise exception 'A term is one of a class, and "%" is not a class in the glossary',btrim(p_instance_of) using errcode='23514';
  end if;
 end if;
 if nullif(btrim(p_broader),'') is not null then
  if c is null then raise exception 'A term names a broader term only with the class it is one of, as p_instance_of' using errcode='22023'; end if;
  b:=fabrik_task.glossary_entry(p_broader);
  if b is null or b->>'instance_of' is distinct from c->>'term' then
   raise exception 'A broader term is one of the same class, and "%" is not a % in the glossary',btrim(p_broader),c->>'term' using errcode='23514';
  end if;
 end if;
 e:=fabrik_task.glossary_entry(t);
 if e is not null and e->>'kind'='class' and p_kind<>'class' and (e->>'in_use_as_class')::boolean then
  raise exception '"%" is the class at the end of a relationship or of a record kind, so it stays a class',e->>'term' using errcode='23514';
 end if;
 if e is not null then t:=e->>'term'; end if;
 payload:=jsonb_build_object('model_kind','observed_current','source_version','fabrik_save_term','source_status','saved',
  'description',btrim(p_definition),'graph',jsonb_build_object('format_version',1,'nodes',jsonb_build_array(jsonb_build_object(
   'id','term','type',p_kind,'label',t,'attributes',jsonb_build_object('term',t,'kind',p_kind,'definition',btrim(p_definition),'other_names',names,
    'from_class',f->>'term','to_class',g->>'term','instance_of',c->>'term','broader',b->>'term'))),'edges','[]'::jsonb));
 if e is null then
  req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',gen_random_uuid(),'scope_id',sid,'kind','model',
   'expected_previous_version_id',null,'title','Glossary: '||t,'reason',p_reason,'payload',payload,'links','[]'::jsonb);
  return fabrik_task.save(req,array['create'],p_preview);
 end if;
 latest:=fabrik_task.latest((e->>'record_id')::uuid);
 req:=jsonb_build_object('request_id',gen_random_uuid(),'record_id',e->'record_id','scope_id',sid,'kind','model',
  'expected_previous_version_id',latest->'version'->'version_id','title','Glossary: '||t,'reason',p_reason,'payload',payload,
  'links',fabrik_task.request_links(latest));
 return fabrik_task.save(req,array['edit'],p_preview);
end $$;

-- The functions actors call. Each runs its body; a change refused for want of permission is undone,
-- logged and answered {"refused": true, "problem": <fabrik's message>}, as every function that changes
-- data does (section 8t).
create or replace function fabrik.fabrik_save_term(p_term text, p_kind text, p_definition text, p_reason text,
 p_other_names text[] default '{}', p_from_class text default null, p_to_class text default null, p_preview boolean default false,
 p_instance_of text default null, p_broader text default null) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare m text; c text;
begin
 return fabrik_task.save_term(p_term,p_kind,p_definition,p_reason,p_other_names,p_from_class,p_to_class,p_preview,p_instance_of,p_broader);
exception when insufficient_privilege then
 get stacked diagnostics m=message_text, c=pg_exception_context;
 if split_part(c,E'\n',1) not like '%at RAISE' then raise; end if;
 return fabrik_task.refused('fabrik_save_term',m,'reference','model',null);
end $$;
reset role;
revoke create on schema fabrik from fabrik_reader;
set role fabrik_owner;
revoke create on schema fabrik_task from fabrik_reader;
reset role;

grant create on schema fabrik_private to fabrik_writer;
set role fabrik_writer;
-- Keeps the glossary's and the data dictionary's rows at each term's and record kind's latest
-- version: runs after each saved version whose payload fabrik_save_term, fabrik_save_dictionary or fabrik_save_relation_type made,
-- and refuses one that breaks the rules above.
create or replace function fabrik_private.keep_reference() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare src text:=new.payload->>'source_version'; n jsonb; a jsonb; old_term text; x jsonb; t text;
begin
 if src is null or src not in ('fabrik_save_term','fabrik_save_dictionary','fabrik_save_relation_type') then return null; end if;
 if not fabrik_private.in_reference_scope(new.record_id) then
  raise exception 'A glossary term or a record kind is a model record in the reference scope' using errcode='23514';
 end if;
 n:=new.payload->'graph'->'nodes'->0; a:=n->'attributes';
 if src='fabrik_save_relation_type' then
  if jsonb_array_length(new.payload->'graph'->'nodes')<>1 or n->>'type' is distinct from 'relation_type' or n->>'label' is distinct from a->>'code' then
   raise exception 'A relation type''s record holds one node, the relation' using errcode='23514';
  end if;
  if exists(select 1 from fabrik.relation_type r where r.record_id=new.record_id and r.code<>a->>'code') then
   raise exception 'A relation''s code is fixed: save "%" as a new relation',a->>'code' using errcode='23514';
  end if;
  -- Every route that saves a relation's version, fabrik_save_version included, comes through here.
  if not exists(select 1 from fabrik.actor x where x.actor_id=new.executor_actor_id and x.authority_class='administrator') then
   raise exception 'Administrator authority required to save a relation' using errcode='42501';
  end if;
  if coalesce(a->>'code','') !~ '^[a-z]+(_[a-z]+)*$' or length(a->>'code')>100 or length(btrim(coalesce(a->>'description','')))=0 then
   raise exception 'A relation is lower-case words joined by underscores, such as depends_on, with a description' using errcode='22023';
  end if;
  -- A code belongs to one record. A seeded relation with no record yet takes the first record that names it.
  if exists(select 1 from fabrik.relation_type r where r.code=a->>'code' and r.record_id is not null and r.record_id<>new.record_id) then
   raise exception 'The relation "%" belongs to another record',a->>'code' using errcode='23514';
  end if;
  insert into fabrik.relation_type(code,description,record_id,version_id)
  values(a->>'code',a->>'description',new.record_id,new.version_id)
  on conflict (code) do update set description=excluded.description,record_id=excluded.record_id,version_id=excluded.version_id;
  return null;
 end if;
 if src='fabrik_save_term' then
  if jsonb_array_length(new.payload->'graph'->'nodes')<>1 or n->>'type' is distinct from a->>'kind' or n->>'label' is distinct from a->>'term' then
   raise exception 'A glossary term''s record holds one node, the term' using errcode='23514';
  end if;
  select term into old_term from fabrik.glossary_term where record_id=new.record_id;
  if old_term is not null and old_term<>a->>'term' then
   raise exception 'A term''s name is fixed: save "%" as a new term',a->>'term' using errcode='23514';
  end if;
  if a->>'kind'='relationship' then
   foreach t in array array[a->>'from_class',a->>'to_class'] loop
    if not exists(select 1 from fabrik.glossary_term g where g.term=t and g.kind='class') then
     raise exception 'A relationship''s ends are classes, and "%" is not a class in the glossary',t using errcode='23514';
    end if;
   end loop;
  end if;
  if a->>'instance_of' is not null and not exists(select 1 from fabrik.glossary_term g where g.term=a->>'instance_of' and g.kind='class') then
   raise exception 'A term is one of a class, and "%" is not a class in the glossary',a->>'instance_of' using errcode='23514';
  end if;
  if a->>'broader' is not null then
   if not exists(select 1 from fabrik.glossary_term g where g.term=a->>'broader' and g.instance_of is not distinct from a->>'instance_of') then
    raise exception 'A broader term is one of the same class, and "%" is not a % in the glossary',a->>'broader',coalesce(a->>'instance_of','') using errcode='23514';
   end if;
   if exists(with recursive up(term,n) as (select a->>'broader',1 union all
     select g.broader,u.n+1 from up u join fabrik.glossary_term g on g.term=u.term where g.broader is not null and u.n<1000)
    select 1 from up where term=a->>'term') then
    raise exception '"%" cannot come under "%", which comes under it',a->>'term',a->>'broader' using errcode='23514';
   end if;
  end if;
  if exists(select 1 from fabrik.glossary_term g where g.broader=a->>'term' and g.instance_of is distinct from a->>'instance_of') then
   raise exception '"%" has narrower terms, so it stays one of the class they are',a->>'term' using errcode='23514';
  end if;
  insert into fabrik.glossary_term(term,kind,definition,other_names,from_class,to_class,instance_of,broader,record_id,version_id)
  values(a->>'term',a->>'kind',a->>'definition',coalesce((select array_agg(v order by v) from jsonb_array_elements_text(a->'other_names') v),'{}'),
   a->>'from_class',a->>'to_class',a->>'instance_of',a->>'broader',new.record_id,new.version_id)
  on conflict (record_id) do update set kind=excluded.kind,definition=excluded.definition,other_names=excluded.other_names,
   from_class=excluded.from_class,to_class=excluded.to_class,instance_of=excluded.instance_of,broader=excluded.broader,version_id=excluded.version_id;
  return null;
 end if;
 if n->>'type' is distinct from 'table' then raise exception 'A record kind''s record starts with its table node' using errcode='23514'; end if;
 if exists(select 1 from fabrik.dictionary_table d where d.record_id=new.record_id and d.table_name<>a->>'table')
  or exists(select 1 from fabrik.dictionary_table d where d.table_name=a->>'table' and d.record_id<>new.record_id) then
  raise exception 'A record kind''s name is fixed: save "%" as a new record kind',a->>'table' using errcode='23514';
 end if;
 if not exists(select 1 from fabrik.glossary_term g where g.term=a->>'class' and g.kind='class') then
  raise exception 'A record kind needs its glossary class, and "%" is not a class in the glossary',coalesce(a->>'class','') using errcode='23514';
 end if;
 delete from fabrik.dictionary_source where table_name=a->>'table';
 delete from fabrik.dictionary_column where table_name=a->>'table';
 insert into fabrik.dictionary_table(table_name,class_term,meaning,record_id,version_id) values(a->>'table',a->>'class',a->>'meaning',new.record_id,new.version_id)
 on conflict (record_id) do update set class_term=excluded.class_term,meaning=excluded.meaning,version_id=excluded.version_id;
 for x in select value->'attributes' from jsonb_array_elements(new.payload->'graph'->'nodes') where value->>'type'='column' loop
  insert into fabrik.dictionary_column(table_name,column_name,type,required,term,meaning,version_id)
  values(a->>'table',x->>'column',x->>'type',(x->>'required')::boolean,x->>'term',x->>'meaning',new.version_id);
 end loop;
 for x in select value->'attributes' from jsonb_array_elements(new.payload->'graph'->'nodes') where value->>'type'='source' loop
  insert into fabrik.dictionary_source(table_name,column_name,system,field,version_id)
  values(a->>'table',x->>'column',x->>'system',x->>'field',new.version_id);
 end loop;
 return null;
end $$;

-- A deleted term or record kind leaves the glossary or the data dictionary. A term still in use,
-- as a relationship's end, a record kind's class, a field's term or a field's source, the class a term is one of or a
-- term's broader term, cannot be deleted until what uses it changes.
create or replace function fabrik_private.forget_reference() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare t text;
begin
 if old.deleted_at is not null or new.deleted_at is null then return null; end if;
 select table_name into t from fabrik.dictionary_table where record_id=new.record_id;
 if t is not null then
  delete from fabrik.dictionary_source where table_name=t;
  delete from fabrik.dictionary_column where table_name=t;
  delete from fabrik.dictionary_table where table_name=t;
 end if;
 delete from fabrik.glossary_term where record_id=new.record_id;
 return null;
exception when foreign_key_violation then
 raise exception 'This term is still used by a relationship, another term or the data dictionary: change those first, then delete it' using errcode='23503';
end $$;
reset role;
revoke create on schema fabrik_private from fabrik_writer;
revoke all on function fabrik_private.keep_reference(), fabrik_private.forget_reference() from public, anon, authenticated;
grant execute on function fabrik_private.keep_reference(), fabrik_private.forget_reference() to fabrik_owner;
revoke all on function fabrik_task.save_term(text,text,text,text,text[],text,text,boolean,text,text) from public, anon;
grant execute on function fabrik_task.save_term(text,text,text,text,text[],text,text,boolean,text,text) to authenticated;
revoke all on function fabrik.fabrik_save_term(text,text,text,text,text[],text,text,boolean,text,text) from public, anon;
grant execute on function fabrik.fabrik_save_term(text,text,text,text,text[],text,text,boolean,text,text) to authenticated;


-- ===================================================================
-- 8z. Tags: a scope's files tagged with the glossary's terms of a class, such as its topics.
-- ===================================================================
-- A glossary term that names one thing of a class, such as the topic Masks, names that class as instance_of, and may
-- name the broader term of the same class it comes under as broader. An entity of a class that has such terms is one of
-- them, saved as the glossary writes it, and each term it comes under is saved with it. A file is tagged with a term
-- when one of its parts holds the term's entity: the graph reader gives a part the terms it names or is about as it
-- reads it, and fabrik_tag_file adds them to a file read before. Search follows a term's entity to the parts it came
-- from, and fabrik_get_tagged_files lists a term's files.

-- The glossary's terms that name one thing of a class, each with its class, the term it comes under, and its definition.
create or replace function fabrik_private.glossary_instances() returns table(term text, class text, broader text, definition text)
language sql stable set search_path=pg_catalog as $$
 select g.term, g.instance_of, g.broader, g.definition from fabrik.glossary_term g where g.instance_of is not null
$$;

-- The term of the class p_class that a name gives, by its term or one of its other names, in any case, as the glossary
-- writes it; or null.
create or replace function fabrik_private.instance_named(p_class text, p_name text) returns text
language sql stable set search_path=pg_catalog as $$
 select g.term from fabrik.glossary_term g
 where g.instance_of=p_class and (lower(g.term)=lower(btrim(p_name)) or lower(btrim(p_name)) in (select lower(o) from unnest(g.other_names) o))
 order by lower(g.term)=lower(btrim(p_name)) desc, g.term limit 1
$$;

-- The terms p_term comes under, the nearest first.
create or replace function fabrik_private.broader_terms(p_term text) returns setof text
language sql stable set search_path=pg_catalog as $$
 with recursive up(term, n) as (
  select g.broader, 1 from fabrik.glossary_term g where g.term=p_term and g.broader is not null
  union all
  select g.broader, u.n+1 from up u join fabrik.glossary_term g on g.term=u.term where g.broader is not null and u.n<100)
 select term from up order by n
$$;

-- p_term and the terms that come under it, at any depth.
create or replace function fabrik_private.narrower_terms(p_term text) returns setof text
language sql stable set search_path=pg_catalog as $$
 with recursive down(term, n) as (
  select p_term, 0
  union all
  select g.term, d.n+1 from down d join fabrik.glossary_term g on g.broader=d.term where d.n<100)
 select distinct term from down
$$;

-- Entities held to the glossary, with each term they name that comes under another followed by the terms it comes
-- under, where the list lacks them.
create or replace function fabrik_private.with_broader(p_entities jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare x jsonb; t text; ents jsonb:=p_entities; seen jsonb:='{}'::jsonb;
begin
 for x in select value from jsonb_array_elements(p_entities) loop
  seen:=seen||jsonb_build_object(file_search.graph_key(x->>'name'),true);
 end loop;
 for x in select value from jsonb_array_elements(p_entities) loop
  continue when not exists(select 1 from fabrik.glossary_term g where g.term=x->>'name' and g.instance_of=x->>'type');
  for t in select b from fabrik_private.broader_terms(x->>'name') b loop
   continue when seen ? file_search.graph_key(t);
   ents:=ents||jsonb_build_array(jsonb_build_object('name',t,'type',x->>'type','description',format('The part is about %s, which comes under %s.',x->>'name',t)));
   seen:=seen||jsonb_build_object(file_search.graph_key(t),true);
  end loop;
 end loop;
 return ents;
end $$;

-- A read's entities and relations fitted to the glossary, as fabrik_save_extraction holds a person's: each entity's type
-- is a class, written as the glossary writes it, and each relation names a relationship from an entity of its from
-- class to one of its to class, with the relationship's name among its keywords. An entity of a class that has terms
-- naming one thing of it is one of them, saved as the glossary writes it, with the terms it comes under. A finding that
-- fits none is dropped, with its reason, in place of refusing the part. Lists that are not lists are given back as they came.
create or replace function fabrik_private.fit_glossary(p_entities jsonb, p_relations jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare x jsonb; cls text; rel fabrik.glossary_term; types jsonb:='{}'::jsonb; src text; tgt text; term text;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb; dropped jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(coalesce(p_entities,'null'))<>'array' or jsonb_typeof(coalesce(p_relations,'null'))<>'array' then
  return jsonb_build_object('entities',p_entities,'relations',p_relations,'dropped','[]'::jsonb);
 end if;
 for x in select value from jsonb_array_elements(p_entities) loop
  cls:=(select g.term from fabrik.glossary_term g where g.kind='class' and lower(g.term)=lower(btrim(coalesce(x->>'type',''))));
  if cls is null then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','An entity''s type is not a class in the glossary','item',x));
   continue;
  end if;
  if exists(select 1 from fabrik.glossary_term g where g.instance_of=cls) then
   term:=fabrik_private.instance_named(cls,x->>'name');
   if term is null then
    dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','An entity is not one of its class''s terms in the glossary','item',x));
    continue;
   end if;
   x:=x||jsonb_build_object('name',term);
  end if;
  ents:=ents||jsonb_build_array(x||jsonb_build_object('type',cls));
 end loop;
 ents:=fabrik_private.with_broader(ents);
 -- A name given twice keeps its first class, as file search's trim keeps its first entity.
 for x in select value from jsonb_array_elements(ents) loop
  if not types ? file_search.graph_key(x->>'name') then types:=types||jsonb_build_object(file_search.graph_key(x->>'name'),x->>'type'); end if;
 end loop;
 for x in select value from jsonb_array_elements(p_relations) loop
  select g.* into rel from fabrik.glossary_term g where g.kind='relationship' and lower(g.term)=lower(btrim(coalesce(x->>'relationship','')));
  if rel.term is null then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','A relation names no relationship in the glossary','item',x));
   continue;
  end if;
  src:=types->>file_search.graph_key(x->>'source'); tgt:=types->>file_search.graph_key(x->>'target');
  if src is not null and tgt is not null and (src<>rel.from_class or tgt<>rel.to_class) then
   dropped:=dropped||jsonb_build_array(jsonb_build_object('reason','A relation''s ends are not the classes its relationship joins','item',x));
   continue;
  end if;
  rels:=rels||jsonb_build_array(x||jsonb_build_object('keywords',jsonb_build_array(rel.term)||case jsonb_typeof(x->'keywords') when 'array' then x->'keywords' else '[]'::jsonb end));
 end loop;
 return jsonb_build_object('entities',ents,'relations',rels,'dropped',dropped);
end $$;

-- A person's entities and relations held to the glossary, for fabrik_save_extraction and fabrik_add_extraction, and
-- refused at the first that does not fit: each entity's type is a glossary class, named in any case, and is saved as
-- the glossary names it; an entity of a class that has terms naming one thing of it is one of them, saved as the
-- glossary writes it, with the terms it comes under; each relation names a glossary relationship, as relationship,
-- from an entity of its from class to one of its to class, and keeps the relationship's name among its keywords.
-- p_known gives the class of each entity the chunk already holds, by its graph key, for a relation to name.
create or replace function fabrik_private.fit_extraction(p_entities jsonb, p_relations jsonb, p_known jsonb default '{}') returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare x jsonb; cls text; rel fabrik.glossary_term; types jsonb:=coalesce(p_known,'{}'::jsonb); src text; tgt text; term text;
 ents jsonb:='[]'::jsonb; rels jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(coalesce(p_entities,'[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_relations,'[]'::jsonb))<>'array' then
  raise exception 'Entities and relations are each a list' using errcode='22023';
 end if;
 for x in select value from jsonb_array_elements(coalesce(p_entities,'[]'::jsonb)) loop
  cls:=(select g.term from fabrik.glossary_term g where g.kind='class' and lower(g.term)=lower(btrim(coalesce(x->>'type',''))));
  if cls is null then
   raise exception 'The entity "%" has the type "%", which is not a class in the glossary. An entity''s type is one of the classes fabrik_get_unextracted lists',
    x->>'name',coalesce(x->>'type','') using errcode='23514';
  end if;
  if exists(select 1 from fabrik.glossary_term g where g.instance_of=cls) then
   term:=fabrik_private.instance_named(cls,x->>'name');
   if term is null then
    raise exception 'The % "%" is not one of the glossary''s terms of that class. An entity of the class is one of the terms fabrik_get_unextracted lists as instances',
     cls,x->>'name' using errcode='23514';
   end if;
   x:=x||jsonb_build_object('name',term);
  end if;
  ents:=ents||jsonb_build_array(x||jsonb_build_object('type',cls));
 end loop;
 ents:=fabrik_private.with_broader(ents);
 for x in select value from jsonb_array_elements(ents) loop
  types:=types||jsonb_build_object(file_search.graph_key(x->>'name'),x->>'type');
 end loop;
 for x in select value from jsonb_array_elements(coalesce(p_relations,'[]'::jsonb)) loop
  select g.* into rel from fabrik.glossary_term g where g.kind='relationship' and lower(g.term)=lower(btrim(coalesce(x->>'relationship','')));
  if rel.term is null then
   raise exception 'The relation from "%" to "%" names "%", which is not a relationship in the glossary. A relation names one of the relationships fabrik_get_unextracted lists',
    x->>'source',x->>'target',coalesce(x->>'relationship','') using errcode='23514';
  end if;
  src:=types->>file_search.graph_key(x->>'source'); tgt:=types->>file_search.graph_key(x->>'target');
  if src is not null and tgt is not null and (src<>rel.from_class or tgt<>rel.to_class) then
   raise exception 'The relationship "%" goes from a % to a %, and "%" is a % and "%" a %',rel.term,rel.from_class,rel.to_class,
    x->>'source',src,x->>'target',tgt using errcode='23514';
  end if;
  rels:=rels||jsonb_build_array(x||jsonb_build_object('keywords',jsonb_build_array(rel.term)||case jsonb_typeof(x->'keywords') when 'array' then x->'keywords'
   when 'string' then to_jsonb(string_to_array(x->>'keywords',',')) else '[]'::jsonb end));
 end loop;
 return jsonb_build_object('entities',ents,'relations',rels);
end $$;

revoke all on function fabrik_private.glossary_instances(), fabrik_private.instance_named(text,text), fabrik_private.broader_terms(text),
 fabrik_private.narrower_terms(text), fabrik_private.with_broader(jsonb), fabrik_private.fit_extraction(jsonb,jsonb,jsonb) from public, anon, authenticated;

-- The chunks of a scope's files whose graph no agent has saved yet, for the caller's agent to read and extract, with
-- the glossary's classes and relationships to extract them with, and its terms that name one thing of a class as
-- instances, each with its class, the term it comes under as broader, and its definition. Needs read in the scope.
-- Owned by postgres, which owns file search: the scope's bucket is checked here with fabrik's storage rules, and file
-- search lists its chunks.
create or replace function fabrik.fabrik_get_unextracted(p_scope text, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare sc fabrik.scope;
begin
 perform fabrik_private.read_actor();
 begin
  sc:=fabrik_private.named_scope(p_scope);
 exception when insufficient_privilege then sc:=null;
 end;
 if sc.code is null or sc.code not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
 end if;
 if to_regprocedure('file_search.unextracted(text,integer)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 return jsonb_build_object('scope',sc.display_name,'code',sc.code,
  'classes',(select coalesce(jsonb_agg(term order by lower(term)),'[]'::jsonb) from fabrik.glossary_term where kind='class'),
  'relationships',(select coalesce(jsonb_agg(jsonb_build_object('relationship',term,'from_class',from_class,'to_class',to_class) order by lower(term)),'[]'::jsonb)
   from fabrik.glossary_term where kind='relationship'),
  'instances',(select coalesce(jsonb_agg(jsonb_build_object('term',i.term,'class',i.class,'broader',i.broader,'definition',i.definition)
    order by lower(i.class), lower(i.term)),'[]'::jsonb) from fabrik_private.glossary_instances() i))||file_search.unextracted(sc.code,p_limit);
end $$;

-- fabrik_save_extraction, as section 8y holds it, with the glossary's terms of a class held by fit_extraction.
-- Saves the entities and relations the caller's agent read in one chunk, once. Needs read and create in the chunk's
-- scope. The entities and relations are held to the glossary by fit_extraction. Each entity merges by its normalised
-- name and type, and the save names the caller as the actor who saved it. With p_replace, the actor who saved the
-- chunk's extraction, or an administrator, replaces it, and a person with read and create in the scope replaces Graph
-- reader's.
create or replace function fabrik.fabrik_save_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb default '[]', p_replace boolean default false) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; b text; saver uuid; fitted jsonb;
begin
 a:=fabrik_private.current_actor();
 if to_regprocedure('file_search.save_extraction(uuid,jsonb,jsonb,uuid,text,boolean)') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 select v.bucket_id into b from file_search.chunk c join file_search.file_version v on v.version_id=c.version_id where c.chunk_id=p_chunk;
 if b is null or not exists(select 1 from fabrik.scope where code=b) or b not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Chunk unavailable: no chunk with the id "%" in a scope you may read',p_chunk using errcode='42501';
 end if;
 if b not in (select fabrik_storage.usable_buckets('create')) then
  raise exception 'Saving a chunk''s entities and relations needs create permission in its scope' using errcode='42501';
 end if;
 if coalesce(p_replace,false) then
  select x.saved_by into saver from file_search.chunk_extraction x where x.chunk_id=p_chunk;
  if saver is not null and saver<>a.actor_id and a.authority_class<>'administrator' and saver is distinct from fabrik_private.graph_reader_id() then
   raise exception 'Only the actor who saved this chunk''s entities and relations, or an administrator, may replace them: %',fabrik_private.actor_name(saver) using errcode='42501';
  end if;
 end if;
 fitted:=fabrik_private.fit_extraction(p_entities,p_relations);
 return file_search.save_extraction(p_chunk,fitted->'entities',fitted->'relations',a.actor_id,a.display_name,coalesce(p_replace,false));
end $$;

-- Adds entities and relations to a chunk whose entities and relations were saved before, and keeps what is there, as
-- a tag is added to a part already read. Needs read and create in the chunk's scope. The entities and relations are
-- held to the glossary by fit_extraction, and a relation may name an entity the chunk already holds. The entities the
-- chunk holds already are kept as they are. The additions are saved under the caller.
create or replace function fabrik.fabrik_add_extraction(p_chunk uuid, p_entities jsonb, p_relations jsonb default '[]') returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a fabrik.actor; b text; known jsonb; fitted jsonb;
begin
 a:=fabrik_private.current_actor();
 if to_regprocedure('file_search.add_extraction(uuid,jsonb,jsonb,uuid,text)') is null then
  raise exception 'File search cannot add to a part yet: apply file search''s upgrade 0009-add-extraction' using errcode='55000';
 end if;
 select v.bucket_id into b from file_search.chunk c join file_search.file_version v on v.version_id=c.version_id where c.chunk_id=p_chunk;
 if b is null or not exists(select 1 from fabrik.scope where code=b) or b not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Chunk unavailable: no chunk with the id "%" in a scope you may read',p_chunk using errcode='42501';
 end if;
 if b not in (select fabrik_storage.usable_buckets('create')) then
  raise exception 'Adding to a chunk''s entities and relations needs create permission in its scope' using errcode='42501';
 end if;
 if not exists(select 1 from file_search.chunk_extraction where chunk_id=p_chunk) then
  raise exception 'This part is not read for connections yet: save its entities and relations with fabrik_save_extraction first' using errcode='22023';
 end if;
 select coalesce(jsonb_object_agg(x.k,x.entity_type),'{}'::jsonb) into known from (
  select distinct on (file_search.graph_key(s.name)) file_search.graph_key(s.name) as k, s.entity_type
  from file_search.entity_source s where s.chunk_id=p_chunk order by file_search.graph_key(s.name), s.saved_at, s.entity_id) x;
 fitted:=fabrik_private.fit_extraction(p_entities,p_relations,known);
 return file_search.add_extraction(p_chunk,fitted->'entities',fitted->'relations',a.actor_id,a.display_name);
end $$;

-- Tags a file with glossary terms that each name one thing of a class, such as its topics, and keeps what its parts
-- hold. Each term, named by its term or one of its other names, is added to the file's first part as an entity of its
-- class, with each term it comes under. A tag the file has already is kept as it is. Needs read and create in the
-- scope, and the file's first part read for connections.
create or replace function fabrik.fabrik_tag_file(p_scope text, p_file text, p_terms text[]) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare sc fabrik.scope; given text; i record; tags text[]:='{}'; ents jsonb:='[]'::jsonb; f record; chunk uuid; t text;
begin
 perform fabrik_private.current_actor();
 begin
  sc:=fabrik_private.named_scope(p_scope);
 exception when insufficient_privilege then sc:=null;
 end;
 if sc.code is null or sc.code not in (select fabrik_storage.usable_buckets('read')) then
  raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
 end if;
 if sc.code not in (select fabrik_storage.usable_buckets('create')) then
  raise exception 'Tagging a file needs create permission in its scope' using errcode='42501';
 end if;
 if p_terms is null or cardinality(p_terms) not between 1 and 20 then
  raise exception 'Give 1 to 20 terms' using errcode='22023';
 end if;
 foreach given in array p_terms loop
  select g.term, g.instance_of into i from fabrik.glossary_term g
  where g.instance_of is not null and (lower(g.term)=lower(btrim(given)) or lower(btrim(given)) in (select lower(o) from unnest(g.other_names) o))
  order by lower(g.term)=lower(btrim(given)) desc, g.term limit 1;
  if i.term is null then
   raise exception 'No glossary term that names one thing of a class is called "%". get_reference''s glossary gives each term''s instance_of',given using errcode='22023';
  end if;
  if not i.term=any(tags) then
   tags:=tags||i.term;
   ents:=ents||jsonb_build_array(jsonb_build_object('name',i.term,'type',i.instance_of,'description',format('The file %s is about %s.',p_file,i.term)));
  end if;
 end loop;
 select v.version_id, v.state into f from storage.objects o join file_search.file_version v on v.object_id=o.id
 where o.bucket_id=sc.code and o.name=p_file and v.state not in ('retired','purged') order by v.queued_at desc limit 1;
 if f.version_id is null then
  raise exception 'No file "%" in the scope %',p_file,sc.display_name using errcode='22023';
 end if;
 if f.state<>'extracted' then
  raise exception 'fabrik is still preparing the file "%", or cannot read it (%): tag it once read_file gives its parts',p_file,f.state using errcode='22023';
 end if;
 select c.chunk_id into chunk from file_search.chunk c where c.version_id=f.version_id order by c.ordinal limit 1;
 if chunk is null or not exists(select 1 from file_search.chunk_extraction where chunk_id=chunk) then
  raise exception 'The first part of "%" is not read for connections yet: tag the file once it is',p_file using errcode='22023';
 end if;
 foreach t in array tags loop
  tags:=tags||array(select b from fabrik_private.broader_terms(t) b where not b=any(tags));
 end loop;
 return jsonb_build_object('scope',sc.display_name,'code',sc.code,'file',p_file,'tags',to_jsonb(tags))
  ||fabrik.fabrik_add_extraction(chunk,ents,'[]'::jsonb);
end $$;

-- With p_term, the files tagged with that term, or with a term that comes under it, in the scopes the caller may read,
-- or in p_scope alone: each with its scope and the terms of that class it is tagged with, by path, p_limit from p_from
-- on, with how many there are. Without p_term, each glossary term that names one thing of a class, with its class, the
-- term it comes under and how many of those files it tags.
create or replace function fabrik.fabrik_get_tagged_files(p_term text default null, p_scope text default null, p_from integer default 0, p_limit integer default 200) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare sc fabrik.scope; buckets text[]; i record; names text[]; result jsonb;
begin
 perform fabrik_private.read_actor();
 if p_limit is null or p_limit not between 1 and 1000 or p_from is null or p_from<0 then
  raise exception 'Limit must be 1 through 1000, and from 0 or more' using errcode='22023';
 end if;
 if p_scope is not null then
  begin
   sc:=fabrik_private.named_scope(p_scope);
  exception when insufficient_privilege then sc:=null;
  end;
  if sc.code is null or sc.code not in (select fabrik_storage.usable_buckets('read')) then
   raise exception 'Scope unavailable: no scope has the id, code or name "%"',p_scope using errcode='42501';
  end if;
  buckets:=array[sc.code];
 else
  buckets:=array(select fabrik_storage.usable_buckets('read'));
 end if;
 if to_regclass('file_search.entity_source') is null then
  raise exception 'File search''s graph is not set up yet: ask the administrator to run file-search.sql' using errcode='55000';
 end if;
 if p_term is null then
  select jsonb_build_object('terms',coalesce(jsonb_agg(jsonb_build_object('term',g.term,'class',g.class,'broader',g.broader,'files',
    (select count(distinct s.object_id) from file_search.entity e join file_search.entity_source s on s.entity_id=e.entity_id
      join file_search.chunk c on c.chunk_id=s.chunk_id join file_search.file_version v on v.version_id=c.version_id and v.state not in ('retired','purged')
      join storage.objects o on o.id=s.object_id
     where e.type_key=file_search.graph_key(g.class) and e.name_key=file_search.graph_key(g.term) and o.bucket_id=any(buckets)))
    order by lower(g.class), lower(coalesce(g.broader,g.term)), g.broader is not null, lower(g.term)),'[]'::jsonb))
  into result from fabrik_private.glossary_instances() g;
  return result;
 end if;
 select g.term, g.instance_of into i from fabrik.glossary_term g
 where g.instance_of is not null and (lower(g.term)=lower(btrim(p_term)) or lower(btrim(p_term)) in (select lower(o) from unnest(g.other_names) o))
 order by lower(g.term)=lower(btrim(p_term)) desc, g.term limit 1;
 if i.term is null then
  raise exception 'No glossary term that names one thing of a class is called "%". fabrik_get_tagged_files with no term lists them',p_term using errcode='22023';
 end if;
 names:=array(select file_search.graph_key(n) from fabrik_private.narrower_terms(i.term) n);
 with tagged as (
  select o.bucket_id, o.name, array_agg(distinct s.name order by s.name) as terms
  from file_search.entity e join file_search.entity_source s on s.entity_id=e.entity_id
  join file_search.chunk c on c.chunk_id=s.chunk_id join file_search.file_version v on v.version_id=c.version_id and v.state not in ('retired','purged')
  join storage.objects o on o.id=s.object_id
  where e.type_key=file_search.graph_key(i.instance_of) and e.name_key=any(names) and o.bucket_id=any(buckets)
  group by o.bucket_id, o.name)
 select jsonb_build_object('term',i.term,'class',i.instance_of,
  'narrower',(select coalesce(jsonb_agg(n order by lower(n)),'[]'::jsonb) from fabrik_private.narrower_terms(i.term) n where n<>i.term),
  'total',(select count(*) from tagged),
  'files',coalesce((select jsonb_agg(jsonb_build_object('scope',x.display_name,'code',x.bucket_id,'file',x.name,'terms',to_jsonb(x.terms)) order by x.bucket_id, x.name)
   from (select g.*, s.display_name from tagged g join fabrik.scope s on s.code=g.bucket_id order by g.bucket_id, g.name offset p_from limit p_limit) x),'[]'::jsonb))
 into result;
 return result;
end $$;

revoke all on function fabrik.fabrik_add_extraction(uuid,jsonb,jsonb), fabrik.fabrik_tag_file(text,text,text[]),
 fabrik.fabrik_get_tagged_files(text,text,integer,integer) from public, anon;
grant execute on function fabrik.fabrik_add_extraction(uuid,jsonb,jsonb), fabrik.fabrik_tag_file(text,text,text[]),
 fabrik.fabrik_get_tagged_files(text,text,integer,integer) to authenticated;
notify pgrst, 'reload schema';

insert into fabrik_private.schema_upgrade(id) values ('0017-glossary-tags') on conflict (id) do nothing;
