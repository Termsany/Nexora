#!/usr/bin/env bash
# Validation harness for the CURRENT self-monitoring architecture.
#
# Replaces scripts/run-pr06-monitoring-scenarios.sh and
# scripts/run-pr06b-validation.sh, which drove the pre-refactor contract
# (NEXORA_MON_PG_CONTAINER / NEXORA_MON_BACKUP_ROOT / NEXORA_NOTIFY_WEBHOOK --
# all removed) and set none of the inputs the current code requires.
#
# Current contract under test:
#   * container facts come from a published container-state.json projection
#     (metadata.py), never from `docker inspect` in the probe
#   * DB facts come over TCP as the unprivileged nexora_monitor role using
#     PGPASSFILE, through nexora_monitoring.* aggregate views only
#   * backup facts come from a sanitized 4-field backup-state.json; the probe
#     never touches dumps, sidecars or keys
#   * notify-local.sh is a thin wrapper around notify.py
#
# Everything is disposable: own network, own Postgres, own fixtures. It
# touches no Production container, database, secret, path or host identity.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

MON=scripts/monitoring
HEALTH="$MON/platform-health.sh"
SQL="$MON/sql/local-staging-monitoring.sql"
SUF=$$
NET="phtest-$SUF"
PG="phtest-pg-$SUF"
EDGE_C="phtest-edge-$SUF"
TLS_OK="phtest-tlsok-$SUF"
TLS_SOON="phtest-tlssoon-$SUF"
WORK="$(mktemp -d)"
PGPW="phtest-disposable-$SUF"

pass=0; fail=0
ok(){ printf '  [ PASS ] %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }
sec(){ printf '\n== %s ==\n' "$1"; }

cleanup(){ docker rm -f "$PG" "$EDGE_C" "$TLS_OK" "$TLS_SOON" >/dev/null 2>&1
           docker network rm "$NET" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------- setup ----
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_DB=nexora -e POSTGRES_USER=nexora_app -e POSTGRES_PASSWORD=apppw \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U nexora_app -d nexora >/dev/null 2>&1 && break; sleep 1; done
PG_IP=$(docker inspect "$PG" --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}")

# Application tables the monitoring views aggregate over.
docker exec -i "$PG" psql -q -U nexora_app -d nexora >/dev/null 2>&1 <<'SQLEOF'
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations(id serial primary key, hash text, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT 'h'||g,0 FROM generate_series(1,13) g;
CREATE TABLE public.nexora_worker_heartbeats(worker text primary key, last_seen_at timestamptz, metadata jsonb);
CREATE TABLE public.nexora_devices(id uuid default gen_random_uuid() primary key, last_seen_at timestamptz, hostname text);
CREATE TABLE public.nexora_device_metrics(id bigserial primary key, received_at timestamptz);
CREATE TABLE public.nexora_device_software(id bigserial primary key, last_seen_at timestamptz);
INSERT INTO public.nexora_worker_heartbeats VALUES ('maintenance',now(),'{}'),('notification-worker',now(),'{}');
INSERT INTO public.nexora_devices(last_seen_at,hostname) SELECT now(),'dev-'||g FROM generate_series(1,3) g;
INSERT INTO public.nexora_device_metrics(received_at) VALUES (now());
INSERT INTO public.nexora_device_software(last_seen_at) VALUES (now());
SQLEOF

# The REAL monitoring migration - applying it here also validates the SQL.
if docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U nexora_app -d nexora < "$SQL" >/dev/null 2>"$WORK/sql.err"; then
  SQL_APPLIED=1
else
  SQL_APPLIED=0; echo "  (monitoring SQL failed to apply: $(tail -1 "$WORK/sql.err"))"
fi
docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "ALTER ROLE nexora_monitor PASSWORD '$PGPW'" >/dev/null 2>&1

# psql wrapper: this host has no native psql, which is exactly what
# NEXORA_MON_PSQL exists for. The credential is mounted, never in argv.
cat > "$WORK/psql-wrapper" <<EOF
#!/usr/bin/env bash
# psql still dials $PG_IP:5432 over TCP as nexora_monitor with SCRAM; exec-ing
# into the running container only avoids per-query container startup latency.
exec docker exec -i -e PGPASSFILE=/pgpass -e PGOPTIONS -e PGCONNECT_TIMEOUT \\
  $PG psql "\$@"
EOF
chmod +x "$WORK/psql-wrapper"

mkdir -p "$WORK/creds"
setpgpass(){ # <password> - keep host copy and in-container copy in step
  printf '%s:5432:nexora:nexora_monitor:%s\n' "$PG_IP" "$1" > "$WORK/creds/pgpass"
  chmod 600 "$WORK/creds/pgpass"
  docker cp "$WORK/creds/pgpass" "$PG:/pgpass" >/dev/null 2>&1
  docker exec "$PG" chmod 600 /pgpass >/dev/null 2>&1
  return 0
}
setpgpass "$PGPW"

# EDGE fixture
cat > "$WORK/edge.conf" <<'EOF'
server { listen 8080;
  location = /            { add_header Content-Type text/plain; return 200 "ok\n"; }
  location = /api/healthz { add_header Content-Type application/json; return 200 "{\"status\":\"ok\"}\n"; }
}
EOF
EDGE_PORT=$(( 24000 + RANDOM % 2000 ))
docker run -d --name "$EDGE_C" --network "$NET" -p "127.0.0.1:${EDGE_PORT}:8080" \
  -v "$WORK/edge.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine >/dev/null

# TLS fixtures. The probe now does FULL verification (-verify_return_error
# -verify_hostname), so a self-signed cert correctly fails. Stand up a real CA
# carrying the expected issuer name so both the trust chain and the issuer
# check are genuinely exercised; SSL_CERT_FILE gives the probe that anchor
# without touching the host trust store.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/ca.key" -out "$WORK/ca.crt" \
  -days 3650 -subj "/CN=Nexora Internal Root CA/O=Nexora/OU=Nexora IT Operations" 2>/dev/null
mkcert(){ # <name> <days>
  openssl req -newkey rsa:2048 -nodes -keyout "$WORK/$1.key" -out "$WORK/$1.csr" \
    -subj "/CN=nexora-staging.design.local/O=Nexora" 2>/dev/null
  printf 'subjectAltName=DNS:nexora-staging.design.local\n' > "$WORK/$1.ext"
  openssl x509 -req -in "$WORK/$1.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
    -CAcreateserial -out "$WORK/$1.crt" -days "$2" -extfile "$WORK/$1.ext" 2>/dev/null
}
mkcert tlsok 3650; mkcert tlssoon 10
tlssrv(){ docker run -d --name "$1" --network "$NET" -p "127.0.0.1:$2:8443" \
  -v "$WORK/$3.crt:/c.crt:ro" -v "$WORK/$3.key:/c.key:ro" nginx:alpine sh -c \
  'printf "server{listen 8443 ssl;ssl_certificate /c.crt;ssl_certificate_key /c.key;location /{return 200 ok;}}" > /etc/nginx/conf.d/default.conf; exec nginx -g "daemon off;"' >/dev/null; }
TLS_OK_PORT=$(( 26000 + RANDOM % 2000 )); TLS_SOON_PORT=$(( 28000 + RANDOM % 2000 ))
tlssrv "$TLS_OK" "$TLS_OK_PORT" tlsok; tlssrv "$TLS_SOON" "$TLS_SOON_PORT" tlssoon
sleep 3

# ------------------------------------------------------------- fixtures ----
PROJ=phtest
cstate(){ # <api-status> <api-health> <api-restarts> <maint-status> <notif-status> [pg-status] [pg-addr]
  python3 - "$WORK/container-state.json" "$PROJ" "$1" "$2" "$3" "$4" "$5" "${6:-running}" "${7:-$PG_IP}" <<'PY'
import json,sys
out,proj,ast,ah,ar,ms,ns,ps,paddr = sys.argv[1:10]
def row(n,st,h="none",rc=0,addr=""):
    return {"name":f"{proj}-{n}-1","exists":st!="missing","status":st,"health":h,
            "restart_count":int(rc),"postgres_addr":addr}
rows=[row("api",ast,ah,ar), row("postgres",ps,"healthy",0,paddr if ps!="missing" else ""),
      row("maintenance",ms), row("notification-worker",ns)]
open(out,"w").write(json.dumps(rows)+"\n")
PY
  chmod 644 "$WORK/container-state.json"
}
bstate(){ # <age_hours> <checksum_ok> <encrypted> <off_host_ok>
  python3 - "$WORK/backup-state.json" "$1" "$2" "$3" "$4" <<'PY'
import json,sys,time
out,age,c,e,o = sys.argv[1:6]
rec={"last_success_epoch":int(time.time())-int(float(age)*3600),
     "checksum_ok":c=="1","encrypted":e=="1","off_host_ok":o=="1"}
open(out,"w").write(json.dumps(rec)+"\n")
PY
  chmod 644 "$WORK/backup-state.json"
}
hb(){ docker exec "$PG" psql -q -U nexora_app -d nexora \
      -c "UPDATE public.nexora_worker_heartbeats SET last_seen_at=now()" >/dev/null 2>&1
     [ -n "${1:-}" ] && docker exec "$PG" psql -q -U nexora_app -d nexora \
      -c "UPDATE public.nexora_worker_heartbeats SET last_seen_at=now()-interval '$1' WHERE worker='maintenance'" >/dev/null 2>&1
     return 0; }

run(){ # any VAR=val overrides as args -> JSON on stdout, RC in $RC
  local out
  out=$(env NEXORA_MON_BASE_URL="http://127.0.0.1:$EDGE_PORT" \
        NEXORA_MON_TLS_HOST="127.0.0.1:$TLS_OK_PORT" \
        NEXORA_MON_TLS_SERVERNAME=nexora-staging.design.local \
        NEXORA_MON_COMPOSE_PROJECT="$PROJ" \
        NEXORA_MON_CONTAINER_STATE="$WORK/container-state.json" \
        NEXORA_MON_BACKUP_STATE="$WORK/backup-state.json" \
        NEXORA_MON_DISK_PATHS=/ \
        NEXORA_MON_STATE_DIR="$WORK/state" \
        NEXORA_MON_PSQL="$WORK/psql-wrapper" \
        NEXORA_MON_PG_DATABASE=nexora \
        CREDENTIALS_DIRECTORY="$WORK/creds" \
        SSL_CERT_FILE="$WORK/ca.crt" \
        "$@" bash "$HEALTH" --json-only 2>/dev/null)
  RC=$?; printf '%s' "$RC" > "$WORK/last.rc"; printf '%s' "$out"
}
lastrc(){ cat "$WORK/last.rc" 2>/dev/null || echo 99; }
dom(){ python3 -c "import sys,json;print(json.load(sys.stdin)['domains']['$1']['state'])" 2>/dev/null || echo PARSE_ERROR; }
valid_json(){ python3 -c '
import sys,json
d=json.load(sys.stdin)
D={"EDGE","API","DATABASE","WORKERS","BACKUP","CAPACITY","TLS","AGENT_INGESTION"}
assert set(d["domains"])==D and d["overall"] in {"HEALTHY","WARNING","CRITICAL","UNKNOWN"}
for v in d["domains"].values():
    assert set(v)=={"state","detail"} and v["state"] in {"HEALTHY","WARNING","CRITICAL","UNKNOWN"}
' 2>/dev/null; }
reset(){ cstate running healthy 0 running running; bstate 1 1 1 1; hb; rm -rf "$WORK/state"; }

# ============================ monitoring SQL ==============================
sec "monitoring SQL + least-privilege role"
[ "$SQL_APPLIED" = 1 ] && ok "local-staging-monitoring.sql applies cleanly" || no "monitoring SQL failed to apply"
attrs=$(docker exec "$PG" psql -tAX -U nexora_app -d nexora -c \
 "SELECT rolsuper::text||rolcreatedb::text||rolcreaterole::text||rolreplication::text||rolbypassrls::text FROM pg_roles WHERE rolname='nexora_monitor'" 2>/dev/null)
[ "$attrs" = "falsefalsefalsefalsefalse" ] && ok "nexora_monitor is NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS" \
                       || no "nexora_monitor attributes wrong ($attrs)"
for t in nexora_devices nexora_device_metrics nexora_device_software nexora_worker_heartbeats; do
  p=$(docker exec "$PG" psql -tAX -U nexora_app -d nexora -c \
      "SELECT has_any_column_privilege('nexora_monitor','public.$t','SELECT')" 2>/dev/null)
  [ "$p" = f ] || { no "nexora_monitor can read base table $t"; break; }
done
[ "${p:-f}" = f ] && ok "nexora_monitor has NO base-table (PII-bearing) SELECT"
pm=$(docker exec "$PG" psql -tAX -U nexora_app -d nexora -c \
     "SELECT pg_has_role('nexora_monitor','pg_monitor','MEMBER')" 2>/dev/null)
[ "$pm" = f ] && ok "nexora_monitor is not a pg_monitor member" || no "nexora_monitor in pg_monitor ($pm)"
v=$(docker exec "$PG" psql -tAX -U nexora_app -d nexora -c \
    "SELECT count(*) FROM information_schema.views WHERE table_schema='nexora_monitoring'" 2>/dev/null)
[ "$v" = 3 ] && ok "3 aggregate views present (migration_status, worker_heartbeats, ingestion_status)" \
             || no "expected 3 monitoring views, found $v"

# ============================ JSON + exit codes ===========================
sec "JSON contract and structured exit codes"
reset; J=$(run); rc=$(lastrc)
printf '%s' "$J" | valid_json && ok "JSON contract valid (8 domains, typed states)" || no "JSON contract invalid"

# The exit-0 mapping needs every domain HEALTHY. On this host the only psql is
# containerised, and metadata.py + the docker CLI stack inside check_database's
# measured window (~127ms exec + ~40ms python + CLI) land just over the 250ms
# DB_LATENCY_WARN_MS line, so DATABASE is legitimately WARNING here. A real
# deployment uses native psql. Isolate the exit-code mapping with a fast stub;
# the genuine TCP + SCRAM + aggregate-view path is asserted separately below.
cat > "$WORK/psql-stub" <<'STUBEOF'
#!/usr/bin/env bash
q=""; while [ $# -gt 0 ]; do [ "$1" = -c ] && { q="$2"; shift; }; shift; done
case "$q" in
  "SELECT 1")                 echo 1 ;;
  *migration_status*)         echo 13 ;;
  *worker_heartbeats*)        date +%s ;;
  *ingestion_status*)         echo "3 3 0 0" ;;
  *)                          exit 1 ;;
esac
STUBEOF
chmod +x "$WORK/psql-stub"
# CAPACITY also has to be neutral: this real host sits at ~78% disk, which is
# a genuine WARNING. Pin df to healthy values for the exit-code assertion only.
mkdir -p "$WORK/bin0"
cat > "$WORK/bin0/df" <<'DF0EOF'
#!/bin/sh
if printf '%s\n' "$@" | grep -q -- '-Pi'; then
  printf 'F I U Fr IUse%% M\n/dev/fake 100 20 80 20%% /\n'
else
  printf 'F B U A Cap M\n/dev/fake 100 40 60 40%% /\n'
fi
DF0EOF
chmod +x "$WORK/bin0/df"
reset; J=$(run "NEXORA_MON_PSQL=$WORK/psql-stub" "PATH=$WORK/bin0:$PATH"); rc=$(lastrc)
ov=$(printf '%s' "$J"|python3 -c 'import sys,json;print(json.load(sys.stdin)["overall"])')
[ "$ov" = HEALTHY ] && [ "$rc" -eq 0 ] && ok "all domains healthy -> overall HEALTHY, exit 0" \
  || no "healthy fixture gave overall=$ov exit=$rc"

reset; bstate 26 1 1 1; J=$(run); rc=$(lastrc)
[ "$rc" -eq 1 ] && ok "WARNING state -> exit 1" || no "expected exit 1, got $rc"
printf '%s' "$J" | valid_json && ok "JSON still valid in WARNING state" || no "JSON invalid in WARNING"

reset; bstate 40 1 1 1; J=$(run); rc=$(lastrc)
[ "$rc" -eq 2 ] && ok "CRITICAL state -> exit 2" || no "expected exit 2, got $rc"
printf '%s' "$J" | valid_json && ok "JSON still valid in CRITICAL state" || no "JSON invalid in CRITICAL"

reset; hb '12 minutes'; J=$(run "NEXORA_MON_DISK_PATHS=/nonexistent-mount-$SUF")
printf '%s' "$J" | valid_json && ok "JSON still valid with UNKNOWN domains present" || no "JSON invalid with UNKNOWN"

# ============================ EDGE ========================================
sec "EDGE"
reset; J=$(run); [ "$(printf '%s' "$J"|dom EDGE)" = HEALTHY ] && ok "EDGE healthy when both probes 200" || no "EDGE healthy"
reset; DEAD="http://127.0.0.1:$(( 30000 + RANDOM % 2000 ))"
J=$(run "NEXORA_MON_BASE_URL=$DEAD"); s1=$(printf '%s' "$J"|dom EDGE)
[ "$s1" = UNKNOWN ] && ok "EDGE 1st consecutive failure -> UNKNOWN (never a false HEALTHY)" || no "EDGE 1st failure gave $s1"
J=$(run "NEXORA_MON_BASE_URL=$DEAD"); [ "$(printf '%s' "$J"|dom EDGE)" = WARNING ] && ok "EDGE 2nd consecutive failure -> WARNING" || no "EDGE 2nd failure"
J=$(run "NEXORA_MON_BASE_URL=$DEAD"); [ "$(printf '%s' "$J"|dom EDGE)" = CRITICAL ] && ok "EDGE 3rd consecutive failure -> CRITICAL" || no "EDGE 3rd failure"
J=$(run); [ "$(printf '%s' "$J"|dom EDGE)" = HEALTHY ] && ok "EDGE recovers to HEALTHY and resets the counter" || no "EDGE recovery"
reset; J=$(run "NEXORA_MON_STATE_DIR=/proc/cannot-write-here")
[ "$(printf '%s' "$J"|dom EDGE)" = CRITICAL ] && ok "EDGE unwritable probe state -> CRITICAL (internal error, not HEALTHY)" || no "EDGE unwritable state"

# ============================ API =========================================
sec "API (from the container-state projection)"
reset; J=$(run); [ "$(printf '%s' "$J"|dom API)" = HEALTHY ] && ok "API running+healthy -> HEALTHY" || no "API healthy"
cstate running unhealthy 0 running running; J=$(run)
[ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "API healthcheck unhealthy -> CRITICAL" || no "API unhealthy"
cstate running healthy 5 running running; J=$(run)
[ "$(printf '%s' "$J"|dom API)" = WARNING ] && ok "API restart_count>=3 -> WARNING (crash-loop signal)" || no "API restarts"
cstate exited none 0 running running; J=$(run)
[ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "API container exited -> CRITICAL" || no "API exited"
cstate missing none 0 running running; J=$(run)
[ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "API container missing -> CRITICAL" || no "API missing"
cstate running starting 0 running running; J=$(run)
[ "$(printf '%s' "$J"|dom API)" = WARNING ] && ok "API health=starting -> WARNING" || no "API starting"

# ============================ container-state contract ====================
sec "container-state contract"
reset
fields=$(python3 -c "import json;print(','.join(sorted(json.load(open('$WORK/container-state.json'))[0])))")
[ "$fields" = "exists,health,name,postgres_addr,restart_count,status" ] \
  && ok "projection exposes exactly {name,exists,status,health,restart_count,postgres_addr}" \
  || no "projection fields wrong: $fields"
if grep -qiE '"(Env|Config|Mounts|HostConfig)"|JWT_SECRET|ADMIN_API_TOKEN|ENROLLMENT_SECRET|TELEGRAM_BOT_TOKEN|POSTGRES_PASSWORD' "$WORK/container-state.json"; then
  no "projection carries secret-bearing inspect fields"
else ok "projection carries no Env/Mounts/HostConfig or any secret material"; fi

python3 -c "
import json;p='$WORK/container-state.json';d=json.load(open(p));d[0]['extra']='x';json.dump(d,open(p,'w'))"
J=$(run); [ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "extra field in projection -> rejected, API CRITICAL" || no "extra field accepted"
reset; python3 -c "
import json;p='$WORK/container-state.json';d=json.load(open(p));d[0]['status']='bogus';json.dump(d,open(p,'w'))"
J=$(run); [ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "invalid status value -> rejected, API CRITICAL" || no "invalid status accepted"
reset; python3 -c "
import json;p='$WORK/container-state.json';d=json.load(open(p))
[r.__setitem__('postgres_addr','not-an-ip') for r in d if r['name'].endswith('postgres-1')];json.dump(d,open(p,'w'))"
J=$(run); [ "$(printf '%s' "$J"|dom DATABASE)" = CRITICAL ] && ok "non-IP postgres_addr -> rejected, DATABASE CRITICAL" || no "bad IP accepted"
reset; printf 'this is not json\n' > "$WORK/container-state.json"; chmod 644 "$WORK/container-state.json"
J=$(run); a=$(printf '%s' "$J"|dom API)
[ "$a" = CRITICAL ] && ok "malformed JSON projection -> CRITICAL (no false HEALTHY)" || no "malformed JSON gave $a"
reset; rm -f "$WORK/container-state.json"
J=$(run); [ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "missing projection -> CRITICAL" || no "missing projection"
reset; touch -d '10 minutes ago' "$WORK/container-state.json"
J=$(run); [ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "stale projection (>120s) -> CRITICAL" || no "stale projection accepted"
reset; chmod 664 "$WORK/container-state.json"
J=$(run); [ "$(printf '%s' "$J"|dom API)" = CRITICAL ] && ok "group-writable projection -> rejected, CRITICAL" || no "group-writable accepted"

# ============================ DATABASE ====================================
sec "DATABASE (TCP + pgpass + aggregate views only)"
reset; J=$(run); d=$(printf '%s' "$J"|dom DATABASE)
det=$(printf '%s' "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)["domains"]["DATABASE"]["detail"])')
# NOTE: the containerised psql wrapper adds ~300-800ms of startup that native
# psql does not, which can cross the 250ms WARNING line. Assert reachability
# and that the aggregate view answered, not wrapper latency.
{ [ "$d" = HEALTHY ] || [ "$d" = WARNING ]; } && grep -q 'migrations=13' <<<"$det" \
  && ok "DATABASE reachable as nexora_monitor over TCP, migration_status view answered ($d)" \
  || no "DATABASE healthy (got $d / $det)"
reset; J=$(run "CREDENTIALS_DIRECTORY=$WORK/no-such-creds")
[ "$(printf '%s' "$J"|dom DATABASE)" = CRITICAL ] && ok "missing pgpass credential -> CRITICAL" || no "missing pgpass"
reset; setpgpass wrong-password
J=$(run); [ "$(printf '%s' "$J"|dom DATABASE)" = CRITICAL ] && ok "wrong DB password -> CRITICAL (auth failure not HEALTHY)" || no "wrong password"
setpgpass "$PGPW"
reset; docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "REVOKE SELECT ON ALL TABLES IN SCHEMA nexora_monitoring FROM nexora_monitor" >/dev/null 2>&1
J=$(run); dd=$(printf '%s' "$J"|dom DATABASE)
[ "$dd" = CRITICAL ] && ok "view permission revoked -> CRITICAL (permission-denied never HEALTHY)" || no "permission denied gave $dd"
docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "GRANT SELECT ON ALL TABLES IN SCHEMA nexora_monitoring TO nexora_monitor" >/dev/null 2>&1
reset; docker stop "$PG" >/dev/null
J=$(run); [ "$(printf '%s' "$J"|dom DATABASE)" = CRITICAL ] && ok "Postgres unreachable -> CRITICAL" || no "unreachable DB"
docker start "$PG" >/dev/null
for _ in $(seq 1 40); do docker exec "$PG" pg_isready -U nexora_app -d nexora >/dev/null 2>&1 && break; sleep 1; done
reset; d=$(printf '%s' "$(run)"|dom DATABASE)
{ [ "$d" = HEALTHY ] || [ "$d" = WARNING ]; } && ok "DATABASE recovers after outage ($d)" || no "DB recovery (got $d)"

# ============================ WORKERS =====================================
sec "WORKERS"
reset; J=$(run); [ "$(printf '%s' "$J"|dom WORKERS)" = HEALTHY ] && ok "fresh heartbeats -> HEALTHY" || no "workers healthy"
reset; hb '12 minutes'; J=$(run)
[ "$(printf '%s' "$J"|dom WORKERS)" = WARNING ] && ok "heartbeat 10-30 min stale -> WARNING" || no "workers warning"
reset; hb '40 minutes'; J=$(run)
[ "$(printf '%s' "$J"|dom WORKERS)" = CRITICAL ] && ok "heartbeat >30 min stale -> CRITICAL" || no "workers critical"
reset; cstate running healthy 0 exited running; J=$(run)
[ "$(printf '%s' "$J"|dom WORKERS)" = CRITICAL ] && ok "worker container not running -> CRITICAL" || no "worker container down"
reset; docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "DELETE FROM public.nexora_worker_heartbeats WHERE worker='notification-worker'" >/dev/null 2>&1
J=$(run); [ "$(printf '%s' "$J"|dom WORKERS)" = UNKNOWN ] && ok "absent heartbeat row -> UNKNOWN (not a false HEALTHY)" || no "absent heartbeat row"
docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "INSERT INTO public.nexora_worker_heartbeats VALUES ('notification-worker',now(),'{}')" >/dev/null 2>&1

# ============================ BACKUP ======================================
sec "BACKUP (sanitized metadata only)"
reset; J=$(run); [ "$(printf '%s' "$J"|dom BACKUP)" = HEALTHY ] && ok "fresh verified metadata -> HEALTHY" || no "backup healthy"
reset; bstate 26 1 1 1; J=$(run); [ "$(printf '%s' "$J"|dom BACKUP)" = WARNING ] && ok "age 24-36h -> WARNING" || no "backup warning"
reset; bstate 40 1 1 1; J=$(run); [ "$(printf '%s' "$J"|dom BACKUP)" = CRITICAL ] && ok "age >36h -> CRITICAL" || no "backup critical"
reset; bstate 1 0 1 1; J=$(run); [ "$(printf '%s' "$J"|dom BACKUP)" = CRITICAL ] && ok "checksum_ok=false -> CRITICAL" || no "backup checksum"
reset; bstate 1 1 0 1; J=$(run); [ "$(printf '%s' "$J"|dom BACKUP)" = CRITICAL ] && ok "encrypted=false -> CRITICAL" || no "backup unencrypted"
reset; bstate 1 1 1 0; J=$(run); [ "$(printf '%s' "$J"|dom BACKUP)" = WARNING ] && ok "off_host_ok=false -> WARNING" || no "backup off-host"
reset; rm -f "$WORK/backup-state.json"; J=$(run)
[ "$(printf '%s' "$J"|dom BACKUP)" = CRITICAL ] && ok "missing metadata -> CRITICAL" || no "backup missing"
reset; touch -d '2 hours ago' "$WORK/backup-state.json"; J=$(run)
[ "$(printf '%s' "$J"|dom BACKUP)" = CRITICAL ] && ok "stale metadata file (>1800s) -> CRITICAL" || no "backup stale file"
reset
if grep -qiE 'dump|\.gpg|sha256|BEGIN .*PRIVATE KEY|/var/backups' "$WORK/backup-state.json"; then
  no "backup metadata references artifact paths/checksums/keys"
else ok "backup metadata is sanitized (no dump path, sidecar, or key material)"; fi

# ============================ CAPACITY ====================================
sec "CAPACITY"
mkdir -p "$WORK/bin"
mkdf(){ cat > "$WORK/bin/df" <<DFEOF
#!/bin/sh
if printf '%s\n' "\$@" | grep -q -- '-Pi'; then
  printf 'F I U Fr IUse%% M\n/dev/fake 100 $2 $((100-$2)) $2%% /\n'
else
  printf 'F B U A Cap M\n/dev/fake 100 $1 $((100-$1)) $1%% /\n'
fi
DFEOF
chmod +x "$WORK/bin/df"; }
capwith(){ mkdf "$1" "$2"; J=$(run "PATH=$WORK/bin:$PATH"); printf '%s' "$J"|dom CAPACITY; }
reset
[ "$(capwith 40 20)" = HEALTHY ]  && ok "disk 40% / inode 20% -> HEALTHY"  || no "capacity normal"
[ "$(capwith 80 20)" = WARNING ]  && ok "disk 80% (>=75) -> WARNING"       || no "capacity warning"
[ "$(capwith 94 20)" = CRITICAL ] && ok "disk 94% (>=92, the DISK-01 peak) -> CRITICAL" || no "capacity critical"
[ "$(capwith 40 78)" = WARNING ]  && ok "inode 78% (>=75) -> WARNING"      || no "inode warning"
[ "$(capwith 40 95)" = CRITICAL ] && ok "inode 95% (>=92) -> CRITICAL"     || no "inode critical"
rm -f "$WORK/bin/df"
reset; J=$(run "NEXORA_MON_DISK_PATHS=/definitely-not-a-mount-$SUF")
[ "$(printf '%s' "$J"|dom CAPACITY)" = UNKNOWN ] && ok "nonexistent mount -> UNKNOWN (not HEALTHY)" || no "missing mount"

# ============================ TLS =========================================
sec "TLS"
reset; J=$(run); t=$(printf '%s' "$J"|dom TLS)
[ "$t" = HEALTHY ] && ok "CA-signed long-lived cert, Nexora Internal Root CA issuer -> HEALTHY" || no "TLS long-lived gave $t"
reset; J=$(run "NEXORA_MON_TLS_HOST=127.0.0.1:$TLS_SOON_PORT")
[ "$(printf '%s' "$J"|dom TLS)" = CRITICAL ] && ok "cert <=14 days -> CRITICAL" || no "TLS near expiry"
reset; J=$(run "NEXORA_MON_TLS_HOST=127.0.0.1:$(( 32000 + RANDOM % 2000 ))")
[ "$(printf '%s' "$J"|dom TLS)" = CRITICAL ] && ok "TLS handshake failure -> CRITICAL" || no "TLS handshake"
reset; J=$(run "NEXORA_MON_TLS_HOST=127.0.0.1:$EDGE_PORT")
[ "$(printf '%s' "$J"|dom TLS)" = CRITICAL ] && ok "plaintext port presented as TLS -> CRITICAL" || no "TLS plaintext"

# ============================ AGENT_INGESTION =============================
sec "AGENT_INGESTION (systemic only)"
reset; J=$(run); [ "$(printf '%s' "$J"|dom AGENT_INGESTION)" = HEALTHY ] && ok "recent telemetry -> HEALTHY" || no "ingestion healthy"
reset; docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "UPDATE public.nexora_device_metrics SET received_at=now()-interval '20 minutes'" >/dev/null 2>&1
J=$(run); [ "$(printf '%s' "$J"|dom AGENT_INGESTION)" = WARNING ] && ok "agents online, telemetry 15-45 min stale -> WARNING" || no "ingestion warning"
docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "UPDATE public.nexora_device_metrics SET received_at=now()-interval '50 minutes'" >/dev/null 2>&1
J=$(run); [ "$(printf '%s' "$J"|dom AGENT_INGESTION)" = CRITICAL ] && ok "agents online, telemetry >45 min stale -> CRITICAL" || no "ingestion critical"
docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "UPDATE public.nexora_device_metrics SET received_at=now()" >/dev/null 2>&1
reset; docker exec "$PG" psql -q -U nexora_app -d nexora -c "DELETE FROM public.nexora_devices" >/dev/null 2>&1
J=$(run); [ "$(printf '%s' "$J"|dom AGENT_INGESTION)" = HEALTHY ] && ok "no devices enrolled -> HEALTHY (nothing to ingest)" || no "ingestion no devices"
docker exec "$PG" psql -q -U nexora_app -d nexora \
  -c "INSERT INTO public.nexora_devices(last_seen_at,hostname) SELECT now(),'dev-'||g FROM generate_series(1,3) g" >/dev/null 2>&1

# ============================ no false HEALTHY ============================
sec "no false HEALTHY on dependency failure"
reset; rm -f "$WORK/container-state.json" "$WORK/backup-state.json"
J=$(run "CREDENTIALS_DIRECTORY=$WORK/no-such-creds"); rc=$(lastrc)
ovr=$(printf '%s' "$J"|python3 -c 'import sys,json;print(json.load(sys.stdin)["overall"])' 2>/dev/null)
[ "$ovr" != HEALTHY ] && [ "$rc" -ne 0 ] && ok "every dependency missing -> overall $ovr, exit $rc (never HEALTHY/0)" \
                      || no "dependency failure reported HEALTHY"
printf '%s' "$J" | valid_json && ok "JSON remains valid with all dependencies missing" || no "JSON invalid on total failure"

# ============================ notification ================================
sec "notification (notify-local.sh -> notify.py)"
reset
grep -q 'notify.py' "$MON/notify-local.sh" && ok "notify-local.sh is a wrapper delegating to notify.py" || no "wrapper does not call notify.py"
SPOOL="$WORK/incidents.log"
out=$(NEXORA_NOTIFY_SPOOL="$SPOOL" CREDENTIALS_DIRECTORY="$WORK/no-creds" bash "$MON/notify-local.sh" 2>&1); nrc=$?
[ "$nrc" -eq 0 ] && ok "notify with no webhook configured -> exit 0" || no "notify no-webhook exit=$nrc"
python3 -c "
import json,sys
line=open('$SPOOL').readlines()[-1]
d=json.loads(line)
assert set(d)=={'time','message'} and isinstance(d['time'],int)
" 2>/dev/null && ok "spool line is well-formed JSON {time,message}" || no "spool line malformed"
grep -q 'Nexora platform health requires attention' "$SPOOL" && ok "incident message recorded in spool" || no "message missing from spool"

mkdir -p "$WORK/wcreds"
printf '{"url":"https://127.0.0.1:%s/hook"}' "$(( 34000 + RANDOM % 2000 ))" > "$WORK/wcreds/webhook"
before=$(wc -l < "$SPOOL")
out=$(NEXORA_NOTIFY_SPOOL="$SPOOL" CREDENTIALS_DIRECTORY="$WORK/wcreds" bash "$MON/notify-local.sh" 2>&1); nrc=$?
[ "$nrc" -ne 0 ] && ok "unreachable webhook -> non-zero exit (delivery failure surfaced)" || no "unreachable webhook exit 0"
[ "$(wc -l < "$SPOOL")" -gt "$before" ] && ok "spool still written when webhook delivery fails" || no "spool lost on webhook failure"
printf '{"url":"http://insecure.example/hook"}' > "$WORK/wcreds/webhook"
out=$(NEXORA_NOTIFY_SPOOL="$SPOOL" CREDENTIALS_DIRECTORY="$WORK/wcreds" bash "$MON/notify-local.sh" 2>&1); nrc=$?
[ "$nrc" -ne 0 ] && ok "non-https webhook URL rejected" || no "non-https webhook accepted"
printf '{"url":"https://example.test/%s"}' 'a"b' > "$WORK/wcreds/webhook"
out=$(NEXORA_NOTIFY_SPOOL="$SPOOL" CREDENTIALS_DIRECTORY="$WORK/wcreds" bash "$MON/notify-local.sh" 2>&1)
grep -qiE 'example\.test|url' <<<"$out" && no "notifier echoed the webhook URL to output" || ok "notifier never echoes webhook URL/credential"
grep -qE 'https?://' "$SPOOL" && no "webhook URL leaked into spool" || ok "no webhook URL in spool"

# ============================ leakage =====================================
sec "secret leakage"
reset; J=$(run)
if printf '%s' "$J" | grep -qiE 'JWT_SECRET|ADMIN_API_TOKEN|ENROLLMENT_SECRET|TELEGRAM_BOT_TOKEN|POSTGRES_PASSWORD|pgpass|'"$PGPW"; then
  no "health JSON leaked a secret name/value"
else ok "health JSON contains no secret names or values"; fi
leak=0
for f in "$MON"/*.sh "$MON"/*.py; do
  case "$f" in *test-platform-health*) continue ;; esac
  grep -qiE 'JWT_SECRET=|ADMIN_API_TOKEN=|ENROLLMENT_SECRET=' "$f" && leak=1
done
[ "$leak" -eq 0 ] && ok "monitoring source embeds no secrets" || no "monitoring source embeds a secret"

printf '\n================================================\n'
printf 'MONITORING_TESTS: pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
