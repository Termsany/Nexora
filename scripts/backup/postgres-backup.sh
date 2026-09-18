#!/usr/bin/env bash
# Nexora Postgres backup (PR-04A).
#
# Usage:
#   scripts/backup/postgres-backup.sh <disposable|development|staging> \
#     --pg-host HOST --pg-port PORT --pg-db DB --pg-user USER \
#     --backup-root DIR --gpg-recipient KEYFILE_OR_ID \
#     [--pg-password-file FILE] [--dry-run] [--skip-retention] [--pg-image IMAGE]
#
# Never accepts "production" or "nexora" as the environment (see
# scripts/backup/lib/common.sh: backup_env_validate). Production backup is
# PR-04B, with its own approval gate.
#
# Pipeline: pg_dump -Fc (via a disposable postgres:16-alpine client container,
# so this host needs no local pg_dump) -> temp file -> atomic rename ->
# SHA-256 checksum sidecar -> chmod 600 -> gpg encrypt -> retention.
#
# Exit codes: see scripts/backup/lib/common.sh and docs/backup-restore.md.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

env_arg="${1:-}"
shift || true
NEXORA_BACKUP_ENV="$(backup_env_validate_for_backup "$env_arg")"

pg_host="" pg_port="" pg_db="" pg_user=""
backup_root="" gpg_recipient="" pg_password_file=""
dry_run=0 skip_retention=0
pg_image="postgres:16-alpine"

while [ $# -gt 0 ]; do
  case "$1" in
    --pg-host) pg_host="$2"; shift 2 ;;
    --pg-port) pg_port="$2"; shift 2 ;;
    --pg-db) pg_db="$2"; shift 2 ;;
    --pg-user) pg_user="$2"; shift 2 ;;
    --backup-root) backup_root="$2"; shift 2 ;;
    --gpg-recipient) gpg_recipient="$2"; shift 2 ;;
    --pg-password-file) pg_password_file="$2"; shift 2 ;;
    --pg-image) pg_image="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --skip-retention) skip_retention=1; shift ;;
    *) backup_die "$NEXORA_BACKUP_EXIT_USAGE" "unknown argument: $1" ;;
  esac
done

for req in pg_host pg_port pg_db pg_user backup_root gpg_recipient; do
  [ -n "${!req}" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "--${req//_/-} is required."
done

# --------------------------------------------------------------------------
# Guards: identity + path safety, before touching anything
# --------------------------------------------------------------------------
# The production identity guard exists to catch a NON-production run that
# accidentally points at production (a stray --pg-host/--pg-db value). A run
# that has already passed backup_require_production_backup_approval is
# deliberately targeting production, so this check is skipped only in that
# one case - it does not apply to --backup-root, which must never name a
# production identity regardless of environment.
if [ "$NEXORA_BACKUP_ENV" != "production" ]; then
  backup_assert_no_production_identity "--pg-host" "$pg_host"
  backup_assert_no_production_identity "--pg-db" "$pg_db"
  backup_assert_no_production_identity "--pg-user" "$pg_user"
fi

resolved_backup_root="$(cd "$(mkdir -p "$backup_root" && echo "$backup_root")" && pwd)"
nexora_env_assert_no_production_marker "--backup-root" "$resolved_backup_root"
chmod 700 "$resolved_backup_root"

if [ -n "$pg_password_file" ]; then
  [ -f "$pg_password_file" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "--pg-password-file not found: $pg_password_file"
  pg_password="$(cat "$pg_password_file")"
else
  pg_password="${PGPASSWORD:-}"
fi

ts="$(backup_timestamp)"
base_name="nexora-${NEXORA_BACKUP_ENV}-${pg_db}-${ts}"
final_dump="${resolved_backup_root}/${base_name}.dump"
final_checksum="${final_dump}.sha256"
final_encrypted="${final_dump}.gpg"
tmp_dump="${resolved_backup_root}/.tmp.${base_name}.dump.$$"

safe_final_dump="$(backup_assert_safe_output_path "output dump" "$final_dump" "$resolved_backup_root")"

if [ "$dry_run" = 1 ]; then
  backup_json_status \
    status=dry-run \
    environment="$NEXORA_BACKUP_ENV" \
    db="$pg_db" \
    would_write="$safe_final_dump"
  exit "$NEXORA_BACKUP_EXIT_OK"
fi

backup_log "starting pg_dump: env=${NEXORA_BACKUP_ENV} db=${pg_db} host=${pg_host}:${pg_port}"

cleanup() { rm -f "$tmp_dump" 2>/dev/null || true; }
trap cleanup EXIT

if ! docker run --rm --network host \
      -e PGPASSWORD="$pg_password" \
      "$pg_image" \
      pg_dump -Fc -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" \
  > "$tmp_dump" 2>/tmp/nexora-pgdump-stderr.$$; then
  err="$(cat /tmp/nexora-pgdump-stderr.$$ 2>/dev/null || true)"
  rm -f "/tmp/nexora-pgdump-stderr.$$"
  backup_json_status status=failed stage=pg_dump environment="$NEXORA_BACKUP_ENV" error="pg_dump failed (see stderr)"
  backup_log "pg_dump failed: ${err}"
  exit "$NEXORA_BACKUP_EXIT_PG_DUMP_FAILED"
fi
rm -f "/tmp/nexora-pgdump-stderr.$$"

if [ ! -s "$tmp_dump" ]; then
  backup_json_status status=failed stage=pg_dump environment="$NEXORA_BACKUP_ENV" error="empty dump"
  exit "$NEXORA_BACKUP_EXIT_PG_DUMP_FAILED"
fi

# Atomic rename into place, then lock down permissions.
mv -f "$tmp_dump" "$safe_final_dump"
chmod 600 "$safe_final_dump"
trap - EXIT

dump_size="$(stat -c%s "$safe_final_dump" 2>/dev/null || stat -f%z "$safe_final_dump")"
dump_sha="$(backup_sha256 "$safe_final_dump")"
printf '%s  %s\n' "$dump_sha" "$(basename "$safe_final_dump")" > "$final_checksum"
chmod 600 "$final_checksum"
backup_log "pg_dump complete: ${dump_size} bytes, sha256=${dump_sha}"

# --------------------------------------------------------------------------
# Encrypt at rest (gpg, local test key - see docs/backup-restore.md)
# --------------------------------------------------------------------------
if [ ! -f "$gpg_recipient" ] && ! gpg --list-keys "$gpg_recipient" >/dev/null 2>&1; then
  backup_json_status status=failed stage=encryption environment="$NEXORA_BACKUP_ENV" error="gpg recipient not found"
  exit "$NEXORA_BACKUP_EXIT_ENCRYPTION_FAILED"
fi

recipient_arg="$gpg_recipient"
if [ -f "$gpg_recipient" ]; then
  # A key-id/fingerprint file was supplied rather than a key-id string.
  recipient_arg="$(tr -d ' \n' < "$gpg_recipient")"
fi

if ! gpg --batch --yes --trust-model always -r "$recipient_arg" \
      -o "${final_encrypted}.tmp" --encrypt "$safe_final_dump" 2>/tmp/nexora-gpg-stderr.$$; then
  err="$(cat /tmp/nexora-gpg-stderr.$$ 2>/dev/null || true)"
  rm -f "/tmp/nexora-gpg-stderr.$$" "${final_encrypted}.tmp"
  backup_json_status status=failed stage=encryption environment="$NEXORA_BACKUP_ENV" error="gpg encrypt failed"
  backup_log "gpg encrypt failed: ${err}"
  exit "$NEXORA_BACKUP_EXIT_ENCRYPTION_FAILED"
fi
rm -f "/tmp/nexora-gpg-stderr.$$"
mv -f "${final_encrypted}.tmp" "$final_encrypted"
chmod 600 "$final_encrypted"
enc_sha="$(backup_sha256 "$final_encrypted")"
printf '%s  %s\n' "$enc_sha" "$(basename "$final_encrypted")" > "${final_encrypted}.sha256"
chmod 600 "${final_encrypted}.sha256"
backup_log "encrypted: $(basename "$final_encrypted") sha256=${enc_sha}"

# The plaintext dump is not needed once the encrypted artifact exists.
rm -f "$safe_final_dump"

# --------------------------------------------------------------------------
# State file for backup-status.sh (machine-readable, no secrets)
# --------------------------------------------------------------------------
state_file="${resolved_backup_root}/backup-state.json"
cat > "${state_file}.tmp" <<EOF
{
  "last_success": "$(date -u +%FT%TZ)",
  "last_backup_file": "$(basename "$final_encrypted")",
  "last_backup_dir": "${resolved_backup_root}",
  "environment": "${NEXORA_BACKUP_ENV}",
  "db": "${pg_db}",
  "encrypted_sha256": "${enc_sha}",
  "plaintext_sha256": "${dump_sha}",
  "size_bytes": ${dump_size}
}
EOF
mv -f "${state_file}.tmp" "$state_file"
chmod 600 "$state_file"

backup_json_status \
  status=success \
  environment="$NEXORA_BACKUP_ENV" \
  db="$pg_db" \
  encrypted_file="$(basename "$final_encrypted")" \
  encrypted_sha256="$enc_sha" \
  plaintext_sha256="$dump_sha" \
  size_bytes="$dump_size"

# --------------------------------------------------------------------------
# Retention (only after a successful backup)
# --------------------------------------------------------------------------
if [ "$skip_retention" != 1 ]; then
  "${NEXORA_BACKUP_LIB_DIR}/../retention.sh" "$resolved_backup_root" --apply >&2 || {
    backup_log "retention step failed (backup itself succeeded)"
    exit "$NEXORA_BACKUP_EXIT_RETENTION_FAILED"
  }
fi

exit "$NEXORA_BACKUP_EXIT_OK"
