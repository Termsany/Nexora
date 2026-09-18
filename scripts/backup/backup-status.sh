#!/usr/bin/env bash
# Nexora backup health status (PR-04A).
#
# Usage: scripts/backup/backup-status.sh <backup-root>
#
# Reads the machine-readable state written by postgres-backup.sh
# (backup-state.json), offhost-copy.sh output, and restore-test records, and
# emits a single JSON status line plus a human summary to stderr. Does not
# perform any alerting itself - documents the thresholds an alerting system
# should apply.
#
# Alert thresholds (documented here, not wired up in PR-04A):
#   - backup_age_hours > 26         -> ALERT (RPO is <=24h; 26h gives margin
#                                       for a single missed nightly run before
#                                       paging)
#   - last backup status != success -> ALERT immediately
#   - off_host_copy_status != success (or missing) -> ALERT
#   - restore_last_tested_days > 30 -> ALERT (restore verification going
#                                       stale is itself a finding)

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

backup_root="${1:-}"
[ -n "$backup_root" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "usage: backup-status.sh <backup-root>"
[ -d "$backup_root" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "backup root does not exist: $backup_root"
resolved_root="$(cd "$backup_root" && pwd)"

state_file="${resolved_root}/backup-state.json"
offhost_state_file="${resolved_root}/offhost-state.json"
restore_test_file="${resolved_root}/restore-test-state.json"

json_get() { # json_get <file> <key> -> value or empty
  [ -f "$1" ] || { echo ""; return; }
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null | head -1 | sed -E 's/.*: *"([^"]*)"/\1/'
}

last_success="$(json_get "$state_file" last_success)"
last_backup_file="$(json_get "$state_file" last_backup_file)"
size_bytes="$(grep -o '"size_bytes"[[:space:]]*:[[:space:]]*[0-9]*' "$state_file" 2>/dev/null | grep -o '[0-9]*$' || true)"

now_epoch="$(date -u +%s)"
if [ -n "$last_success" ]; then
  last_epoch="$(date -u -d "$last_success" +%s 2>/dev/null || echo 0)"
  age_hours=$(( (now_epoch - last_epoch) / 3600 ))
else
  age_hours=-1
fi

checksum_status="unknown"
if [ -n "$last_backup_file" ] && [ -f "${resolved_root}/${last_backup_file}" ] && [ -f "${resolved_root}/${last_backup_file}.sha256" ]; then
  expected="$(awk '{print $1}' "${resolved_root}/${last_backup_file}.sha256")"
  actual="$(backup_sha256 "${resolved_root}/${last_backup_file}")"
  [ "$expected" = "$actual" ] && checksum_status="ok" || checksum_status="mismatch"
fi

encryption_status="unknown"
case "$last_backup_file" in
  *.gpg) encryption_status="encrypted" ;;
  "") encryption_status="no_backup_yet" ;;
  *) encryption_status="not_encrypted" ;;
esac

offhost_status="$(json_get "$offhost_state_file" status)"
[ -n "$offhost_status" ] || offhost_status="unknown"

restore_tested_at="$(json_get "$restore_test_file" tested_at)"
restore_status="$(json_get "$restore_test_file" status)"
if [ -n "$restore_tested_at" ]; then
  restore_epoch="$(date -u -d "$restore_tested_at" +%s 2>/dev/null || echo 0)"
  restore_age_days=$(( (now_epoch - restore_epoch) / 86400 ))
else
  restore_age_days=-1
fi

alerts=()
if [ "$age_hours" -gt 26 ]; then alerts+=("backup_age_exceeds_26h"); fi
if [ "$age_hours" -eq -1 ]; then alerts+=("no_successful_backup_recorded"); fi
if [ "$checksum_status" = "mismatch" ]; then alerts+=("checksum_mismatch"); fi
if [ "$offhost_status" != "success" ]; then alerts+=("offhost_copy_not_confirmed"); fi
if [ "$restore_age_days" -gt 30 ] || [ "$restore_age_days" -eq -1 ]; then alerts+=("restore_verification_stale_or_missing"); fi

alerts_joined="$(IFS=,; echo "${alerts[*]:-}")"

backup_json_status \
  last_success="${last_success:-none}" \
  last_backup_file="${last_backup_file:-none}" \
  backup_age_hours="$age_hours" \
  backup_size_bytes="${size_bytes:-0}" \
  checksum_status="$checksum_status" \
  encryption_status="$encryption_status" \
  off_host_copy_status="$offhost_status" \
  restore_last_tested="${restore_tested_at:-never}" \
  restore_last_status="${restore_status:-unknown}" \
  alerts="${alerts_joined:-none}"

exit "$NEXORA_BACKUP_EXIT_OK"
