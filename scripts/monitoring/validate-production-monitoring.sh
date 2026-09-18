#!/usr/bin/env bash
# READ-ONLY validation of a Production self-monitoring install. Mutates
# nothing, needs no approval phrase, safe to run at any time - including
# before anything is installed, where it reports what is still missing.
#
# Exit: 0 ready to proceed, 1 not ready.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$here/production-guard.sh"

pass=0; fail=0; warn=0
ok(){ printf '  [ PASS ] %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }
wa(){ printf '  [ WARN ] %s\n' "$1"; warn=$((warn+1)); }

printf '\nNexora production monitoring validation - %s\n' "$(date -u +%FT%TZ)"

printf '\n[1] Production identity\n'
production_guard >/dev/null 2>&1 && ok "production_guard identity verified" || no "production_guard refuses this host"

printf '\n[2] Monitoring identities are unprivileged\n'
for a in nexora-monitor nexora-notify; do
  if id "$a" >/dev/null 2>&1; then
    [ "$(getent passwd "$a" | cut -d: -f7)" = /usr/sbin/nologin ] && ok "$a has nologin shell" || no "$a shell is not nologin"
    id -nG "$a" | tr ' ' '\n' | grep -qx docker && no "$a is in the docker group" || ok "$a is NOT in the docker group"
    sudo -n -l -U "$a" >/dev/null 2>&1 && no "$a has sudo rights" || ok "$a has no sudo rights"
  else no "$a does not exist"; fi
done

printf '\n[3] Monitor cannot reach privileged material\n'
for p in /var/run/docker.sock /etc/nexora/pki/server /home/mustafa/.nexora-backups; do
  if [ -e "$p" ]; then
    sudo -n -u nexora-monitor test -r "$p" 2>/dev/null && no "nexora-monitor can read $p" || ok "nexora-monitor cannot read $p"
  else wa "$p not present on this host"; fi
done

printf '\n[4] DB least privilege\n'
PGC="${NEXORA_PROD_PG:-nexora-postgres-1}"
q(){ docker exec "$PGC" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$1\"" 2>/dev/null; }
if [ "$(q "SELECT count(*) FROM pg_roles WHERE rolname='nexora_monitor'")" = 1 ]; then
  a=$(q "SELECT rolsuper::text||rolcreatedb::text||rolcreaterole::text||rolreplication::text||rolbypassrls::text FROM pg_roles WHERE rolname='nexora_monitor'")
  [ "$a" = "falsefalsefalsefalsefalse" ] && ok "nexora_monitor NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS" \
                                         || no "nexora_monitor privilege flags wrong ($a)"
  [ "$(q "SELECT pg_has_role('nexora_monitor','pg_monitor','MEMBER')")" = f ] && ok "not a pg_monitor member" || no "is a pg_monitor member"
  leak=0
  for t in nexora_devices nexora_users nexora_organizations nexora_audit_log nexora_device_metrics; do
    [ "$(q "SELECT has_any_column_privilege('nexora_monitor','public.$t','SELECT')")" = t ] && { no "can read base table $t"; leak=1; }
  done
  [ "$leak" -eq 0 ] && ok "no base-table (customer/PII) SELECT"
  [ "$(q "SELECT count(*) FROM information_schema.views WHERE table_schema='nexora_monitoring'")" -ge 3 ] \
    && ok "nexora_monitoring aggregate views present" || no "monitoring views missing"
else wa "nexora_monitor role not created yet (expected before P3)"; fi

printf '\n[5] Units installed but inert\n'
any=0
for u in nexora-container-state nexora-backup-verifier nexora-platform-health nexora-platform-notify; do
  for e in service timer; do
    f="/usr/local/lib/systemd/system/$u.$e"; [ -f "$f" ] || continue; any=1
    st=$(systemctl is-enabled "$u.$e" 2>/dev/null || echo unknown)
    case "$st" in masked) ok "$u.$e installed and MASKED" ;;
                  enabled*) no "$u.$e is ENABLED (timers must not auto-start before validation)" ;;
                  *) wa "$u.$e state=$st" ;; esac
    systemctl is-active --quiet "$u.$e" && no "$u.$e is ACTIVE" || true
  done
done
[ "$any" -eq 1 ] || wa "no monitoring units installed yet (expected before P7)"

printf '\n[6] Publisher projection is sanitized\n'
CS=/run/nexora-monitor/container-state.json
if [ -f "$CS" ]; then
  python3 -c "
import json,sys
rows=json.load(open('$CS'))
F={'name','exists','status','health','restart_count','postgres_addr'}
sys.exit(0 if all(set(r)==F for r in rows) else 1)" \
    && ok "container-state.json exposes only the 6 permitted fields" || no "container-state.json has unexpected fields"
  grep -qiE 'JWT_SECRET|ADMIN_API_TOKEN|ENROLLMENT_SECRET|TELEGRAM_BOT_TOKEN|POSTGRES_PASSWORD|"Env"|"Mounts"|"HostConfig"' "$CS" \
    && no "projection carries secret-bearing inspect data" || ok "projection carries no secrets or raw inspect fields"
else wa "container-state.json not published yet (expected before P4)"; fi

printf '\n[7] Production application untouched\n'
curl -sk -o /dev/null -w '' https://localhost/ 2>/dev/null
[ "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/ 2>/dev/null)" = 200 ] && ok "HTTPS 200" || no "HTTPS not 200"
[ "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/healthz 2>/dev/null)" = 200 ] && ok "/api/healthz 200" || no "/api/healthz not 200"
m=$(q "SELECT count(*) FROM drizzle.__drizzle_migrations")
[ "$m" = "${NEXORA_EXPECTED_MIGRATIONS:-13}" ] && ok "migration count unchanged ($m)" || no "migration count is $m"

printf '\n---\npass=%d fail=%d warn=%d\n' "$pass" "$fail" "$warn"
[ "$fail" -eq 0 ]
