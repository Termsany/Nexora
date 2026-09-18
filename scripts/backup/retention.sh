#!/usr/bin/env bash
# Nexora backup retention (PR-04A).
#
# Usage:
#   scripts/backup/retention.sh <backup-root> [--apply]
#
# Policy: keep the 14 most recent daily backups, 8 weekly (oldest-per-ISO-week
# beyond the daily window), 12 monthly (oldest-per-month beyond that) -
# anything older than all three buckets is deleted. Without --apply this is a
# dry run that only reports what would be deleted.
#
# Operates ONLY on *.dump.gpg / *.dump.gpg.sha256 / *.dump.sha256 files
# directly inside <backup-root>, and refuses to delete anything outside that
# root (see backup_assert_safe_output_path). Never touches the Postgres
# volume or any repo file - deletion candidates are computed from filenames
# matching this tool's own naming convention only.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

backup_root="${1:-}"
shift || true
[ -n "$backup_root" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "usage: retention.sh <backup-root> [--apply]"

apply=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    *) backup_die "$NEXORA_BACKUP_EXIT_USAGE" "unknown argument: $1" ;;
  esac
done

[ -d "$backup_root" ] || backup_die "$NEXORA_BACKUP_EXIT_USAGE" "backup root does not exist: $backup_root"
resolved_root="$(cd "$backup_root" && pwd)"
nexora_env_assert_no_production_marker "backup-root" "$resolved_root"

# Selection is purely ORDERING-based: buckets derive from each artifact's own
# embedded timestamp (newest-N daily, oldest-per-ISO-week, oldest-per-month),
# never from wall-clock time. That makes the outcome deterministic and
# reproducible regardless of when it runs, so no --now/date injection exists
# or is needed. A previously advertised --now flag was inert and was removed.
DAILY_KEEP=14
WEEKLY_KEEP=8
MONTHLY_KEEP=12

# Collect encrypted backup files (the unit of retention) with their embedded
# timestamp, newest first. Filename convention:
#   nexora-<env>-<db>-<YYYYMMDDTHHMMSSZ>.dump.gpg
declare -a files=()
declare -a epochs=()
shopt -s nullglob
for f in "$resolved_root"/*.dump.gpg; do
  bn="$(basename "$f")"
  ts="$(printf '%s' "$bn" | sed -n 's/^.*-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump\.gpg$/\1/p')"
  [ -n "$ts" ] || continue
  y="${ts:0:4}" mo="${ts:4:2}" d="${ts:6:2}" h="${ts:9:2}" mi="${ts:11:2}" s="${ts:13:2}"
  ep="$(date -u -d "${y}-${mo}-${d} ${h}:${mi}:${s}" +%s 2>/dev/null || echo "")"
  [ -n "$ep" ] || continue
  files+=("$f")
  epochs+=("$ep")
done
shopt -u nullglob

n="${#files[@]}"
if [ "$n" -eq 0 ]; then
  backup_json_status status=noop reason=no_matching_backups backup_root="$resolved_root"
  exit "$NEXORA_BACKUP_EXIT_OK"
fi

# Sort indices by epoch descending (newest first) using a stable sort.
idx_sorted=$(for i in $(seq 0 $((n-1))); do printf '%s %s\n' "${epochs[$i]}" "$i"; done | sort -rn -k1,1 | awk '{print $2}')

declare -A keep=()
count=0
for i in $idx_sorted; do
  count=$((count+1))
  if [ "$count" -le "$DAILY_KEEP" ]; then
    keep[$i]=daily
  fi
done

# Weekly: oldest-per-ISO-week among items beyond the daily window, up to WEEKLY_KEEP buckets.
declare -A week_seen=()
week_kept=0
for i in $idx_sorted; do
  [ -n "${keep[$i]:-}" ] && continue
  wk="$(date -u -d "@${epochs[$i]}" +%G-%V)"
  if [ -z "${week_seen[$wk]:-}" ] && [ "$week_kept" -lt "$WEEKLY_KEEP" ]; then
    week_seen[$wk]=1
    week_kept=$((week_kept+1))
    keep[$i]=weekly
  fi
done

# Monthly: oldest-per-month among what's left, up to MONTHLY_KEEP buckets.
declare -A month_seen=()
month_kept=0
for i in $idx_sorted; do
  [ -n "${keep[$i]:-}" ] && continue
  mo="$(date -u -d "@${epochs[$i]}" +%Y-%m)"
  if [ -z "${month_seen[$mo]:-}" ] && [ "$month_kept" -lt "$MONTHLY_KEEP" ]; then
    month_seen[$mo]=1
    month_kept=$((month_kept+1))
    keep[$i]=monthly
  fi
done

deleted=0
kept=0
for i in $idx_sorted; do
  f="${files[$i]}"
  if [ -n "${keep[$i]:-}" ]; then
    kept=$((kept+1))
    continue
  fi
  # Safety: candidate must resolve inside backup root and match our naming.
  case "$f" in
    "$resolved_root"/nexora-*.dump.gpg) : ;;
    *) continue ;;
  esac
  deleted=$((deleted+1))
  if [ "$apply" = 1 ]; then
    rm -f "$f" "${f}.sha256"
    backup_log "retention: deleted $(basename "$f")"
  else
    backup_log "retention (dry-run): would delete $(basename "$f")"
  fi
done

backup_json_status \
  status=success \
  mode="$([ "$apply" = 1 ] && echo apply || echo dry-run)" \
  backup_root="$resolved_root" \
  total="$n" \
  kept="$kept" \
  deleted="$deleted"

exit "$NEXORA_BACKUP_EXIT_OK"
