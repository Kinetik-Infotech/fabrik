#!/bin/sh
# Build a throwaway PostgreSQL 17 cluster standing in for a new Supabase project: fabrik's setup.sql,
# file-search.sql and file-search-scopes.sql, as the setup skill runs them, then analyze it, as a project
# that holds data has its tables' statistics. Then each step runs on its own copy of that build, made with
# createdb -T, side by side with the others. Each step's output is kept apart and printed in order once all
# have ended. Exits 1 if any step fails. Needs PostgreSQL 17, pgvector, Deno, python3 and openssl, e.g.
# `brew install postgresql@17 pgvector` and Deno's own installer.
#
#   sh run.sh                 every step
#   sh run.sh <step> ...      the build, then the named steps only
#   sh run.sh --list          the steps' names
#
# PG_BIN and DENO override where PostgreSQL's programs and Deno are. DRAWING overrides where the
# graph and board skills' scripts are, which the drawing checks run.
set -u
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PG=${PG_BIN:-/usr/local/opt/postgresql@17/bin}
DENO=${DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SETUP=$HERE/../../setup
SEARCH=$SETUP
# The fabrik plugin's skills, whose graph and board scripts draw what the database returns.
DRAWING=${DRAWING:-$HERE/../../plugins/fabrik/skills}

STEPS="versions claim-once stored-checks saves-side-by-side work-requests permission-times drawings file-search upgrades setup-flow maxy-import fabrik-apps routines mail public-agent"
if [ "${1:-}" = --list ]; then printf '%s\n' $STEPS; exit 0; fi
for name in "$@"; do
  case " $STEPS " in *" $name "*) ;; *) echo "FAIL $name is not a step. sh run.sh --list names them."; exit 2 ;; esac
done
if [ $# -gt 0 ]; then NAMED=" $* "; else NAMED=" $STEPS "; fi
[ -x "$DENO" ] || { echo "Deno is not installed"; exit 1; }

WORK=$(mktemp -d)
SOCK=$WORK
OUT=$WORK/parts
mkdir -p "$OUT"
PORT=${PORT:-54329}
trap '"$PG/pg_ctl" -D "$SOCK/data" stop -m immediate >/dev/null 2>&1; rm -rf "$SOCK"' EXIT
"$PG/initdb" -D "$WORK/data" -U supabase_admin -A trust --lc-messages=C >/dev/null || exit 1
"$PG/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -h 127.0.0.1" -l "$WORK/log" -w start >/dev/null || exit 1
"$PG/createdb" -h "$SOCK" -p "$PORT" -U supabase_admin fabrik || exit 1
DB=fabrik
psql() { "$PG/psql" -h "$SOCK" -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

# A step runs in the background on its own copy of the build, with its own work folder, and its output kept apart.
ORDER=""
start() {
  case "$NAMED" in *" $1 "*) ;; *) return ;; esac
  "$PG/createdb" -h "$SOCK" -p "$PORT" -U supabase_admin -T fabrik "$(echo "$1" | tr - _)" || exit 1
  # A database's grants are not copied with it: supabase.sql's grant to postgres, made again.
  "$PG/psql" -h "$SOCK" -p "$PORT" -d fabrik -U supabase_admin -q -c "grant create on database $(echo "$1" | tr - _) to postgres;" || exit 1
  ( WORK=$WORK/$1; DB=$(echo "$1" | tr - _); mkdir -p "$WORK"; began=$(date +%s); "step_$(echo "$1" | tr - _)"; status=$?
    echo "-- $1: $(( $(date +%s) - began )) s"; exit $status ) >"$OUT/$1.out" 2>&1 &
  echo "$!" >"$OUT/$1.pid"; ORDER="$ORDER $1"
}
# Waits for every step, prints each one's output in order, and exits 1 if any failed.
finish() {
  failed=""
  for name in $ORDER; do
    wait "$(cat "$OUT/$name.pid")"; status=$?
    cat "$OUT/$name.out"
    [ "$status" -eq 0 ] || failed="$failed $name"
  done
  if [ -n "$failed" ]; then echo "FAIL steps:$failed"; exit 1; fi
  echo "PASS: every step passed:$ORDER"
}

# A file that builds something must run without error.
build() {
  echo "== $(basename "$1")"
  if ! psql -U postgres -q -1 -f "$1" >"$WORK/out" 2>&1; then grep -v NOTICE "$WORK/out"; exit 1; fi
}
# A file of stored checks is installed, then its function is called; it passed only if the call
# ends in its PASS error.
stored() {
  build "$1"
  echo "== $2"
  psql -U postgres -c '\timing on' -c "set local statement_timeout = '120s'; select $2;" >"$WORK/out" 2>&1
  grep -E "ERROR|FAIL|PASS|^Time" "$WORK/out" | tail -3
  grep -q "ERROR:  $3" "$WORK/out" || exit 1
  # A client role may not run the checks.
  psql -U postgres -c "set role authenticated; select $2;" >"$WORK/out" 2>&1
  grep -q "permission denied" "$WORK/out" || { echo "FAIL authenticated may run $2"; cat "$WORK/out"; exit 1; }
}

# A checks file carries its own version, in its first line and in its run function's comment, and
# a .sha256 file beside it, named for it, records that version and the hash of the rest of the file.
# The version must rise with every change to the checks and at no other time, measured against
# origin/main.
checks() {
  file=$1; name=$2; dir=$(cd "$(dirname "$file")" && pwd); record=$dir/$(basename "$file" .sql).sha256
  version=$(head -1 "$file" | sed -n "s/^-- $name //p")
  [ -n "$version" ] && grep -q "is '$name $version';" "$file" \
    || { echo "FAIL $(basename "$file"): its first line and its comment do not carry the same mark"; exit 1; }
  hash=$(sed '1d' "$file" | grep -v "is '$name $version';\$" | shasum -a 256 | cut -d' ' -f1)
  [ "$(cat "$record" 2>/dev/null)" = "$version $hash" ] \
    || { echo "FAIL $(basename "$file"): $(basename "$record") should hold \"$version $hash\""; exit 1; }
  path=${record#"$ROOT"/}
  # A repository with no origin, or an origin/main without this record, has nothing to compare with.
  if ! git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
    echo "ok - $(basename "$file") $version, new: this repository has no origin to compare with"; return
  fi
  if ! git -C "$ROOT" cat-file -e "origin/main:$path" 2>/dev/null; then
    echo "ok - $(basename "$file") $version, $path is new to origin/main"; return
  fi
  main=$(git -C "$ROOT" show "origin/main:$path")
  main_version=${main% *}; main_hash=${main#* }
  commit=$(git -C "$ROOT" rev-parse --short origin/main)
  if [ "$hash" != "$main_hash" ] && [ "$version" = "$main_version" ]; then
    echo "FAIL $(basename "$file"): the checks changed, so raise their version (compared with origin/main at $commit)"; exit 1
  fi
  if [ "$hash" = "$main_hash" ] && [ "$version" != "$main_version" ]; then
    echo "FAIL $(basename "$file"): the version rose with no change to the checks (compared with origin/main at $commit)"; exit 1
  fi
  echo "ok - $(basename "$file") $version, checked against origin/main at $commit"
}

# Each step proves one of fabrik's rules, named in its first comment.

# The stored checks' version rises with every change to them and at no other time, and the worker deploys its
# vendored SheetJS with it.
step_versions() {
  echo "== versions"
  checks "$SETUP/tests.sql" fabrik_tests
  checks "$SEARCH/file-search-tests.sql" "file_search checks"
  # Each vendored library in the worker matches the checksums recorded beside it, and those checksums match
  # origin/main's for the same folder. A new version of a library goes in a new folder, so changing the
  # files of a folder already on origin/main always fails.
  for sums in "$SETUP"/functions/file-search-worker/vendor/*/SHA256SUMS; do
    dir=$(dirname "$sums"); name=$(basename "$dir"); path=${sums#"$ROOT"/}
    ( cd "$dir" && shasum -a 256 -c --quiet SHA256SUMS ) || { echo "FAIL vendor/$name does not match its SHA256SUMS"; exit 1; }
    if git -C "$ROOT" cat-file -e "origin/main:$path" 2>/dev/null \
      && [ "$(git -C "$ROOT" show "origin/main:$path")" != "$(cat "$sums")" ]; then
      echo "FAIL vendor/$name's SHA256SUMS differs from origin/main's; a new version of a library goes in a new folder"; exit 1
    fi
    echo "ok - vendor/$name matches its SHA256SUMS, as on origin/main"
  done
  # The worker imports SheetJS from its own vendor folder, which setup deploys with it, and from no web address.
  worker=$SETUP/functions/file-search-worker
  for file in xlsx.mjs types/index.d.ts; do
    grep -q "\"./vendor/sheetjs-0.20.3/$file\"" "$worker/text.ts" \
      || { echo "FAIL text.ts does not import $file from its vendor folder"; exit 1; }
    grep -q "\"vendor/sheetjs-0.20.3/$file\"" "$SETUP/build.mjs" \
      || { echo "FAIL build.mjs does not deploy vendor/sheetjs-0.20.3/$file with file-search-worker"; exit 1; }
  done
  if grep -n "https://" "$worker/text.ts" | grep -v "npm:"; then echo "FAIL text.ts imports from a web address"; exit 1; fi
  echo "ok - text.ts imports sheetjs-0.20.3 from its vendor folder, and build.mjs deploys both files with the worker"
  # Every upgrade signed beside it, and the plugin's version raised with any change it ships.
  node "$HERE/release.mjs" "$ROOT" || exit 1
}

# A file-search claim takes at most the rows it asks for, under the plan dead rows and stale statistics bring,
# and two claims never take one row. It ends in a PASS notice, and a failure stops psql.
step_claim_once() {
  echo "== claim-once.sql"
  psql -U supabase_admin -q -v budget_upgrade="$ROOT/setup/file-search-upgrades/0005-worker-budget.sql" -f "$HERE/claim-once.sql" >"$WORK/out" 2>&1
  status=$?
  grep -oE "(ok - |PASS: |FAIL: ).*" "$WORK/out"
  [ "$status" -eq 0 ] && grep -q "PASS: claim-once" "$WORK/out" || { cat "$WORK/out"; exit 1; }
}

# File search's and fabrik's stored checks pass as a project's SQL Editor runs them: each of fabrik's parts
# within the editor's limit, no client role may run them, and a run refuses at once beside another.
step_stored_checks() {
  stored "$SEARCH/file-search-tests.sql" "file_search.run_checks()" "PASS: file search checks passed"
  stored "$SETUP/tests.sql" "fabrik_tests.run(1)" "PASS: part 1 of"
  parts=$(psql -U postgres -tA -c "select fabrik_tests.parts()->>'parts';") || exit 1
  part=2
  while [ "$part" -le "$parts" ]; do
    echo "== fabrik_tests.run($part)"
    psql -U postgres -c '\timing on' -c "set local statement_timeout = '45s'; select fabrik_tests.run($part);" >"$WORK/out" 2>&1
    grep -E "ERROR|^Time" "$WORK/out" | tail -2
    grep -q "ERROR:  PASS: part $part of $parts passed" "$WORK/out" || exit 1
    part=$((part+1))
  done
  # While another run of the checks holds their lock, a run refuses at once rather than waiting.
  psql -U postgres -c "select pg_advisory_lock(19483,31001), pg_sleep(3);" >/dev/null 2>&1 &
  sleep 1
  psql -U postgres -c "select fabrik_tests.run(1);" >"$WORK/out" 2>&1
  grep -q "is in progress" "$WORK/out" || { echo "FAIL a run did not refuse beside another run"; cat "$WORK/out"; exit 1; }
  wait
  echo "ok - a run refuses at once while another run of the checks is under way"
}

# Saves side by side keep one record whole: no global write lock, a record held while saved, a second save of
# the same version refused, no loop of parents, and READ COMMITTED alone.
step_saves_side_by_side() {
echo "== saves side by side"
side() { "$PG/psql" -h "$SOCK" -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"; }
side -U supabase_admin -q -c "create schema side authorization postgres;" || exit 1
side -U postgres -q -f "$HERE/side-by-side.sql" >"$WORK/out" 2>&1 || { cat "$WORK/out"; exit 1; }
agent="select set_config('request.jwt.claims',(select v::text from side.fixture where k='claims'),false); set role authenticated;"
# A save goes through while another session holds the lock every write once took.
side -U postgres -c "select pg_advisory_lock(19483,31001), pg_sleep(4);" >/dev/null 2>&1 &
sleep 1
side -U postgres -c "$agent" -c "set statement_timeout='2s';" -c "select side.save('Beside the old lock')->>'version_number';" >"$WORK/out" 2>&1
wait
grep -qx " 2" "$WORK/out" || { echo "FAIL a save waited for the old write lock"; cat "$WORK/out"; exit 1; }
echo "ok - a save goes through while another session holds the lock every write once took"
# While a save is under way, its record is held: a deletion or a move waits for it.
side -U postgres -c "$agent" -c "begin; select side.save('Held open'); select pg_sleep(4); rollback;" >/dev/null 2>&1 &
sleep 1
side -U postgres -c "set lock_timeout='1s'; select 1 from fabrik.record where record_id=(select (v->>'record_id')::uuid from side.fixture where k='request') for update;" >"$WORK/out" 2>&1
wait
grep -q "55P03" "$WORK/out" || { echo "FAIL a save under way does not hold its record"; cat "$WORK/out"; exit 1; }
echo "ok - a save under way holds its record, so a deletion or a move waits for it"
# Two saves of one record from the same version: the first is kept and the second is refused.
side -U postgres -c "$agent" -c "begin; select side.save('First of two'); select pg_sleep(3); commit;" >"$WORK/first" 2>&1 &
sleep 1
side -U postgres -c "$agent" -c "select side.save('Second of two');" >"$WORK/out" 2>&1
wait
grep -q "ERROR:  40001: This record was changed by another save. Read it again, then save again." "$WORK/out" \
  || { echo "FAIL the second of two saves at once was not refused"; cat "$WORK/out"; exit 1; }
grep -q "COMMIT" "$WORK/first" || { echo "FAIL the first of two saves at once was not kept"; cat "$WORK/first"; exit 1; }
echo "ok - of two saves of one record at once, the first is kept and the second is refused with 40001"
# A save that has checked its version and waits, while another save of the same record from that version
# is kept, is refused once it goes on. waited_save holds the lock $1 in a third session until side.go has
# its row, starts the save $3 of the fixture's $2, which waits for that lock, and saves $2 beside it.
waiton() { side -U postgres -q -c "do \$w\$ declare t timestamptz:=clock_timestamp(); begin while not ($1) loop
  if clock_timestamp()-t>interval '20 s' then raise exception 'FAIL $2'; end if; perform pg_sleep(0.02); perform pg_stat_clear_snapshot(); end loop; end \$w\$;"; }
waited_save() {
  PGAPPNAME=stand-in-hold side -U postgres -v ON_ERROR_STOP=1 -c "select pg_advisory_lock(19483,$1);" \
    -c "do \$w\$ begin while not exists(select 1 from side.go where k='$1') loop perform pg_sleep(0.02); end loop; end \$w\$;" >"$WORK/hold" 2>&1 &
  hold=$!
  waiton "exists(select 1 from pg_locks where locktype='advisory' and classid=19483 and objid=$1 and granted)" "the hold never took lock $1" || exit 1
  side -U postgres -c "$agent" -c "select $3;" >"$WORK/out" 2>&1 &
  waiting=$!
  waiton "exists(select 1 from pg_stat_activity a, pg_stat_activity h where h.application_name='stand-in-hold' and h.pid=any(pg_blocking_pids(a.pid)))" "the save never waited for lock $1" || exit 1
  side -U postgres -c "$agent" -c "select side.save('Kept while the other waits','$2')->>'version_number';" >"$WORK/first" 2>&1
  side -U postgres -q -c "insert into side.go values('$1');"
  wait $waiting
  wait $hold || { echo "FAIL the hold on lock $1 failed"; cat "$WORK/hold"; exit 1; }
  grep -qx " 2" "$WORK/first" || { echo "FAIL the save beside a save waiting for lock $1 was not kept"; cat "$WORK/first"; exit 1; }
  grep -q "ERROR:  40001: This record was changed by another save. Read it again, then save again." "$WORK/out" \
    || { echo "FAIL a save that waited for lock $1 after its version check was kept over the save before it"; cat "$WORK/out"; exit 1; }
}
# 31002 is the lock a save that adds a parent takes; 31003 the lock a save that changes an activity's finish takes.
waited_save 31002 plan1 "side.save_parent('plan1','plan2')"
waited_save 31003 plan2 "side.save('Later finish','plan2','{\"forecast_finish_at\":\"2026-10-19T17:00:00Z\"}')"
echo "ok - a save that has checked its version and waits, for the parent lock or the finish lock, is refused with 40001 once another save of the record is kept"
# Two saves at once that make two plans each other's parent: the first is kept, and the second is
# refused as a loop.
side -U postgres -c "$agent" -c "begin; select side.save_parent('plan1','plan2'); select pg_sleep(3); commit;" >"$WORK/first" 2>&1 &
sleep 1
side -U postgres -c "$agent" -c "select side.save_parent('plan2','plan1');" >"$WORK/out" 2>&1
wait
grep -q "COMMIT" "$WORK/first" || { echo "FAIL the first of two parent links at once was not kept"; cat "$WORK/first"; exit 1; }
grep -q "ERROR:  23514: Circular activity relationship" "$WORK/out" \
  || { echo "FAIL two saves at once closed a loop of parents"; cat "$WORK/out"; exit 1; }
echo "ok - of two saves at once that make two plans each other's parent, the first is kept and the second is refused as a loop"
# A write under REPEATABLE READ is refused.
side -U postgres -c "$agent" -c "begin isolation level repeatable read; select fabrik.fabrik_save_version((select v from side.fixture where k='request'),(select (v#>>'{}')::uuid from side.fixture where k='grant')); commit;" >"$WORK/out" 2>&1
grep -q "ERROR:  25001: fabrik writes require READ COMMITTED" "$WORK/out" || { echo "FAIL a write under REPEATABLE READ was not refused"; cat "$WORK/out"; exit 1; }
echo "ok - a write under REPEATABLE READ is refused with 25001"
}

# The records skill's requests save as an agent under a grant; link relations are a governed list; and each
# read and save checks a restricted person's records as a set.
step_work_requests() {
# The records skill's requests, from its field lists, saved as an agent under a grant.
echo "== work-requests.sql"
psql -U postgres -f "$HERE/work-requests.sql" >"$WORK/out" 2>&1
grep -E "ERROR|FAIL|PASS" "$WORK/out" | tail -1
grep -q "ERROR:  PASS: work requests" "$WORK/out" || exit 1
# The governed list of link relations: seeds, an unknown relation refused, a saved one used, an agent refused.
echo "== relation-types.sql"
psql -U postgres -f "$HERE/relation-types.sql" >"$WORK/out" 2>&1
grep -E "ERROR|FAIL|PASS" "$WORK/out" | tail -1
grep -q "ERROR:  PASS: relation types" "$WORK/out" || { cat "$WORK/out"; exit 1; }
# A restricted person's permission checks, counted: each read and save checks its records as a set.
echo "== permission-checks.sql"
psql -U supabase_admin -q -c "grant set on parameter track_functions to postgres;" || exit 1
psql -U postgres -f "$HERE/permission-checks.sql" >"$WORK/out" 2>&1
grep -E "ERROR|FAIL|PASS" "$WORK/out" | tail -1
grep -q "ERROR:  PASS: permission checks" "$WORK/out" || exit 1
}

# Each read and save of a restricted person on a 1,000-record project finishes within 200 ms, and a day's
# audit log within 1 second.
step_permission_times() {
# Permission checks timed for a restricted person on a project of a known size, 1,000 records.
echo "== permission-times.sql"
psql -U postgres -f "$HERE/permission-times.sql" >"$WORK/out" 2>&1
grep -E "ERROR|FAIL|PASS" "$WORK/out" | tail -1
grep -q "ERROR:  PASS: permission times" "$WORK/out" || exit 1
}

# The graph, board and print skills draw what the real functions return: a state machine page round trip, a
# plan's progress board, a model board, one plan model as board and graph, the glossary, data dictionary and
# SOP pages, and the records skill's finish order.
step_drawings() {
# The graph skill's round trip through the real functions: page to payload, saved with
# fabrik_save_version, read back with fabrik_get_record, and drawn again; the two data blocks must match.
echo "== state machine page"
MACHINE=$DRAWING/graph
BOARD=$DRAWING/board/board_page.py
GRAPH=$DRAWING/graph/plan_graph.py
DRAW=yes
for f in "$MACHINE/page_to_model.py" "$MACHINE/model_to_page.py" "$BOARD" "$GRAPH"; do [ -f "$f" ] || DRAW=; done
if [ -z "$DRAW" ]; then
  echo "not run - the graph and board skills' scripts are not at $DRAWING, so no page or board is drawn; set DRAWING to the skills folder that holds them"
else
python3 "$MACHINE/page_to_model.py" "$HERE/state-machine-page.html" "$WORK/payload.json" >/dev/null || exit 1
psql -U postgres -q -v payload="$(cat "$WORK/payload.json")" -v result_file="$WORK/record.json" -f "$HERE/state-machine.sql" >"$WORK/out" 2>&1 || { cat "$WORK/out"; exit 1; }
python3 "$MACHINE/model_to_page.py" "$WORK/record.json" "$WORK/page.html" >/dev/null || exit 1
python3 - "$HERE/state-machine-page.html" "$WORK/page.html" <<'PY' || exit 1
import re, sys
blocks = lambda path: [re.search(r'id="%s">(.*?)</script>' % i, open(path).read(), re.S).group(1) for i in ("graph-data", "state-machine-data")]
if blocks(sys.argv[1]) != blocks(sys.argv[2]):
    sys.exit("FAIL the page drawn from fabrik's record differs from the page")
print("ok - a page saved in fabrik and read back with fabrik_get_record draws with both data blocks unchanged")
PY
fi
# The board skill's board, drawn from what the real fabrik_get_progress returns for a plan with a
# child plan holding two tasks, and a child task.
echo "== progress board"
psql -U postgres -q -v result_file="$WORK/progress.json" -f "$HERE/progress-board.sql" >"$WORK/out" 2>&1 || { cat "$WORK/out"; exit 1; }
if [ -n "$DRAW" ]; then
python3 "$BOARD" "$WORK/progress.json" "$WORK/board.html" --purpose "The stand-in plan's owner sees, on one page, which of its activities are late." >/dev/null || exit 1
python3 - "$WORK/board.html" <<'PY' || exit 1
import json, re, sys
data = json.loads(re.search(r'id="board-data">(.*?)</script>', open(sys.argv[1]).read(), re.S).group(1))
title = {a["id"]: a["title"] for a in data["activities"]}
rows = [[title[r["activity"]], [title[c] for c in r["cards"]]] for r in data["rows"]]
if data["purpose"] != "The stand-in plan's owner sees, on one page, which of its activities are late.":
    sys.exit(f"FAIL the board has the wrong purpose statement: {data['purpose']}")
if data["plan"]["title"] != "First release" or rows != [["Sprint 1", ["Check customer addresses", "Load the SKU list"]], ["Sprint 2", ["Sprint 2"]]]:
    sys.exit(f"FAIL the board drawn from fabrik's progress has the wrong rows: {rows}")
owner = {a["title"]: a["owner"] for a in data["activities"]}
assignee = {a["title"]: a["assignee"] for a in data["activities"]}
admin = "Progress board check administrator"
if data["plan"]["owner"] != admin or any(o != admin for o in owner.values()):
    sys.exit(f"FAIL the board names the wrong owners: {data['plan']['owner']}, {owner}")
if assignee["Check customer addresses"] != admin or assignee["Load the SKU list"] is not None:
    sys.exit(f"FAIL the board names the wrong assignees: {assignee}")
print("ok - a plan's progress, read with fabrik_get_progress, draws as a board under its purpose statement, with a row for each part of the plan: a child plan's row holds the activities under it, and a child task's row holds its own card")
print("ok - the board names each activity's owner, as fabrik wrote it, and the person a task is assigned to")
PY
# The board's two parts are in its part menu, with All, and the board opens on the first part not completed.
python3 - "$WORK/board.html" "$WORK/board.outline.md" <<'PY' || exit 1
import json, re, sys
html, outline = (open(f, encoding="utf-8").read() for f in sys.argv[1:])
data = json.loads(re.search(r'id="board-data">(.*?)</script>', html, re.S).group(1))
line = next((l for l in outline.splitlines() if l.startswith("Parts: ")), None)
title = {a["id"]: a["title"] for a in data["activities"]}
if line != "Parts: (no index) Sprint 1, (no index) Sprint 2, All. Opens on (no index) Sprint 1." or title.get(data.get("open_row")) != "Sprint 1" or 'id="part-list" popover role="listbox"' not in html or 'role="tablist"' in html:
    sys.exit(f"FAIL the board drawn from fabrik's progress has the wrong parts: {line}, opens on {title.get(data.get('open_row'))}")
print(f"ok - the board drawn from fabrik_get_progress has a menu of each part and All: \"{line}\"")
PY
fi
# The board skill's model board, drawn from what the real fabrik_get_record returns for a model of a
# branch's people: by group of a node attribute, and by level of its reports to relation.
echo "== model board"
psql -U postgres -q -v payload="$(cat "$HERE/model-board.json")" -v result_file="$WORK/team.json" -f "$HERE/model-board.sql" >"$WORK/out" 2>&1 || { cat "$WORK/out"; exit 1; }
if [ -n "$DRAW" ]; then
python3 "$DRAWING/board/model_board.py" "$WORK/team.json" "$WORK/team.group.html" --layout group --by side >"$WORK/out" || exit 1
python3 "$DRAWING/board/model_board.py" "$WORK/team.json" "$WORK/team.level.html" --layout level --by "reports to" >>"$WORK/out" || exit 1
python3 - "$WORK/team.group.outline.md" "$WORK/team.level.outline.md" <<'PY' || exit 1
import sys
group, level = (open(f, encoding="utf-8").read() for f in sys.argv[1:])
for line in ("- Row 1: Sales · 3 cards", "- Row 2: Lettings · 3 cards · columns: High Street office",
             "- Lee Lettings · Lettings Lead · row Lettings · under High Street office", "- Weekend viewings · (no role) · row Sales · gap", "Findings: none"):
    if line not in group:
        sys.exit(f"FAIL the model board by side lacks: {line}\n{group}")
for line in ("- Beside the chart · 2 cards", "- Row 1: Level 1 · 1 card", "- Nat Negotiator · Negotiator · row Level 2 · under Mia Manager",
             "- Pat Property · Property Manager · row Level 3 · under Lee Lettings", "- High Street office · (no role) · row Beside the chart · place", "Findings: none"):
    if line not in level:
        sys.exit(f"FAIL the model board by reports to lacks: {line}\n{level}")
print("ok - a model read with fabrik_get_record draws as a board grouped by side, its site heading the Lettings column: \"- Row 2: Lettings · 3 cards · columns: High Street office\"")
print("ok - the same model draws by level of reports to, each card under its boss and the site and the gap beside the chart: \"- Pat Property · Property Manager · row Level 3 · under Lee Lettings\"")
PY
fi
python3 - "$WORK/progress.json" <<'PY' || exit 1
import json, sys
items = {i["title"]: i for i in json.load(open(sys.argv[1]))["items"]}
got = [(e["title"], e["standing"], e["deleted"]) for e in items["Load the SKU list"]["evidence"]]
if got != [("The SKU list, loaded", "observed", False)] or items["Check customer addresses"]["evidence"] != []:
    sys.exit(f"FAIL fabrik_get_progress gives the wrong evidence: {got}, {items['Check customer addresses']['evidence']}")
print("ok - fabrik_get_progress gives each activity the evidence its version links to as supports, and [] for none")
PY
# One plan model, drawn as a board and a graph by the graph and board skills' scripts, from what the
# real fabrik_get_progress returns for a plan whose activities carry their index.
echo "== plan model"
psql -U postgres -q -v result_file="$WORK/plan.json" -f "$HERE/plan-model.sql" >"$WORK/out" 2>&1 || { cat "$WORK/out"; exit 1; }
if [ -n "$DRAW" ]; then
python3 "$BOARD" "$WORK/plan.json" "$WORK/plan.board.html" --purpose "The order system's owner sees each sprint in order." >"$WORK/out" || exit 1
python3 "$GRAPH" "$WORK/plan.json" "$WORK/plan.graph.html" >>"$WORK/out" || exit 1
python3 - "$WORK/plan.board.outline.md" "$WORK/plan.graph.outline.md" "$WORK/out" <<'PY' || exit 1
import re, sys
board, graph, out = (open(f).read() for f in sys.argv[1:])
rows = re.findall(r"^## Row: (.*)$", board, re.M)
groups = re.findall(r"^## Group: (.*)$", graph, re.M)
cards = re.findall(r"^- (2\.\S+) ", board.split("## Row: 2 Sprint 2")[1].split("## Row:")[0], re.M)
nodes = re.findall(r"^- (\S+) .* · (\w+)$", graph.split("## Group: Sprint 2")[1].split("## Group:")[0], re.M)
if rows != ["1 Sprint 1", "2 Sprint 2", "10 Sprint 10"] or groups != ["Order system", "Sprint 1", "Sprint 2", "Sprint 10"]:
    sys.exit(f"FAIL the plan's rows or groups are out of index order: {rows}, {groups}")
if cards != ["2.2", "2.2-B1", "2.2a"] or nodes != [("2", "Plan"), ("2.2", "Task"), ("2.2-B1", "Blocker"), ("2.2a", "Deliverable")]:
    sys.exit(f"FAIL Sprint 2's activities are wrong: {cards}, {nodes}")
if "· Blocked 1 · Deliverables 0 of 1 done\n" not in board or "Findings: none" not in board or "Findings: none" not in graph or out.count("0 findings") != 2:
    sys.exit(f"FAIL the outlines show the wrong badges or findings:\n{board}\n{out}")
print("ok - a plan saved with an index on each activity draws as a board and a graph from one plan model: sprints in index order, task 2.2 with its blocker and its deliverable as their own items, and no findings")
PY
fi
# The fabrik print skill's pages, from what the real fabrik_get_reference and fabrik_get_record return: the
# glossary with its classes and relationship, the data dictionary, and an SOP for the routine.
echo "== print pages"
python3 "$MACHINE/page_to_model.py" "$HERE/state-machine-page.html" "$WORK/routine.json" >/dev/null || exit 1
psql -U postgres -q -v payload="$(cat "$WORK/routine.json")" -v glossary_file="$WORK/glossary.json" -v dictionary_file="$WORK/dictionary.json" \
  -v record_file="$WORK/routine.record.json" -f "$HERE/print-pages.sql" >"$WORK/out" 2>&1 || { cat "$WORK/out"; exit 1; }
if [ -n "$DRAW" ]; then
PRINT=$DRAWING/print
python3 "$PRINT/reference_page.py" "$WORK/glossary.json" "$WORK/glossary.html" >/dev/null || exit 1
python3 "$PRINT/reference_page.py" "$WORK/dictionary.json" "$WORK/dictionary.html" >/dev/null || exit 1
python3 "$PRINT/sop_page.py" "$WORK/routine.record.json" "$WORK/glossary.json" "$WORK/sop.html" --picture routine.png >/dev/null || exit 1
python3 - "$WORK" <<'PY' || exit 1
import json, re, sys
w = sys.argv[1]
read = lambda name: open(f"{w}/{name}", encoding="utf-8").read()
glossary = read("glossary.outline.md")
for line in ("## Classes\n\n- property: A home the business markets for sale or to let.\n- vendor: A person selling a property through the business. Other names: seller.",
             "- owns (vendor to property): A vendor owns the property they sell.", "- memorandum of sale: The note that confirms an agreed sale to both sides. Other names: MoS."):
    if line not in glossary:
        sys.exit(f"FAIL the glossary page lacks: {line}\n{glossary}")
dictionary = read("dictionary.outline.md")
if "Class: property. A property the business has been instructed to sell." not in dictionary or "- asking_price · numeric · required: The price the vendor asks. From listings system: price." not in dictionary:
    sys.exit(f"FAIL the data dictionary page is wrong:\n{dictionary}")
if "@page { size: A4;" not in read("glossary.html"):
    sys.exit("FAIL the glossary page is not set for A4")
print("ok - the glossary, with its classes and relationship, and the data dictionary are written as A4 pages from what fabrik_get_reference returns")
sop = read("sop.outline.md")
if "Model version 1, proposed_target." not in sop or "- 1.3 Send booking confirmation · Step · who: fabrik · tool: Agency diary · checks: none" not in sop \
        or "## Terms\n\n- agency diary\n- owns\n- property\n- vendor\n" not in sop or "Picture: routine.png" not in sop or "Findings: none" not in sop:
    sys.exit(f"FAIL the SOP drawn from fabrik_get_record is wrong:\n{sop}")
print("ok - an SOP is written from the routine's model version as fabrik_get_record returns it, with each state, the drawn state machine and the glossary terms it uses")
PY
fi
# The fabrik records skill's finish order and links through a change of state, as an administrator
# signed in: a sprint's finish before its task's refused with fabrik's sentence, and evidence linked once
# counted through changes of state, to the task's completion.
echo "== finish order and links through state"
psql -U postgres -q -f "$HERE/finish-order.sql" >"$WORK/out" 2>&1 \
  || { grep -v "^$" "$WORK/out"; exit 1; }
sed -n 's/^.*NOTICE:  //p' "$WORK/out"
}

# The file-search hosted functions take, embed and search files and records, each reader seeing only what they
# may; the graph reader's prompt is section 19 of the records skill, and it reads a file's graph with the Anthropic
# API answered by the test; and a search ranks the reference scope's files and records apart. In this order, on one
# copy: the graph reader reads the glossary and parts the file-search functions leave.
step_file_search() {
  echo "== file search functions"
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys --allow-import "$HERE/file-search-functions.ts" || exit 1
  echo "== graph-reader"
  "$DENO" run --quiet --no-lock --allow-read "$ROOT/scripts/graph-reader-prompt.ts" --check || exit 1
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-sys --allow-import "$HERE/graph-reader.ts" || exit 1
  echo "== reference hits"
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-sys --allow-import "$HERE/reference-hits.ts" || exit 1
}

# A record that came from maxy-code is found by the id it had there, only by a caller who may read it, and not once deleted;
# and fabrik import maxy loads an export as the owner, reports each label and type, loads nothing twice, and refuses an
# export with an unknown label or a changed file before anything is saved.
step_maxy_import() {
  echo "== find-by-source.sql"
  psql -U postgres -f "$HERE/find-by-source.sql" >"$WORK/out" 2>&1
  grep -E "ERROR|FAIL|PASS" "$WORK/out" | tail -1
  grep -q "ERROR:  PASS: find by source" "$WORK/out" || { cat "$WORK/out"; exit 1; }
  echo "== fabrik import maxy"
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys --allow-import "$HERE/maxy-import.ts" || exit 1
}

# Each upgrade brings a project built before it to the same schema as a new build. On a cluster of its own.
step_upgrades() {
  echo "== upgrades"
  sh "$HERE/upgrades.sh" || exit 1
}

# Setup, sign-in, scopes, upgrades and fabrik setup, as a person runs them, against stand-in Supabase services.
# On a cluster of its own, at SETUP_FLOW_PORT or PORT plus 2.
step_setup_flow() {
  echo "== setup flow"
  sh "$HERE/setup-flow.sh" || exit 1
}

# fabrik's connector answers an unsigned request with the sign-in's address, and a signed-in person's MCP calls as that
# person: each tool runs under their own token, so fabrik's grants decide what it gives.
step_fabrik_apps() {
  echo "== fabrik-apps"
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" STAND_IN_TMP="$WORK" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-sys --allow-import --allow-write="$WORK" --allow-run=node "$HERE/fabrik-apps.ts" || exit 1
}

# A routine is written down and designed through the connector as the routine skills save it, and the records skill's
# calls find its version in force: the confirmed current state until a design is selected, then that design's version.
step_routines() {
  echo "== routines"
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-sys --allow-import "$HERE/routines.ts" || exit 1
}

# The connector's mail tools reach only an administrator's mailbox, read it without changing anything on the server,
# check its certificate, and never give its password back. The server is fake-imap.ts, on implicit TLS with a
# certificate a test CA signed, which Deno trusts through DENO_CERT; a second certificate, from a CA it does not
# trust, stands for a server it must refuse.
step_mail() {
  echo "== mail"
  certs=$WORK/certs; mkdir -p "$certs"
  for ca in ca stranger-ca; do
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$certs/$ca.key" -out "$certs/$ca.pem" -days 1 -subj "/CN=stand-in $ca" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" >/dev/null 2>&1 || { echo "FAIL openssl made no $ca"; exit 1; }
  done
  printf 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' >"$certs/ext.cnf"
  for pair in ":ca" "stranger-:stranger-ca"; do
    p=${pair%%:*}; ca=${pair#*:}
    openssl req -newkey rsa:2048 -nodes -keyout "$certs/${p}key.pem" -out "$certs/${p}req.csr" -subj "/CN=localhost" >/dev/null 2>&1 \
      && openssl x509 -req -in "$certs/${p}req.csr" -CA "$certs/$ca.pem" -CAkey "$certs/$ca.key" -CAcreateserial \
        -out "$certs/${p}cert.pem" -days 1 -extfile "$certs/ext.cnf" >/dev/null 2>&1 || { echo "FAIL openssl made no ${p}cert"; exit 1; }
  done
  DENO_CERT="$certs/ca.pem" STAND_IN_CERTS="$certs" STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-sys --allow-import "$HERE/mail.ts" || exit 1
}

# The public agent answers a visitor only from KNOWLEDGE.md, after Cloudflare's Turnstile check, within the daily cap in
# tokens, and keeps no question. fabrik chat-page builds its page in the brand, and the widget opens it from another
# website. Anthropic, Cloudflare, Storage and Wrangler are answered by the test.
step_public_agent() {
  echo "== public-agent"
  STAND_IN_DB="postgres://postgres@127.0.0.1:$PORT/$DB" "$DENO" run --quiet --no-lock \
    --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys --allow-import "$HERE/public-agent.ts" || exit 1
}

psql -U supabase_admin -q -f "$HERE/supabase.sql" || exit 1
build "$SETUP/setup.sql"
build "$SEARCH/file-search.sql"
build "$SETUP/file-search-scopes.sql"
# A new build holds no glossary term and no data dictionary row.
psql -U postgres -At -c "select (select count(*) from fabrik.glossary_term)+(select count(*) from fabrik.dictionary_table)
 +(select count(*) from fabrik.dictionary_column)+(select count(*) from fabrik.dictionary_source)" >"$WORK/out" 2>&1
grep -qx 0 "$WORK/out" || { echo "FAIL a new build's reference tables are not empty"; cat "$WORK/out"; exit 1; }
echo "ok - a new build's glossary and data dictionary tables are empty"
# Statistics, as a project that holds data has them: without them Postgres picks joins that take seconds.
psql -U postgres -q -c analyze || exit 1

for name in $STEPS; do start "$name"; done
finish
