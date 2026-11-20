#!/bin/sh
# Each upgrade must bring a project built before it to the same schema as a new build. For fabrik's
# upgrades and file search's alike: for each file, build its base, the build file at the commit
# its header names, or the current build file for a base of "new", apply it and every later
# upgrade twice, and compare the schemas with a new build of the current file. A new build must list
# every upgrade in its ledger. Run by run.sh.
set -u
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PG=${PG_BIN:-/usr/local/opt/postgresql@17/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PORT=${UPGRADE_PORT:-54339}

# The catalogue of the given schemas ($1, a quoted SQL list) and the ledger ($2): the schemas'
# privileges; functions with their source, settings, owner, grants and comment; relations with
# their owner, row-level security, grants and comment; columns, constraints, indexes, policies,
# triggers; and the ledger's ids.
signature_sql() {
  cat <<SQL
select 'schema '||n.nspname||' owner='||pg_get_userbyid(n.nspowner)
 ||' acl='||coalesce((select string_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end||':'||a.privilege_type,',' order by 1) from aclexplode(n.nspacl) a),'default')
 ||' comment='||coalesce(obj_description(n.oid,'pg_namespace'),'')
from pg_namespace n where n.nspname in ($1)
union all
select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') owner='||pg_get_userbyid(p.proowner)
 ||' src='||md5(p.prosrc)||' cfg='||coalesce(array_to_string(p.proconfig,','),'')||' secdef='||p.prosecdef||' vol='||p.provolatile::text
 ||' acl='||coalesce((select string_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end||':'||a.privilege_type,',' order by 1) from aclexplode(p.proacl) a),'default')
 ||' comment='||coalesce(obj_description(p.oid,'pg_proc'),'')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ($1)
union all
select 'rel '||n.nspname||'.'||c.relname||' kind='||c.relkind::text||' owner='||pg_get_userbyid(c.relowner)||' rls='||c.relrowsecurity
 ||' acl='||coalesce((select string_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end||':'||a.privilege_type,',' order by 1) from aclexplode(c.relacl) a),'default')
 ||' comment='||coalesce(obj_description(c.oid,'pg_class'),'')
from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ($1) and c.relkind in ('r','v','S','m')
union all
select 'col '||table_schema||'.'||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' def='||coalesce(column_default,'')
from information_schema.columns where table_schema in ($1)
union all
select 'con '||c.conrelid::regclass||'.'||c.conname||' '||pg_get_constraintdef(c.oid)
from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ($1)
union all
select 'idx '||schemaname||'.'||indexname||' '||indexdef from pg_indexes where schemaname in ($1)
union all
select 'pol '||schemaname||'.'||tablename||'.'||policyname||' '||cmd||' '||array_to_string(roles,',')||' q='||coalesce(qual,'')||' c='||coalesce(with_check,'')
from pg_policies where schemaname in ($1) or schemaname='storage'
union all
select 'trg '||t.tgrelid::regclass||'.'||t.tgname||' '||t.tgfoid::regprocedure from pg_trigger t where not t.tgisinternal
union all
select 'ledger '||id from $2
order by 1
SQL
}

# Starts a throwaway cluster standing in for a new Supabase project.
start() {
  DIR=$(mktemp -d)
  "$PG/initdb" -D "$DIR/data" -U supabase_admin -A trust --lc-messages=C >/dev/null || exit 1
  "$PG/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -h 127.0.0.1" -l "$DIR/log" -w start >/dev/null || exit 1
  "$PG/createdb" -h "$DIR" -p "$PORT" -U supabase_admin fabrik || exit 1
  "$PG/psql" -h "$DIR" -p "$PORT" -d fabrik -U supabase_admin -q -v ON_ERROR_STOP=1 -f "$HERE/supabase.sql" >/dev/null || exit 1
}
stop() { "$PG/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1; rm -rf "$DIR"; }
run() {
  "$PG/psql" -h "$DIR" -p "$PORT" -d fabrik -U postgres -q -v ON_ERROR_STOP=1 -1 -f "$1" >"$DIR/out" 2>&1 \
    || { echo "FAIL $2"; grep -v NOTICE "$DIR/out"; stop; exit 1; }
}
signature() { signature_sql "$1" "$2" | "$PG/psql" -h "$DIR" -p "$PORT" -d fabrik -U postgres -tA -f - > "$3"; }
# The upgrade's number, from the first four characters of its file name.
number() { basename "$1" | cut -c1-4; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# check <label> <upgrades folder> <build file> <schemas> <ledger> <build file's earlier paths...>, the
# paths relative to ROOT. A base commit that has no build file at its path has it at an earlier path.
check() {
  label=$1; folder=$ROOT/$2; build=$3; schemas=$4; ledger=$5; shift 5; earlier=$*
  files=$(ls "$folder"/[0-9][0-9][0-9][0-9]-*.sql 2>/dev/null)
  start
  run "$ROOT/$build" "the current $(basename "$build") does not build"
  signature "$schemas" "$ledger" "$OUT/new"
  stop
  if [ -z "$files" ]; then echo "ok - $label has no upgrades yet, and a new build builds"; return; fi
  for file in $files; do
    grep -qx "ledger $(basename "$file" .sql)" "$OUT/new" || { echo "FAIL a new build does not list $(basename "$file" .sql) in its ledger"; exit 1; }
  done
  echo "ok - a new build lists every $label upgrade in its ledger"
  for file in $files; do
    id=$(basename "$file" .sql)
    base=$(sed -n 's/^-- base: //p' "$file" | head -1)
    [ -n "$base" ] || { echo "FAIL $id names no base"; exit 1; }
    found=
    if [ "$base" = new ]; then
      cp "$ROOT/$build" "$OUT/base.sql" && found=$build
    else
      for path in $build $earlier; do
        git -C "$ROOT" show "$base:$path" > "$OUT/base.sql" 2>/dev/null && { found=$path; break; }
      done
    fi
    [ -n "$found" ] || { echo "FAIL $id's base $base is not in this repository"; exit 1; }
    start
    run "$OUT/base.sql" "$id's base does not build"
    for pass in first second; do
      for later in $files; do
        [ "$(number "$later")" -lt "$(number "$file")" ] && continue
        run "$later" "$(basename "$later" .sql) did not apply the $pass time over $id's base"
      done
    done
    signature "$schemas" "$ledger" "$OUT/upgraded"
    stop
    if ! diff "$OUT/new" "$OUT/upgraded" > "$OUT/diff"; then
      echo "FAIL a project upgraded from $id's base differs from a new build:"; cat "$OUT/diff"; exit 1
    fi
    if [ "$base" = new ]; then echo "ok - $id, applied twice over a new build, matches a new build"
    else echo "ok - $id, applied twice over its base, matches a new build"; fi
  done
}

FABRIK=setup
check fabrik $FABRIK/upgrades $FABRIK/setup.sql \
  "'fabrik','fabrik_private','fabrik_storage','fabrik_task'" fabrik_private.schema_upgrade
check "file search" $FABRIK/file-search-upgrades $FABRIK/file-search.sql \
  "'file_search'" file_search.schema_upgrade

# Upgrade 0014 over a project whose chat box answered visitors: the agent chat takes the settings' model and cap and
# the day's tokens, and the settings lose both. Over a project that never used the chat box, it makes no agent.
agent_check() {
  git -C "$ROOT" show "682e03d:setup/setup.sql" > "$OUT/base.sql" || { echo "FAIL 0014's base is not in this repository"; exit 1; }
  start
  run "$OUT/base.sql" "0014's base does not build"
  echo "update fabrik_private.public_agent_setting set model = 'claude-sonnet-5-5', daily_cap_tokens = 7000;
    insert into fabrik_private.public_agent_usage(day, tokens) values ('2026-11-19', 1234);
    insert into storage.objects(bucket_id, name) values ('public-agent', 'KNOWLEDGE.md');" > "$OUT/used.sql"
  run "$OUT/used.sql" "the base's public agent settings could not be set"
  run "$ROOT/setup/upgrades/0014-public-agents.sql" "0014 did not apply over a used chat box"
  run "$ROOT/setup/upgrades/0014-public-agents.sql" "0014 did not apply twice over a used chat box"
  got=$("$PG/psql" -h "$DIR" -p "$PORT" -d fabrik -U postgres -tA -c "select string_agg(a.slug||' '||a.name||' '||a.model||' '||a.daily_cap_tokens||' '||u.slug||' '||u.tokens, ';')
    from fabrik_private.public_agent a join fabrik_private.public_agent_usage u on u.slug = a.slug")
  stop
  [ "$got" = "chat Chat claude-sonnet-5-5 7000 chat 1234" ] \
    || { echo "FAIL 0014 over a used chat box gives the agents and tokens: $got"; exit 1; }
  echo "ok - 0014 over a used chat box makes the agent chat, with the settings' model and cap and the day's tokens"
  start
  run "$OUT/base.sql" "0014's base does not build"
  run "$ROOT/setup/upgrades/0014-public-agents.sql" "0014 did not apply over an unused chat box"
  got=$("$PG/psql" -h "$DIR" -p "$PORT" -d fabrik -U postgres -tA -c "select count(*) from fabrik_private.public_agent")
  stop
  [ "$got" = 0 ] || { echo "FAIL 0014 over a chat box never used makes $got agents"; exit 1; }
  echo "ok - 0014 over a chat box never used makes no agent"
}
agent_check
