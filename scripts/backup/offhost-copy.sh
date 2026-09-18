#!/usr/bin/env bash
# Off-host copy adapter (PR-04A).
#
# Pluggable destination for shipping encrypted backups off the host that
# produced them (3-2-1: local disk, this copy, and eventually a third
# location). PR-04A implements only the "local" adapter, which copies into a
# second disposable local directory to simulate an off-host target end to
# end. No implicit destination is ever chosen - every call names one.
#
# Usage:
#   scripts/backup/offhost-copy.sh local <src-encrypted-file> <dest-dir>
#   scripts/backup/offhost-copy.sh ssh   <src-encrypted-file> <user@host:/path>   # NOT IMPLEMENTED in PR-04A
#
# Copies only the encrypted file and its .sha256 sidecar - never the
# plaintext dump (which postgres-backup.sh deletes immediately after
# encryption anyway).
#
# To wire a real off-host destination later (PR-04B+), add a case here that
# shells out to `rsync -av --checksum` or `scp` against
# /etc/nexora/backup/offhost.env (host, path, ssh key path) - no changes are
# needed anywhere else in this toolset, because postgres-backup.sh and
# backup-status.sh only ever call this adapter by name and read its exit
# code / JSON status.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

adapter="${1:-}"
src="${2:-}"
dest="${3:-}"

[ -n "$adapter" ] && [ -n "$src" ] && [ -n "$dest" ] || \
  backup_die "$NEXORA_BACKUP_EXIT_USAGE" "usage: offhost-copy.sh <local|ssh> <src-file> <dest>"

[ -f "$src" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "source file not found: $src"

case "$src" in
  *.gpg) : ;;
  *) backup_die "$NEXORA_BACKUP_EXIT_USAGE" "off-host copy only accepts encrypted (*.gpg) artifacts, got: $src" ;;
esac

src_checksum="${src}.sha256"
[ -f "$src_checksum" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "checksum sidecar not found: $src_checksum"

case "$adapter" in
  local)
    nexora_env_assert_no_production_marker "off-host destination" "$dest"
    mkdir -p "$dest"
    resolved_dest="$(cd "$dest" && pwd)"
    nexora_env_assert_not_production_path "off-host destination" "$resolved_dest"
    chmod 700 "$resolved_dest"

    if ! cp -f "$src" "$resolved_dest/"; then
      backup_json_status status=failed adapter=local error="copy of dump failed"
      exit "$NEXORA_BACKUP_EXIT_OFFHOST_FAILED"
    fi
    if ! cp -f "$src_checksum" "$resolved_dest/"; then
      backup_json_status status=failed adapter=local error="copy of checksum failed"
      exit "$NEXORA_BACKUP_EXIT_OFFHOST_FAILED"
    fi
    chmod 600 "${resolved_dest}/$(basename "$src")" "${resolved_dest}/$(basename "$src_checksum")"

    # Verify integrity post-copy.
    copied_sha="$(backup_sha256 "${resolved_dest}/$(basename "$src")")"
    expected_sha="$(awk '{print $1}' "$src_checksum")"
    if [ "$copied_sha" != "$expected_sha" ]; then
      backup_json_status status=failed adapter=local error="post-copy checksum mismatch"
      exit "$NEXORA_BACKUP_EXIT_OFFHOST_FAILED"
    fi

    src_dir="$(cd "$(dirname "$src")" && pwd)"
    state_file="${src_dir}/offhost-state.json"
    cat > "${state_file}.tmp" <<EOF
{
  "status": "success",
  "adapter": "local",
  "destination": "${resolved_dest}",
  "file": "$(basename "$src")",
  "sha256": "${copied_sha}",
  "copied_at": "$(date -u +%FT%TZ)"
}
EOF
    mv -f "${state_file}.tmp" "$state_file"
    chmod 600 "$state_file"

    backup_json_status \
      status=success \
      adapter=local \
      destination="$resolved_dest" \
      file="$(basename "$src")" \
      sha256="$copied_sha"
    exit "$NEXORA_BACKUP_EXIT_OK"
    ;;
  ssh)
    backup_json_status status=failed adapter=ssh error="ssh adapter not implemented in PR-04A - see header comment for how to add it"
    exit "$NEXORA_BACKUP_EXIT_OFFHOST_FAILED"
    ;;
  *)
    backup_die "$NEXORA_BACKUP_EXIT_USAGE" "unknown adapter '${adapter}' (expected local or ssh)"
    ;;
esac
