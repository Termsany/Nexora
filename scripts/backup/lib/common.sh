#!/usr/bin/env bash
# Shared helpers for the Nexora backup/restore toolset (PR-04A).
#
# Sourced (never executed) by every script under scripts/backup/. Reuses the
# environment identities and production guards already defined in
# scripts/env/nexora-env.sh, so "what counts as production" has exactly one
# definition in this repo, not a second copy that could drift.
#
#   . scripts/backup/lib/common.sh
#
# This file does not set shell options (same convention as nexora-env.sh) -
# callers set their own (`set -euo pipefail`).

NEXORA_BACKUP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEXORA_BACKUP_REPO_ROOT="$(cd "${NEXORA_BACKUP_LIB_DIR}/../../.." && pwd)"

# shellcheck source=../../env/nexora-env.sh
. "${NEXORA_BACKUP_REPO_ROOT}/scripts/env/nexora-env.sh"

# --------------------------------------------------------------------------
# Exit codes (documented in docs/backup-restore.md - keep in sync)
# --------------------------------------------------------------------------
export NEXORA_BACKUP_EXIT_OK=0
export NEXORA_BACKUP_EXIT_USAGE=2
export NEXORA_BACKUP_EXIT_ENV_REJECTED=10
export NEXORA_BACKUP_EXIT_UNSAFE_PATH=11
export NEXORA_BACKUP_EXIT_PG_DUMP_FAILED=20
export NEXORA_BACKUP_EXIT_PG_RESTORE_FAILED=21
export NEXORA_BACKUP_EXIT_CHECKSUM_FAILED=30
export NEXORA_BACKUP_EXIT_ENCRYPTION_FAILED=40
export NEXORA_BACKUP_EXIT_DECRYPTION_FAILED=41
export NEXORA_BACKUP_EXIT_TAMPERED=42
export NEXORA_BACKUP_EXIT_RETENTION_FAILED=50
export NEXORA_BACKUP_EXIT_OFFHOST_FAILED=60
export NEXORA_BACKUP_EXIT_TARGET_NOT_EMPTY=70
export NEXORA_BACKUP_EXIT_MIGRATION_CHECK_FAILED=71

# --------------------------------------------------------------------------
# Backup-tool-specific environment registry
# --------------------------------------------------------------------------
# nexora-env.sh's registry is for the live Compose stacks (production,
# staging, development). Backup/restore additionally needs a "disposable"
# target for local testing - a container this toolset does not manage the
# lifecycle of, identified purely by connection parameters the caller
# supplies. It is never resolved from nexora-env.sh and is never production.
#
# backup_env_validate <env-arg>
#   Exits NEXORA_BACKUP_EXIT_ENV_REJECTED for anything that is, aliases to,
#   or could be confused with production. Accepts only:
#     disposable | development | staging
backup_env_validate() {
  local env="${1:-}"
  case "$env" in
    disposable | development | staging)
      echo "$env"
      return 0
      ;;
    "")
      backup_die "$NEXORA_BACKUP_EXIT_USAGE" "no environment argument given.

Every backup/restore operation must name its target explicitly:
  disposable | development | staging

Production is never a valid target for this tool in PR-04A. Production
backup/restore is PR-04B, with its own explicit approval gate."
      ;;
    production | prod | nexora | nexora-prod | nexora_prod)
      backup_die "$NEXORA_BACKUP_EXIT_ENV_REJECTED" "environment '${env}' names production.

This function (backup_env_validate) refuses production outright for every
caller except postgres-backup.sh, which calls
backup_env_validate_for_backup() instead and can accept production only for
a pg_dump, and only behind its own two-phrase human approval gate. Restore,
migration, and every other operation have no override, in any stage."
      ;;
    *)
      backup_die "$NEXORA_BACKUP_EXIT_ENV_REJECTED" "unknown environment '${env}' (expected disposable, development, or staging)."
      ;;
  esac
}

# backup_env_validate_for_backup <env-arg>
#
# Like backup_env_validate, but ALSO accepts "production" for a pg_dump-only
# backup operation (PR-04B), gated behind the same human-typed confirmation
# pattern nexora-env.sh already requires for every other production write,
# plus a second, backup-specific phrase - so this path cannot be satisfied by
# reusing an approval typed for a different operation, and cannot be granted
# by a script to itself in one automated run.
#
# postgres-restore.sh (and everything else) must keep calling
# backup_env_validate, not this function - production restore, migration, and
# secret rotation remain hard-refused with no override, regardless of this
# gate.
backup_env_validate_for_backup() {
  local env="${1:-}"
  case "$env" in
    production | prod | nexora | nexora-prod | nexora_prod)
      backup_require_production_backup_approval
      echo "production"
      return 0
      ;;
    *)
      backup_env_validate "$env"
      ;;
  esac
}

# backup_require_production_backup_approval
#
# Fail closed unless a human, in the interactive shell performing the backup,
# has typed BOTH:
#   1. the standard production-approval phrase (NEXORA_PRODUCTION_CONFIRM)
#      nexora-env.sh requires for every production write, and
#   2. a second phrase naming this specific, narrow operation
#      (NEXORA_BACKUP_PRODUCTION_CONFIRM).
#
# Two separate, deliberately awkward-to-type variables so this cannot be
# satisfied by a script setting one flag and immediately using it - it
# requires two distinct pieces of text a human chose to type, in an
# interactive shell, for this exact purpose, at the moment of use.
backup_require_production_backup_approval() {
  NEXORA_ENV="production"
  NEXORA_IS_PRODUCTION="true"
  nexora_env_require_production_approval "backup"

  if [ "${NEXORA_BACKUP_PRODUCTION_CONFIRM:-}" != "I UNDERSTAND THIS RUNS PG_DUMP AGAINST PRODUCTION CUSTOMER DATA" ]; then
    backup_die "$NEXORA_BACKUP_EXIT_ENV_REJECTED" "production backup requires a second, backup-specific confirmation.

Set, in the interactive shell performing the operation:

  export NEXORA_BACKUP_PRODUCTION_CONFIRM='I UNDERSTAND THIS RUNS PG_DUMP AGAINST PRODUCTION CUSTOMER DATA'

This authorizes pg_dump (read-only) against production ONLY. It does not
authorize pg_restore, migrations, or secret rotation against production -
those remain hard-refused regardless of this variable, in every script that
still calls backup_env_validate instead of backup_env_validate_for_backup."
  fi

  backup_log "PRODUCTION BACKUP AUTHORIZED: NEXORA_PRODUCTION_CONFIRM and NEXORA_BACKUP_PRODUCTION_CONFIRM were both explicitly set by the operator. release=${NEXORA_RELEASE:-unset}"
}

# backup_assert_no_production_identity <label> <value>
# Thin wrapper so every backup script uses the same production-marker list
# nexora-env.sh already maintains (host names, db names, volume names).
backup_assert_no_production_identity() {
  nexora_env_assert_no_production_marker "$1" "$2"
}

# backup_assert_safe_output_path <label> <path> <allowed-root>
#
# Rejects a path that is not contained within allowed-root, and rejects any
# path that looks like it is inside a Docker volume mount, a Postgres data
# directory, or a production-visible path from nexora-env.sh.
backup_assert_safe_output_path() {
  local label="$1" path="$2" allowed_root="$3"
  [ -n "$path" ] || backup_die "$NEXORA_BACKUP_EXIT_UNSAFE_PATH" "${label} is empty."

  local resolved_root resolved_parent resolved
  mkdir -p "$allowed_root" 2>/dev/null || true
  resolved_root="$(cd "$allowed_root" 2>/dev/null && pwd)" || \
    backup_die "$NEXORA_BACKUP_EXIT_UNSAFE_PATH" "allowed root '${allowed_root}' does not exist and could not be created."

  mkdir -p "$(dirname "$path")" 2>/dev/null || true
  resolved_parent="$(cd "$(dirname "$path")" 2>/dev/null && pwd)" || \
    backup_die "$NEXORA_BACKUP_EXIT_UNSAFE_PATH" "${label} parent directory does not exist: $(dirname "$path")"
  resolved="${resolved_parent}/$(basename "$path")"

  case "$resolved" in
    "$resolved_root" | "$resolved_root"/*) : ;;
    *)
      backup_die "$NEXORA_BACKUP_EXIT_UNSAFE_PATH" "${label} escapes the configured backup root.

  ${label} = ${resolved}
  backup root = ${resolved_root}"
      ;;
  esac

  # Reject anything that looks like a Postgres data / Docker volume path,
  # or a production write path already known to nexora-env.sh.
  case "$resolved" in
    */postgres-data/* | */postgres-data | */pgdata/* | */pgdata | \
    /var/lib/docker/volumes/*)
      backup_die "$NEXORA_BACKUP_EXIT_UNSAFE_PATH" "${label} points inside what looks like a Postgres data / Docker volume path.

  ${label} = ${resolved}

Backups must never be written inside the volume they are protecting against
loss of - that defeats the point of a backup."
      ;;
  esac
  nexora_env_assert_not_production_path "$label" "$resolved"

  printf '%s' "$resolved"
}

backup_die() {
  local code="$1"; shift
  printf '\nREFUSED: %s\n\n' "$1" >&2
  exit "$code"
}

# JSON status line. Never pass secret values here - see docs/backup-restore.md.
backup_json_status() {
  # backup_json_status key1=val1 key2=val2 ...
  local out="{" first=1 kv key val
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    [ "$first" = 1 ] || out+=","
    first=0
    out+="\"${key}\":\"${val//\"/\\\"}\""
  done
  out+="}"
  printf '%s\n' "$out"
}

backup_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

backup_timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

backup_log() {
  # Structured, secret-free progress line to stderr (status JSON stays on stdout).
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}
