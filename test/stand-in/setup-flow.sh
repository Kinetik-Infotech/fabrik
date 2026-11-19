#!/bin/sh
# fabrik's setup on a cluster of its own: fabrik's roles belong to a cluster, and setup-flow.ts builds fabrik, resets it
# and builds it again, then runs fabrik setup --owner on a new project. Three new databases with supabase.sql's parts,
# where pg_cron and pg_net, which Supabase provides, are named in the catalogue, so schedule.sql's create extension if
# not exists finds them, and supabase.sql's cron and net schemas stand in for them. Run by run.sh.
set -u
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PG=${PG_BIN:-/usr/local/opt/postgresql@17/bin}
DENO=${DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}
HERE=$(cd "$(dirname "$0")" && pwd)
PORT=${SETUP_FLOW_PORT:-$(( ${PORT:-54329} + 2 ))}
WORK=$(mktemp -d)
trap '"$PG/pg_ctl" -D "$WORK/data" stop -m immediate >/dev/null 2>&1; rm -rf "$WORK"' EXIT
"$PG/initdb" -D "$WORK/data" -U supabase_admin -A trust --lc-messages=C >/dev/null || exit 1
"$PG/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -h 127.0.0.1" -l "$WORK/log" -w start >/dev/null || exit 1
admin() { "$PG/psql" -h "$WORK" -p "$PORT" -U supabase_admin -q -v ON_ERROR_STOP=1 "$@"; }
"$PG/createdb" -h "$WORK" -p "$PORT" -U supabase_admin fabrik || exit 1
admin -d fabrik -f "$HERE/supabase.sql" || exit 1
for db in flow partly owner; do
  "$PG/createdb" -h "$WORK" -p "$PORT" -U supabase_admin -T fabrik "$db" || exit 1
  admin -d "$db" -c "grant create on database $db to postgres;" -c "set allow_system_table_mods = on;
    insert into pg_extension(oid, extname, extowner, extnamespace, extrelocatable, extversion) values
    (990001, 'pg_cron', 10, 'cron'::regnamespace, false, 'stand-in'), (990002, 'pg_net', 10, 'net'::regnamespace, false, 'stand-in');" || exit 1
done
[ -x "$DENO" ] || { echo "Deno is not installed"; exit 1; }
STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/flow" STAND_IN_PARTLY_DB="postgres://postgres@127.0.0.1:$PORT/partly" \
  STAND_IN_OWNER_DB="postgres://postgres@127.0.0.1:$PORT/owner" \
  STAND_IN_ADMIN_DB="postgres://supabase_admin@127.0.0.1:$PORT/fabrik" "$DENO" run --quiet --no-lock \
  --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys --allow-import "$HERE/setup-flow.ts"
