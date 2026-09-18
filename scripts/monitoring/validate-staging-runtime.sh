#!/usr/bin/env bash
# Operator-only; does not start installed timers or unmask installed units.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$here/staging-guard.sh"
[ "$#" -eq 2 ] || { echo 'usage: validate-staging-runtime.sh staging EXACT_HOSTNAME' >&2; exit 64; }
staging_guard "$1" "$2"
getent passwd nexora-monitor >/dev/null
[ "$(id -u nexora-monitor)" -ne 0 ]
[ "$(id -g nexora-monitor)" -ne 0 ]
[ "$(id -Gn nexora-monitor)" = nexora-monitor ]
[ -z "$(getent group nexora-monitor | cut -d: -f4)" ]
[ "$(getent passwd | awk -F: -v uid="$(id -u nexora-monitor)" '$3 == uid {n++} END {print n+0}')" = 1 ]
[ "$(getent passwd nexora-monitor | cut -d: -f7)" = /usr/sbin/nologin ]
command -v sudo >/dev/null
sudo -n -l -U root >/dev/null 2>&1 || { echo 'Cannot verify sudo policy' >&2; exit 1; }
if sudo -n -l -U nexora-monitor >/dev/null 2>&1; then
  echo 'FAIL: monitor has sudo authority' >&2; exit 1
fi
# Operator must name actual, existing secret/backup locations so absence cannot
# falsely pass the sandbox access checks. This config contains paths, not secrets.
config=/etc/nexora-monitor/runtime-validation.conf
[ ! -L "$config" ] && [ "$(stat -c '%u:%a' "$config")" = 0:600 ]
source "$config"
[ -e "${NEXORA_VALIDATE_APP_SECRET:?required}" ] && [ -d "${NEXORA_VALIDATE_BACKUP_ROOT:?required}" ]
[ -e /etc/nexora/pki/server ] && [ -e /run/docker.sock ]
for path in "$NEXORA_VALIDATE_APP_SECRET" "$NEXORA_VALIDATE_BACKUP_ROOT" /etc/nexora/pki/server /run/docker.sock /etc/nexora-monitor/credentials/pgpass; do
  if runuser -u nexora-monitor -- test -r "$path"; then echo 'FAIL: identity can read protected path' >&2; exit 1; fi
  if runuser -u nexora-monitor -- test -w "$path"; then echo 'FAIL: identity can write protected path' >&2; exit 1; fi
done
for path in /run/nexora-monitor/container-state.json /run/nexora-monitor/backup-state.json; do
  runuser -u nexora-monitor -- test -r "$path"
  if runuser -u nexora-monitor -- test -w "$path"; then exit 1; fi
done
unit="nexora-monitor-validation-$$.service"
cmp -- "$here/systemd/nexora-platform-health.service" /usr/local/lib/systemd/system/nexora-platform-health.service
target="/run/systemd/system/$unit"
[ ! -e "$target" ] && [ ! -L "$target" ]
cleanup() {
  systemctl stop "$unit" >/dev/null 2>&1 || true
  rm -f -- "$target"
  systemctl daemon-reload
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sed -e '/^OnFailure=/d' -e 's#^ExecStart=.*#ExecStart=/bin/bash /opt/nexora-monitor/runtime-probe.sh#' \
  /usr/local/lib/systemd/system/nexora-platform-health.service > "$target"
printf '\nEnvironmentFile=%s\n' "$config" >> "$target"
systemctl daemon-reload
for property in NoNewPrivileges PrivateTmp PrivateDevices RestrictNamespaces RestrictSUIDSGID LockPersonality; do
  value=$(systemctl show "$unit" -p "$property" --value)
  case "$property:$value" in RestrictNamespaces:no|*:yes) :;; *) echo "FAIL: $property" >&2; exit 1;; esac
done
for expected in ProtectSystem:strict ProtectHome:yes ProtectProc:invisible ProcSubset:all User:nexora-monitor Group:nexora-monitor; do
  [ "$(systemctl show "$unit" -p "${expected%%:*}" --value)" = "${expected#*:}" ]
done
[ -z "$(systemctl show "$unit" -p CapabilityBoundingSet --value)" ]
[ -z "$(systemctl show "$unit" -p AmbientCapabilities --value)" ]
[ -n "$(systemctl show "$unit" -p SystemCallFilter --value)" ]
systemctl start "$unit"
[ "$(systemctl show "$unit" -p Result --value)" = success ]
invocation=$(systemctl show "$unit" -p InvocationID --value)
[ -n "$invocation" ]
journal=$(journalctl --quiet --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation")
grep -Fxq NEXORA_JOURNAL_PROBE_OK <<< "$journal"
grep -Fxq NEXORA_RUNTIME_PROBE_OK <<< "$journal"
# The probe emits only these two markers; never print raw journal or secrets.
[ -z "$(grep -Ev '^(NEXORA_JOURNAL_PROBE_OK|NEXORA_RUNTIME_PROBE_OK)$' <<< "$journal")" ]
echo 'V2_JOURNAL=PASS V4_SYSCALL_FILTER=PASS SYSTEMD_SANDBOX_RUNTIME=PASS'
