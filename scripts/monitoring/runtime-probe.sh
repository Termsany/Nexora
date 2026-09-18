#!/usr/bin/env bash
# Runs only within the validation clone of the exact monitor service sandbox.
set -euo pipefail
source /opt/nexora-monitor/platform-health.sh
[ "$(id -un)" = nexora-monitor ]
[ "$(id -Gn)" = nexora-monitor ]
[ "$(awk '/^CapEff:/{print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^CapPrm:/{print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)" = 1 ]
for file in /run/docker.sock /var/run/docker.sock /etc/nexora/pki/server /etc/nexora-monitor/credentials/pgpass "${NEXORA_VALIDATE_APP_SECRET:?required}" "${NEXORA_VALIDATE_BACKUP_ROOT:?required}"; do
  [ ! -r "$file" ] && [ ! -w "$file" ]
done
[ -r "$CONTAINER_STATE" ] && [ ! -w "$CONTAINER_STATE" ]
[ -r "$BACKUP_STATE" ] && [ ! -w "$BACKUP_STATE" ]
[ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$CREDENTIALS_DIRECTORY/pgpass" ]
[ -w /var/lib/nexora-monitor ] && [ ! -w /opt/nexora-monitor ] && [ ! -w /etc/nexora-monitor ]
curl --silent --fail --max-time 10 "$BASE_URL/api/healthz" >/dev/null
check_tls
[ "${DOM_STATE[TLS]}" = HEALTHY ]
df -P / >/dev/null
[ "$(db_query 'SELECT 1')" = 1 ]
for view in migration_status worker_heartbeats ingestion_status; do
  db_query "SELECT * FROM nexora_monitoring.$view" >/dev/null
done
for table in nexora_devices nexora_worker_heartbeats; do
  if db_query "SELECT * FROM $table" >/dev/null; then exit 1; fi
done
# A backup WARNING (for example no remote copy) is not a syscall failure.
set +e
report=$(/bin/bash /opt/nexora-monitor/platform-health.sh --json-only)
code=$?
set -e
[ "$code" -le 3 ]
printf '%s' "$report" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert set(d["domains"]) == {"EDGE","API","DATABASE","WORKERS","BACKUP","CAPACITY","TLS","AGENT_INGESTION"}; assert all(v["state"] in {"HEALTHY","WARNING","CRITICAL","UNKNOWN"} for v in d["domains"].values())'
logger -t nexora-monitor-validation -- NEXORA_JOURNAL_PROBE_OK
printf '%s\n' NEXORA_RUNTIME_PROBE_OK
