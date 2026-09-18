#!/usr/bin/env bash
# Deterministic tests for scripts/backup/retention.sh.
#
# Retention decides what gets DELETED, so it is tested against synthetic
# fixture files in a disposable directory - never against a real backup root.
# Dates come from the filename convention, and retention selection is purely
# ordering-based (no wall-clock input), so every assertion is reproducible
# regardless of when the suite runs.
#
# Policy under test: keep 14 daily, 8 weekly (oldest per ISO week), 12 monthly
# (oldest per month); delete anything in none of those buckets.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

RET=scripts/backup/retention.sh
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok(){ printf '  [ PASS ] %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }

# Fixed reference point for GENERATING fixture filenames. Retention itself
# takes no wall-clock input - selection derives from each artifact's embedded
# timestamp - so these assertions are reproducible by construction.
NOW_ISO="2026-09-11T00:00:00Z"
NOW=$(date -u -d "$NOW_ISO" +%s)

mkroot(){ # <name> -> echoes a fresh disposable root
  local r="$WORK/$1"; rm -rf "$r"; mkdir -p "$r"; printf '%s' "$r"; }
mkbackup(){ # <root> <days-ago>
  local r="$1" d="$2" ts
  ts=$(date -u -d "@$(( NOW - d*86400 ))" +%Y%m%dT%H%M%SZ)
  local f="$r/nexora-production-nexora-${ts}.dump.gpg"
  printf 'synthetic-%s' "$ts" > "$f"
  sha256sum "$f" | awk -v n="$(basename "$f")" '{print $1"  "n}' > "$f.sha256"
}
count_gpg(){ find "$1" -maxdepth 1 -name '*.dump.gpg' | wc -l; }
run_ret(){ bash "$RET" "$1" "${@:2}" 2>&1; }

echo
echo "== retention selection =="

# 1. Fewer than the daily allowance: nothing is ever deleted.
R=$(mkroot few); for d in 0 1 2 3 4; do mkbackup "$R" "$d"; done
run_ret "$R" --apply >/dev/null
[ "$(count_gpg "$R")" -eq 5 ] && ok "5 recent backups, all kept (under the 14-daily window)" \
                              || no "expected 5 kept, got $(count_gpg "$R")"

# 2. Exactly the daily allowance.
R=$(mkroot exact); for d in $(seq 0 13); do mkbackup "$R" "$d"; done
run_ret "$R" --apply >/dev/null
[ "$(count_gpg "$R")" -eq 14 ] && ok "exactly 14 daily backups, all kept" \
                               || no "expected 14 kept, got $(count_gpg "$R")"

# 3. A long history: daily + weekly + monthly buckets, everything else pruned.
R=$(mkroot history)
for d in $(seq 0 20); do mkbackup "$R" "$d"; done          # 21 dailies
for w in $(seq 3 14); do mkbackup "$R" $(( w*7 )); done      # weekly spread
for m in $(seq 2 15); do mkbackup "$R" $(( m*30 )); done     # monthly spread
before=$(count_gpg "$R")
out=$(run_ret "$R")                                          # dry run first
after_dry=$(count_gpg "$R")
[ "$before" -eq "$after_dry" ] && ok "dry run deletes nothing (default is non-destructive)" \
                               || no "dry run deleted files"
grep -q '"mode":"dry-run"' <<<"$out" && ok "dry run reports mode=dry-run" || no "dry-run mode not reported"
run_ret "$R" --apply >/dev/null
after=$(count_gpg "$R")
[ "$after" -lt "$before" ] && ok "long history pruned ($before -> $after)" || no "nothing pruned"
[ "$after" -le $(( 14 + 8 + 12 )) ] && ok "kept count within the 14+8+12 policy ceiling ($after)" \
                                    || no "kept $after, above the policy ceiling"
[ "$after" -ge 14 ] && ok "at least the 14 daily backups survive" || no "daily window not preserved"

# 4. Newest backup must always survive - losing it would be catastrophic.
R=$(mkroot newest); for d in $(seq 0 60); do mkbackup "$R" "$d"; done
newest=$(date -u -d "@$NOW" +%Y%m%dT%H%M%SZ)
run_ret "$R" --apply >/dev/null
[ -f "$R/nexora-production-nexora-${newest}.dump.gpg" ] && ok "the newest backup is never deleted" \
                                                        || no "newest backup was deleted"

# 5. Checksum sidecars follow their artifact.
gpgs=$(count_gpg "$R"); shas=$(find "$R" -maxdepth 1 -name '*.sha256' | wc -l)
[ "$gpgs" -eq "$shas" ] && ok "each surviving artifact keeps its .sha256 sidecar ($gpgs/$shas)" \
                        || no "artifact/sidecar mismatch ($gpgs vs $shas)"

echo
echo "== deletion safety =="

# 6. Unrelated files inside the root are never touched.
R=$(mkroot unrelated); for d in $(seq 0 40); do mkbackup "$R" "$d"; done
echo keep-me > "$R/backup-state.json"; echo keep-me > "$R/README.txt"
mkdir -p "$R/subdir"; echo keep-me > "$R/subdir/nested.dump.gpg"
run_ret "$R" --apply >/dev/null
[ -f "$R/backup-state.json" ] && [ -f "$R/README.txt" ] \
  && ok "non-backup files in the root are untouched" || no "an unrelated file was deleted"
[ -f "$R/subdir/nested.dump.gpg" ] && ok "files in subdirectories are out of scope" || no "recursed into a subdirectory"

# 7. Files that do not match the timestamp convention are ignored entirely.
R=$(mkroot malformed); for d in $(seq 0 20); do mkbackup "$R" "$d"; done
printf 'x' > "$R/not-a-backup.dump.gpg"
printf 'x' > "$R/nexora-production-nexora-NOTATIME.dump.gpg"
run_ret "$R" --apply >/dev/null
[ -f "$R/not-a-backup.dump.gpg" ] && [ -f "$R/nexora-production-nexora-NOTATIME.dump.gpg" ] \
  && ok "files without a parseable timestamp are ignored, not deleted" || no "a malformed-name file was deleted"

# 8. An empty root is a no-op, not an error.
R=$(mkroot empty)
out=$(run_ret "$R" --apply); rc=$?
[ "$rc" -eq 0 ] && grep -q 'no_matching_backups' <<<"$out" \
  && ok "empty root is a clean no-op" || no "empty root not handled (rc=$rc)"

# 9. Deletion cannot escape the configured root.
R=$(mkroot escape); for d in $(seq 0 40); do mkbackup "$R" "$d"; done
OUTSIDE="$WORK/outside-canary.dump.gpg"; printf 'canary' > "$OUTSIDE"
ln -s "$OUTSIDE" "$R/nexora-production-nexora-20200101T000000Z.dump.gpg"
run_ret "$R" --apply >/dev/null
[ -f "$OUTSIDE" ] && ok "a symlink pointing outside the root does not delete the target" \
                  || no "deletion escaped the backup root via a symlink"

# 10. A nonexistent root is refused rather than silently succeeding.
out=$(bash "$RET" "$WORK/does-not-exist" --apply 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok "nonexistent backup root refused (rc=$rc)" || no "nonexistent root accepted"

echo
echo "RETENTION_TESTS: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
