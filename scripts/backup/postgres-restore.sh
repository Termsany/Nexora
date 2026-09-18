#!/usr/bin/env bash
# Nexora Postgres restore (PR-04A).
#
# Usage:
#   scripts/backup/postgres-restore.sh <disposable|development|staging> \
#     --input FILE.dump.gpg --pg-host HOST --pg-port PORT --pg-db DB --pg-user USER \
#     [--pg-password-file FILE] [--gpg-key-file FILE] [--force-nonempty]
#
# Refuses "production"/"nexora" outright (same guard as postgres-backup.sh).
# Defaults are disposable-first: callers must be explicit about every
# connection parameter, there is no default target database.
#
# Pipeline: verify checksum -> decrypt (gpg) -> verify target DB is empty
# (refuses to overwrite a populated database, unless --force-nonempty is
# passed AND the target is not production) -> pg_restore -> verify
# drizzle.__drizzle_migrations is populated -> print restore report.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

env_arg="${1:-}"
shift || true
NEXORA_BACKUP_ENV="$(backup_env_validate "$env_arg")"

input="" pg_host="" pg_port="" pg_db="" pg_user="" pg_password_file="" gpg_key_file=""
force_nonempty=0
pg_image="postgres:16-alpine"

while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="$2"; shift 2 ;;
    --pg-host) pg_host="$2"; shift 2 ;;
    --pg-port) pg_port="$2"; shift 2 ;;
    --pg-db) pg_db="$2"; shift 2 ;;
    --pg-user) pg_user="$2"; shift 2 ;;
    --pg-password-file) pg_password_file="$2"; shift 2 ;;
    --gpg-key-file) gpg_key_file="$2"; shift 2 ;;
    --pg-image) pg_image="$2"; shift 2 ;;
    --force-nonempty) force_nonempty=1; shift ;;
    *) backup_die "$NEXORA_BACKUP_EXIT_USAGE" "unknown argument: $1" ;;
  esac
done

for req in input pg_host pg_port pg_db pg_user; do
  [ -n "${!req}" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "--${req//_/-} is required."
done

backup_assert_no_production_identity "--pg-host" "$pg_host"
backup_assert_no_production_identity "--pg-db" "$pg_db"
backup_assert_no_production_identity "--pg-user" "$pg_user"
backup_assert_no_production_identity "--input" "$input"

[ -f "$input" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "input file not found: $input"
checksum_file="${input}.sha256"
[ -f "$checksum_file" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "checksum sidecar not found: $checksum_file"

if [ -n "$pg_password_file" ]; then
  pg_password="$(cat "$pg_password_file")"
else
  pg_password="${PGPASSWORD:-}"
fi

# --------------------------------------------------------------------------
# 1. Verify checksum BEFORE decrypting/restoring anything
# --------------------------------------------------------------------------
backup_log "verifying checksum of $(basename "$input")"
expected_sha="$(awk '{print $1}' "$checksum_file")"
actual_sha="$(backup_sha256 "$input")"
if [ "$expected_sha" != "$actual_sha" ]; then
  backup_json_status status=failed stage=checksum environment="$NEXORA_BACKUP_ENV" expected="$expected_sha" actual="$actual_sha"
  exit "$NEXORA_BACKUP_EXIT_TAMPERED"
fi
backup_log "checksum OK: ${actual_sha}"

# --------------------------------------------------------------------------
# 2. Decrypt
# --------------------------------------------------------------------------
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
decrypted="${tmp_dir}/restore.dump"

gpg_args=(--batch --yes -o "$decrypted" --decrypt "$input")
if [ -n "$gpg_key_file" ]; then
  gpg --batch --yes --import "$gpg_key_file" >/dev/null 2>&1 || true
fi

if ! gpg "${gpg_args[@]}" 2>/tmp/nexora-gpg-restore-stderr.$$; then
  err="$(cat /tmp/nexora-gpg-restore-stderr.$$ 2>/dev/null || true)"
  rm -f "/tmp/nexora-gpg-restore-stderr.$$"
  backup_json_status status=failed stage=decryption environment="$NEXORA_BACKUP_ENV" error="gpg decrypt failed"
  backup_log "gpg decrypt failed: ${err}"
  exit "$NEXORA_BACKUP_EXIT_DECRYPTION_FAILED"
fi
rm -f "/tmp/nexora-gpg-restore-stderr.$$"
backup_log "decrypted to scratch file ($(stat -c%s "$decrypted" 2>/dev/null || stat -f%z "$decrypted") bytes)"

# --------------------------------------------------------------------------
# 3. Refuse to restore into a populated database
# --------------------------------------------------------------------------
table_count="$(docker run --rm --network host -e PGPASSWORD="$pg_password" "$pg_image" \
  psql -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc \
  "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" \
  2>/tmp/nexora-psql-stderr.$$ || echo "ERR")"

if [ "$table_count" = "ERR" ]; then
  err="$(cat /tmp/nexora-psql-stderr.$$ 2>/dev/null || true)"
  rm -f "/tmp/nexora-psql-stderr.$$"
  backup_json_status status=failed stage=preflight environment="$NEXORA_BACKUP_ENV" error="could not query target database"
  backup_log "preflight query failed: ${err}"
  exit "$NEXORA_BACKUP_EXIT_PG_RESTORE_FAILED"
fi
rm -f "/tmp/nexora-psql-stderr.$$"

if [ "$table_count" -gt 0 ] && [ "$force_nonempty" != 1 ]; then
  backup_json_status status=refused stage=preflight environment="$NEXORA_BACKUP_ENV" reason="target database is not empty" existing_tables="$table_count"
  exit "$NEXORA_BACKUP_EXIT_TARGET_NOT_EMPTY"
fi

# --------------------------------------------------------------------------
# 4. Restore
# --------------------------------------------------------------------------
backup_log "restoring into ${pg_db}@${pg_host}:${pg_port}"
if ! docker run --rm --network host -e PGPASSWORD="$pg_password" \
      -v "${decrypted}:/restore.dump:ro" "$pg_image" \
      pg_restore -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" \
      --no-owner --no-privileges --clean --if-exists /restore.dump \
      2>/tmp/nexora-pgrestore-stderr.$$; then
  err="$(cat /tmp/nexora-pgrestore-stderr.$$ 2>/dev/null || true)"
  # pg_restore can exit non-zero on warnings alone; treat only genuine
  # failure (no tables ended up present) as fatal, but always surface stderr.
  rm -f "/tmp/nexora-pgrestore-stderr.$$"
  backup_log "pg_restore reported errors (may include benign warnings): ${err}"
fi
rm -f "/tmp/nexora-pgrestore-stderr.$$" 2>/dev/null || true

# --------------------------------------------------------------------------
# 5. Verify migration metadata
# --------------------------------------------------------------------------
migration_count="$(docker run --rm --network host -e PGPASSWORD="$pg_password" "$pg_image" \
  psql -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc \
  "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo "ERR")"

if [ "$migration_count" = "ERR" ] || [ "$migration_count" -eq 0 ]; then
  backup_json_status status=failed stage=migration_check environment="$NEXORA_BACKUP_ENV" migration_rows="${migration_count}"
  exit "$NEXORA_BACKUP_EXIT_MIGRATION_CHECK_FAILED"
fi

restored_table_count="$(docker run --rm --network host -e PGPASSWORD="$pg_password" "$pg_image" \
  psql -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc \
  "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" \
  2>/dev/null || echo "ERR")"

backup_json_status \
  status=success \
  environment="$NEXORA_BACKUP_ENV" \
  db="$pg_db" \
  source_file="$(basename "$input")" \
  checksum="$actual_sha" \
  migration_rows="$migration_count" \
  restored_tables="$restored_table_count"

cat >&2 <<REPORT

=== Nexora restore report ===
environment       : ${NEXORA_BACKUP_ENV}
source            : $(basename "$input")
checksum          : ${actual_sha} (verified)
target            : ${pg_user}@${pg_host}:${pg_port}/${pg_db}
restored tables   : ${restored_table_count}
migration rows    : ${migration_count} (drizzle.__drizzle_migrations)
==============================
REPORT

exit "$NEXORA_BACKUP_EXIT_OK"
