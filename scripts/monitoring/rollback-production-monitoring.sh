#!/usr/bin/env bash
# Conservative rollback of the Production self-monitoring install.
#
# Removes ONLY what the monitoring installer added. It never touches the
# Nexora application, its containers, its database contents, customer data,
# or the existing backup workflow - and never restarts a Production service.
#
# Default is a DRY RUN. --apply performs removal and additionally requires the
# same explicit operator approval phrase the installer requires.
#
#   bash scripts/monitoring/rollback-production-monitoring.sh            # dry run
#   sudo NEXORA_PRODUCTION_DEPLOY_APPROVED='...' \
#     bash scripts/monitoring/rollback-production-monitoring.sh --apply
#
# Database objects are NOT dropped by default: dropping a role/schema is the
# one step that can fail loudly if something unexpectedly depends on it. Pass
# --drop-db-objects to include them (still additive-only reversal: it drops
# nexora_monitoring views/schema and the nexora_monitor role, nothing else).
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$here/production-guard.sh"

APPLY=0; DROP_DB=0
for a in "$@"; do case "$a" in
  --apply) APPLY=1 ;; --drop-db-objects) DROP_DB=1 ;;
  *) echo "unknown argument: $a" >&2; exit 64 ;;
esac; done

production_guard || exit 1
if [ "$APPLY" = 1 ]; then
  production_deploy_approved "monitoring rollback" || exit 1
else
  printf '\n*** DRY RUN - nothing will be changed. Re-run with --apply to act. ***\n'
fi
run(){ if [ "$APPLY" = 1 ]; then "$@"; else printf '  would run: %s\n' "$*"; fi; }

UNITS="nexora-container-state nexora-backup-verifier nexora-platform-health nexora-platform-notify nexora-edge-watch"

printf '\n[1] Stop and disable timers, then services\n'
for u in $UNITS; do
  for e in timer service; do
    systemctl list-unit-files "$u.$e" >/dev/null 2>&1 || continue
    systemctl is-active --quiet "$u.$e" && run systemctl stop "$u.$e"
    case "$(systemctl is-enabled "$u.$e" 2>/dev/null || true)" in
      enabled*) run systemctl disable "$u.$e" ;;
    esac
  done
done

printf '\n[2] Mask, then remove unit files\n'
for u in $UNITS; do
  for e in service timer; do
    f="/usr/local/lib/systemd/system/$u.$e"
    [ -e "$f" ] || continue
    run systemctl mask "$u.$e"
    run rm -f "$f"
  done
done
run systemctl daemon-reload
run systemctl reset-failed

printf '\n[3] Remove monitoring filesystem artifacts (application paths untouched)\n'
for p in /opt/nexora-monitor /run/nexora-monitor /var/lib/nexora-monitor \
         /var/log/nexora-monitor /etc/nexora-monitor /etc/nexora-notify; do
  [ -e "$p" ] || continue
  case "$p" in
    /opt/nexora-monitor|/run/nexora-monitor|/var/lib/nexora-monitor|/var/log/nexora-monitor|/etc/nexora-monitor|/etc/nexora-notify) ;;
    *) echo "  refusing unexpected path: $p" >&2; continue ;;
  esac
  run rm -rf --one-file-system "$p"
done
echo "  NOT touched: /home/mustafa/.nexora-backups (existing backup workflow)"
echo "  NOT touched: /etc/nexora, /etc/nexora-environment, application data"

printf '\n[4] Database monitoring objects\n'
if [ "$DROP_DB" = 1 ]; then
  PGC="${NEXORA_PROD_PG:-nexora-postgres-1}"
  # Only monitoring-owned objects. No application table, row, grant or
  # migration is referenced anywhere in this statement.
  SQL="BEGIN;
DROP VIEW IF EXISTS nexora_monitoring.ingestion_status, nexora_monitoring.worker_heartbeats, nexora_monitoring.migration_status;
DROP SCHEMA IF EXISTS nexora_monitoring CASCADE;
REASSIGN OWNED BY nexora_monitor_view_owner TO CURRENT_USER;
DROP OWNED BY nexora_monitor_view_owner;
DROP OWNED BY nexora_monitor;
DROP ROLE IF EXISTS nexora_monitor;
DROP ROLE IF EXISTS nexora_monitor_view_owner;
COMMIT;"
  if [ "$APPLY" = 1 ]; then
    printf '%s' "$SQL" | docker exec -i "$PGC" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -f -'
  else
    printf '  would apply (monitoring objects only, no application object referenced):\n%s\n' "$SQL" | sed 's/^/    /'
  fi
else
  echo "  skipped (pass --drop-db-objects to include). The nexora_monitor role is"
  echo "  read-only and harmless if left in place; removing units already stops all use."
fi

printf '\n[5] OS identities\n'
for a in nexora-monitor nexora-notify; do
  id "$a" >/dev/null 2>&1 || continue
  run userdel "$a"
  getent group "$a" >/dev/null && run groupdel "$a"
done

printf '\n[6] Verify Production is untouched\n'
printf '  https_root=%s api_healthz=%s\n' \
  "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/ 2>/dev/null)" \
  "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/healthz 2>/dev/null)"
docker inspect nexora-postgres-1 --format '  postgres id={{slice .Id 0 12}} started={{.State.StartedAt}} restarts={{.RestartCount}}' 2>/dev/null

printf '\nRollback %s.\n' "$([ "$APPLY" = 1 ] && echo complete || echo 'DRY RUN complete - nothing changed')"
