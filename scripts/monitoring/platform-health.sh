#!/usr/bin/env bash
# Nexora platform self-monitoring (PR-06).
#
# Runs one pass over every platform health domain and emits a single JSON
# object plus a structured exit code. Designed to be driven by a systemd
# timer on the Nexora host (see scripts/monitoring/systemd/). It is NOT the
# external watcher — see scripts/monitoring/edge-watch.sh for the piece that
# must run on a different host.
#
# Domains: EDGE API DATABASE WORKERS BACKUP CAPACITY TLS AGENT_INGESTION
#
# Exit codes:
#   0  all domains HEALTHY
#   1  at least one WARNING, none CRITICAL
#   2  at least one CRITICAL
#   3  at least one UNKNOWN and no CRITICAL/WARNING
#
# No secret values are printed. DB access uses TCP and aggregate-only views.
#
# Usage:
#   scripts/monitoring/platform-health.sh [--json-only] [--state-dir DIR]
#
# Config via environment (all optional, sane local defaults):
#   NEXORA_MON_BASE_URL         default https://localhost
#   NEXORA_MON_TLS_HOST         default localhost:443  (host:port for the cert check)
#   NEXORA_MON_TLS_SERVERNAME   default nexora.design.local
#   NEXORA_MON_COMPOSE_PROJECT  default nexora
#   NEXORA_MON_BACKUP_STATE     default /run/nexora-monitor/backup-state.json
#   NEXORA_MON_DISK_PATHS       default "/" (safe mountpoints only)
#   NEXORA_MON_STATE_DIR        default ${XDG_STATE_HOME:-$HOME/.local/state}/nexora-monitoring

set -uo pipefail

BASE_URL="${NEXORA_MON_BASE_URL:-https://localhost}"
TLS_HOST="${NEXORA_MON_TLS_HOST:-localhost:443}"
TLS_SERVERNAME="${NEXORA_MON_TLS_SERVERNAME:-nexora.design.local}"
COMPOSE_PROJECT="${NEXORA_MON_COMPOSE_PROJECT:-nexora}"
CONTAINER_STATE="${NEXORA_MON_CONTAINER_STATE:-/run/nexora-monitor/container-state.json}"
BACKUP_STATE="${NEXORA_MON_BACKUP_STATE:-/run/nexora-monitor/backup-state.json}"
HELPER="$(dirname "${BASH_SOURCE[0]}")/metadata.py"
export PGPASSFILE="${CREDENTIALS_DIRECTORY:-/etc/nexora-monitor/credentials}/pgpass"
export PGCONNECT_TIMEOUT=5 PGOPTIONS='-c statement_timeout=5000 -c default_transaction_read_only=on -c row_security=off'
container_field() { python3 "$HELPER" container "$CONTAINER_STATE" "${COMPOSE_PROJECT}-$1-1" "$2" 2>/dev/null; }
db_query() {
  local host
  host=$(container_field postgres postgres_addr) || return 1
  [ -n "$host" ] && [ -r "$PGPASSFILE" ] || return 1
  timeout 8 "${NEXORA_MON_PSQL:-psql}" -X -w -h "$host" -p "${NEXORA_MON_PG_PORT:-5432}" -U nexora_monitor \
    -d "${NEXORA_MON_PG_DATABASE:-nexora}" -v ON_ERROR_STOP=1 -tA -F ' ' -c "$1" 2>/dev/null
}
DISK_PATHS="${NEXORA_MON_DISK_PATHS:-/}"
STATE_DIR="${NEXORA_MON_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/nexora-monitoring}"
JSON_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json-only) JSON_ONLY=1; shift ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done
STATE_WRITABLE=1
mkdir -p "$STATE_DIR" 2>/dev/null && [ -w "$STATE_DIR" ] || STATE_WRITABLE=0

# Thresholds ---------------------------------------------------------------
EDGE_WARN_FAILS=2 ; EDGE_CRIT_FAILS=3
DB_LATENCY_WARN_MS=250 ; DB_LATENCY_CRIT_MS=1500
WORKER_STALE_WARN_S=600 ; WORKER_STALE_CRIT_S=1800     # maint loop ~ minutes
BACKUP_WARN_H=24 ; BACKUP_CRIT_H=36
DISK_WARN=75 ; DISK_HIGH=85 ; DISK_CRIT=92
INODE_WARN=75 ; INODE_HIGH=85 ; INODE_CRIT=92
MEM_AVAIL_WARN_PCT=15 ; MEM_AVAIL_CRIT_PCT=7
SWAP_WARN_PCT=50 ; SWAP_CRIT_PCT=80
TLS_WARN_DAYS=45 ; TLS_HIGH_DAYS=30 ; TLS_CRIT_DAYS=14
INGEST_WARN_MIN=15 ; INGEST_CRIT_MIN=45

now_epoch=$(date -u +%s)
declare -A DOM_STATE DOM_DETAIL
set_dom() { DOM_STATE["$1"]="$2"; DOM_DETAIL["$1"]="$3"; }
worse() { # returns the more severe of two states
  local a="$1" b="$2"
  for s in CRITICAL WARNING UNKNOWN HEALTHY; do
    [ "$a" = "$s" ] || [ "$b" = "$s" ] && { echo "$s"; return; }
  done
  echo HEALTHY
}

# ---------------------------------------------------------------- EDGE ----
# Consecutive-failure logic persisted across runs so a single transient blip
# does not page. WARNING at 2 in a row, CRITICAL at 3.
edge_state_file="$STATE_DIR/edge-consecutive-failures"
edge_fail() { cat "$edge_state_file" 2>/dev/null || echo 0; }
check_edge() {
  local url="$BASE_URL/" code fails
  [ "$STATE_WRITABLE" = 1 ] || { set_dom EDGE CRITICAL "probe state unavailable"; return; }
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  local api_code
  api_code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE_URL/api/healthz" 2>/dev/null)
  if [ "$code" = 200 ] && [ "$api_code" = 200 ]; then
    echo 0 > "$edge_state_file" || { set_dom EDGE CRITICAL "probe state unwritable"; return; }
    set_dom EDGE HEALTHY "root=$code healthz=$api_code consecutive_failures=0"
    return
  fi
  fails=$(edge_fail)
  [[ "$fails" =~ ^[0-9]+$ ]] || { set_dom EDGE CRITICAL "invalid probe state"; return; }
  fails=$((fails + 1)); echo "$fails" > "$edge_state_file" || { set_dom EDGE CRITICAL "probe state unwritable"; return; }
  local why="root=$code healthz=$api_code"
  if [ "$fails" -ge "$EDGE_CRIT_FAILS" ]; then set_dom EDGE CRITICAL "$why consecutive_failures=$fails"
  elif [ "$fails" -ge "$EDGE_WARN_FAILS" ]; then set_dom EDGE WARNING "$why consecutive_failures=$fails"
  else set_dom EDGE UNKNOWN "$why consecutive_failures=$fails (below warn threshold)"; fi
}

# ----------------------------------------------------------------- API ----
# Distinct from EDGE: is the api *container* up and its own healthcheck green.
check_api() {
  local st hc
  st=$(container_field api status) || { set_dom API CRITICAL "container projection unavailable or stale"; return; }
  hc=$(container_field api health)
  local rc
  rc=$(container_field api restart_count)
  if [ "$st" != running ]; then set_dom API CRITICAL "container status=$st"
  elif [ "$hc" = unhealthy ]; then set_dom API CRITICAL "container healthcheck=unhealthy restarts=$rc"
  elif [ "$hc" != healthy ] || [ "${rc:-0}" -ge 3 ]; then set_dom API WARNING "healthcheck=$hc restarts=$rc"
  else set_dom API HEALTHY "status=$st healthcheck=$hc restarts=$rc"; fi
}

# ------------------------------------------------------------ DATABASE ----
check_database() {
  local start end lat_ms out mig
  start=$(date +%s%3N)
  out=$(db_query 'SELECT 1')
  local ec=$?
  end=$(date +%s%3N); lat_ms=$((end - start))
  if [ $ec -ne 0 ] || [ "$out" != 1 ]; then set_dom DATABASE CRITICAL "SELECT 1 failed (exit $ec)"; return; fi
  mig=$(db_query 'SELECT migration_count FROM nexora_monitoring.migration_status')
  if ! [[ "$mig" =~ ^[0-9]+$ ]]; then set_dom DATABASE CRITICAL "migration metadata unreadable"; return; fi
  local s="HEALTHY"
  [ "$lat_ms" -ge "$DB_LATENCY_WARN_MS" ] && s="WARNING"
  [ "$lat_ms" -ge "$DB_LATENCY_CRIT_MS" ] && s="CRITICAL"
  set_dom DATABASE "$s" "reachable latency_ms=$lat_ms migrations=$mig"
}

# ------------------------------------------------------------- WORKERS ----
check_workers() {
  local overall=HEALTHY details=()
  for w in maintenance notification-worker; do
    local cst last age
    cst=$(container_field "$w" status)
    last=$(db_query "SELECT last_seen_epoch FROM nexora_monitoring.worker_heartbeats WHERE worker='$w'")
    if [ "$cst" != running ]; then overall=$(worse "$overall" CRITICAL); details+=("${w}:container=${cst:-missing}"); continue; fi
    if ! [[ "$last" =~ ^[0-9]+$ ]]; then
      # notification-worker only heartbeats when it has work; treat missing as UNKNOWN not CRITICAL
      overall=$(worse "$overall" UNKNOWN); details+=("${w}:no_heartbeat_row(container=running)"); continue
    fi
    age=$((now_epoch - last)); [ "$age" -lt 0 ] && age=0
    if [ "$age" -ge "$WORKER_STALE_CRIT_S" ]; then overall=$(worse "$overall" CRITICAL); details+=("${w}:stale_${age}s")
    elif [ "$age" -ge "$WORKER_STALE_WARN_S" ]; then overall=$(worse "$overall" WARNING); details+=("${w}:stale_${age}s")
    else details+=("${w}:ok_${age}s"); fi
  done
  set_dom WORKERS "$overall" "${details[*]}"
}

# -------------------------------------------------------------- BACKUP ----
check_backup() {
  local metadata last_epoch csum enc off age_h
  metadata=$(python3 "$HELPER" backup "$BACKUP_STATE" 2>/dev/null) || { set_dom BACKUP CRITICAL "backup metadata unavailable or stale"; return; }
  read -r last_epoch csum enc off <<< "$metadata"
  age_h=$(( (now_epoch - last_epoch) / 3600 ))
  local s=HEALTHY
  if [ "$last_epoch" -le 0 ] || [ "$last_epoch" -gt "$now_epoch" ]; then s=CRITICAL; fi
  [ "$age_h" -ge "$BACKUP_WARN_H" ] && s=$(worse "$s" WARNING)
  [ "$age_h" -ge "$BACKUP_CRIT_H" ] && s=$(worse "$s" CRITICAL)
  if [ "$csum" != 1 ] || [ "$enc" != 1 ]; then s=CRITICAL; fi
  [ "$off" != 1 ] && s=$(worse "$s" WARNING)
  set_dom BACKUP "$s" "age_h=$age_h checksum_ok=$csum encrypted=$enc off_host_ok=$off"
}

# ------------------------------------------------------------ CAPACITY ----
check_capacity() {
  local overall=HEALTHY details=()
  for p in $DISK_PATHS; do
    [ -e "$p" ] || { overall=$(worse "$overall" UNKNOWN); continue; }
    local usep inodep
    usep=$(df -P "$p" | awk 'NR==2{gsub(/%/,"",$5); print $5}')
    inodep=$(df -Pi "$p" | awk 'NR==2{gsub(/%/,"",$5); print $5}')
    if ! [[ "$usep" =~ ^[0-9]+$ && "$inodep" =~ ^[0-9]+$ ]]; then
      overall=$(worse "$overall" UNKNOWN); continue
    fi
    local ds=HEALTHY
    [ "${usep:-0}" -ge "$DISK_WARN" ] && ds=WARNING
    [ "${usep:-0}" -ge "$DISK_HIGH" ] && ds=WARNING
    [ "${usep:-0}" -ge "$DISK_CRIT" ] && ds=CRITICAL
    [ "${inodep:-0}" -ge "$INODE_WARN" ] && ds=$(worse "$ds" WARNING)
    [ "${inodep:-0}" -ge "$INODE_HIGH" ] && ds=$(worse "$ds" WARNING)
    [ "${inodep:-0}" -ge "$INODE_CRIT" ] && ds=$(worse "$ds" CRITICAL)
    overall=$(worse "$overall" "$ds")
    details+=("${p}:disk=${usep}% inode=${inodep}%")
  done
  # memory + swap (available-aware, never bare "used")
  local mt ma st su
  mt=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  ma=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  st=$(awk '/SwapTotal/{print $2}' /proc/meminfo)
  su=$(( $(awk '/SwapTotal/{print $2}' /proc/meminfo) - $(awk '/SwapFree/{print $2}' /proc/meminfo) ))
  if ! [[ "$mt" =~ ^[1-9][0-9]*$ && "$ma" =~ ^[0-9]+$ ]]; then
    set_dom CAPACITY UNKNOWN "memory metadata unavailable"; return
  fi
  local mem_avail_pct=$(( ma * 100 / mt ))
  local swap_pct=0; [ "${st:-0}" -gt 0 ] && swap_pct=$(( su * 100 / st ))
  local ms=HEALTHY
  [ "$mem_avail_pct" -le "$MEM_AVAIL_WARN_PCT" ] && ms=WARNING
  [ "$mem_avail_pct" -le "$MEM_AVAIL_CRIT_PCT" ] && ms=CRITICAL
  [ "$swap_pct" -ge "$SWAP_WARN_PCT" ] && ms=$(worse "$ms" WARNING)
  [ "$swap_pct" -ge "$SWAP_CRIT_PCT" ] && ms=$(worse "$ms" CRITICAL)
  overall=$(worse "$overall" "$ms")
  details+=("mem_available=${mem_avail_pct}% swap_used=${swap_pct}%")
  set_dom CAPACITY "$overall" "${details[*]}"
}

# ----------------------------------------------------------------- TLS ----
check_tls() {
  local host="${TLS_HOST%%:*}" port="${TLS_HOST##*:}" pem end_epoch days subj issuer
  pem=$(timeout 10 openssl s_client -verify_return_error -verify_hostname "$TLS_SERVERNAME" -connect "$host:$port" -servername "$TLS_SERVERNAME" 2>/dev/null </dev/null) || { set_dom TLS CRITICAL "TLS verification failed"; return; }
  [ -n "$pem" ] || { set_dom TLS CRITICAL "TLS handshake to $TLS_HOST failed"; return; }
  local notafter
  notafter=$(printf '%s' "$pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  subj=$(printf '%s' "$pem" | openssl x509 -noout -subject 2>/dev/null | sed 's/^subject= *//')
  issuer=$(printf '%s' "$pem" | openssl x509 -noout -issuer 2>/dev/null | sed 's/^issuer= *//')
  [ -n "$notafter" ] || { set_dom TLS UNKNOWN "could not parse certificate"; return; }
  end_epoch=$(date -u -d "$notafter" +%s 2>/dev/null || echo 0)
  days=$(( (end_epoch - now_epoch) / 86400 ))
  local s=HEALTHY
  [ "$days" -le "$TLS_WARN_DAYS" ] && s=WARNING
  [ "$days" -le "$TLS_HIGH_DAYS" ] && s=WARNING
  [ "$days" -le "$TLS_CRIT_DAYS" ] && s=CRITICAL
  case "$issuer" in *"Nexora Internal Root CA"*) : ;; *) s=$(worse "$s" WARNING) ;; esac
  set_dom TLS "$s" "days_remaining=$days subject_cn=$(echo "$subj" | grep -oE 'CN *= *[^,]+' | head -1) issuer_ok=$(case "$issuer" in *'Nexora Internal Root CA'*) echo yes;; *) echo no;; esac)"
}

# ------------------------------------------------------- AGENT_INGESTION --
# Systemic signal only. NOT per-device (DEVICE_OFFLINE covers that). We look
# for fleet-wide silence: agents exist and recently, but ingestion stopped.
check_ingestion() {
  local online total last_metric_min last_inv_min
  read -r total online last_metric_min last_inv_min < <(db_query 'SELECT total, online, last_metric_min, last_inv_min FROM nexora_monitoring.ingestion_status')
  [[ "$total" =~ ^[0-9]+$ ]] || { set_dom AGENT_INGESTION UNKNOWN "ingestion query failed"; return; }
  if [ "$total" -eq 0 ]; then set_dom AGENT_INGESTION HEALTHY "no devices enrolled yet (nothing to ingest)"; return; fi
  local s=HEALTHY why="devices=$total online=$online last_metric_min=$last_metric_min last_inventory_min=$last_inv_min"
  # Only flag systemic silence: at least one agent online but global ingestion gap.
  if [ "${online:-0}" -ge 1 ] && [ "$last_metric_min" -ge "$INGEST_CRIT_MIN" ]; then s=CRITICAL
  elif [ "${online:-0}" -ge 1 ] && [ "$last_metric_min" -ge "$INGEST_WARN_MIN" ]; then s=WARNING
  elif [ "$last_metric_min" -lt 0 ]; then s=UNKNOWN; why="$why (no telemetry ever)"; fi
  set_dom AGENT_INGESTION "$s" "$why"
}

# ------------------------------------------------------------------ run ---
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0
check_edge
check_api
check_database
check_workers
check_backup
check_capacity
check_tls
check_ingestion

overall=HEALTHY
for d in EDGE API DATABASE WORKERS BACKUP CAPACITY TLS AGENT_INGESTION; do
  overall=$(worse "$overall" "${DOM_STATE[$d]:-UNKNOWN}")
done

# JSON out (no secrets: only states, ages, percentages, counts)
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
printf '{'
printf '"generated_at":"%s","overall":"%s","domains":{' "$(date -u +%FT%TZ)" "$overall"
first=1
for d in EDGE API DATABASE WORKERS BACKUP CAPACITY TLS AGENT_INGESTION; do
  [ $first = 1 ] || printf ','
  first=0
  printf '"%s":{"state":"%s","detail":"%s"}' "$d" "${DOM_STATE[$d]:-UNKNOWN}" "$(esc "${DOM_DETAIL[$d]:-}")"
done
printf '}}\n'

if [ "$JSON_ONLY" != 1 ]; then
  for d in EDGE API DATABASE WORKERS BACKUP CAPACITY TLS AGENT_INGESTION; do
    printf '%-16s %-9s %s\n' "$d" "${DOM_STATE[$d]:-UNKNOWN}" "${DOM_DETAIL[$d]:-}" >&2
  done
  printf '%-16s %-9s\n' OVERALL "$overall" >&2
fi

case "$overall" in
  HEALTHY) exit 0 ;;
  WARNING) exit 1 ;;
  CRITICAL) exit 2 ;;
  *) exit 3 ;;
esac
