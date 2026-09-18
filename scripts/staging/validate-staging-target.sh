#!/usr/bin/env bash
# Nexora staging target validator — READ-ONLY.
#
# Answers one question: "is the host I am on a legitimate, fully-provisioned
# staging target?" It mutates nothing, needs no root, and is safe to run
# anywhere — including on Production, where it is expected to print a clear
# refusal.
#
# Run this BEFORE any privileged staging entrypoint.
#
#   bash scripts/staging/validate-staging-target.sh
#
# Exit codes:
#   0  verified staging target
#   1  not a staging target (or incompletely provisioned)
#   2  host positively identified as PRODUCTION - never mutate here
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./staging-guard.sh
source "$here/staging-guard.sh"

pass=0; fail=0; prod_detected=0
ok()   { printf '  [ PASS ] %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }
info() { printf '  [ info ] %s\n' "$1"; }

printf '\nNexora staging target validation — %s\n' "$(date -u +%FT%TZ)"
printf '================================================================\n'

# ---------------------------------------------------------------- identity --
printf '\n[1] Host identity\n'
host_now="$(hostname)"
info "hostname            : $host_now"
info "fqdn                : $(hostname -f 2>/dev/null || echo '(unresolved)')"
info "virtualization      : $(systemd-detect-virt 2>/dev/null || echo unknown)"
info "kernel              : $(uname -r)"

if [ -f "$NEXORA_STAGING_MARKER" ] && [ ! -L "$NEXORA_STAGING_MARKER" ]; then
  marker_env="$(sed -n 's/^ENVIRONMENT=//p' "$NEXORA_STAGING_MARKER" 2>/dev/null | head -1)"
  info "environment marker  : ENVIRONMENT=${marker_env:-<unreadable>}"
  case "$marker_env" in
    staging)    ok "environment marker declares staging" ;;
    production) bad "environment marker declares PRODUCTION"; prod_detected=1 ;;
    *)          bad "environment marker present but ENVIRONMENT is '${marker_env:-empty}'" ;;
  esac
  mo="$(stat -c '%u:%g:%a' "$NEXORA_STAGING_MARKER" 2>/dev/null)"
  [ "$mo" = "0:0:400" ] && ok "marker is root:root 0400" || bad "marker must be root:root 0400 (found $mo)"
else
  bad "no environment marker at $NEXORA_STAGING_MARKER (or it is a symlink)"
  info "absence fails closed — it is never read as 'probably staging'"
fi

[ "$host_now" = "$NEXORA_STAGING_HOSTNAME" ] \
  && ok "hostname matches staging policy ($NEXORA_STAGING_HOSTNAME)" \
  || bad "hostname '$host_now' != '$NEXORA_STAGING_HOSTNAME'"

if [ -f "$NEXORA_STAGING_MARKER" ] && [ ! -L "$NEXORA_STAGING_MARKER" ]; then
  marker_fqdn="$(sed -n 's/^FQDN=//p' "$NEXORA_STAGING_MARKER" 2>/dev/null | head -1)"
  [ "$marker_fqdn" = "$NEXORA_STAGING_FQDN" ] \
    && ok "marker FQDN matches staging policy ($NEXORA_STAGING_FQDN)" \
    || bad "marker FQDN '${marker_fqdn:-<absent>}' != '$NEXORA_STAGING_FQDN'"
fi
fqdn_now="$(hostname -f 2>/dev/null || true)"
if [ -z "$fqdn_now" ]; then
  info "resolved FQDN unavailable (resolver not configured yet)"
elif [ "$fqdn_now" = "$NEXORA_STAGING_FQDN" ]; then
  ok "resolved FQDN matches staging policy"
else
  bad "resolved FQDN '$fqdn_now' != '$NEXORA_STAGING_FQDN'"
fi

# ------------------------------------------------------------------ docker --
printf '\n[2] Docker identity\n'
if names="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"; then
  found_prod=""
  for c in "${NEXORA_PRODUCTION_CONTAINERS[@]}"; do
    grep -qxF "$c" <<<"$names" && found_prod="$found_prod $c"
  done
  if [ -n "$found_prod" ]; then
    bad "PRODUCTION container identities present:$found_prod"
    prod_detected=1
  else
    ok "no Production container identity present"
  fi
  if grep -qE "^${NEXORA_STAGING_PROJECT}-" <<<"$names"; then
    ok "staging compose project identity present (${NEXORA_STAGING_PROJECT}-*)"
    info "staging containers  : $(grep -cE "^${NEXORA_STAGING_PROJECT}-" <<<"$names")"
  else
    bad "no ${NEXORA_STAGING_PROJECT}-* container found"
  fi
else
  bad "cannot query the Docker daemon (failing closed)"
fi

# ---------------------------------------------------------------- database --
printf '\n[3] Database identity\n'
pgc="${NEXORA_STAGING_PROJECT}-postgres-1"
if docker inspect "$pgc" >/dev/null 2>&1; then
  if dbs="$(docker exec "$pgc" psql -U "$NEXORA_STAGING_DB" -d "$NEXORA_STAGING_DB" \
              -tAc 'SELECT datname FROM pg_database' 2>/dev/null)"; then
    grep -qxF "$NEXORA_STAGING_DB" <<<"$dbs" \
      && ok "staging database '$NEXORA_STAGING_DB' present" \
      || bad "staging database '$NEXORA_STAGING_DB' absent"
    if grep -qxF 'nexora' <<<"$dbs"; then
      bad "PRODUCTION database name 'nexora' reachable on this daemon"; prod_detected=1
    else
      ok "no Production database 'nexora' on this daemon"
    fi
  else
    bad "cannot enumerate databases in '$pgc'"
  fi
else
  bad "staging postgres container '$pgc' not found"
fi

# -------------------------------------------------------------- filesystem --
printf '\n[4] Filesystem separation\n'
if [ -f "$NEXORA_STAGING_ENV_FILE" ]; then
  em="$(stat -c '%u:%g:%a' "$NEXORA_STAGING_ENV_FILE" 2>/dev/null)"
  [ "$em" = "0:0:600" ] && ok "staging env file root:root 0600" \
                        || bad "staging env file must be root:root 0600 (found $em)"
else
  bad "staging env file $NEXORA_STAGING_ENV_FILE absent"
fi
[ ! -e "$NEXORA_PRODUCTION_ENV_FILE" ] \
  && ok "no production env file at $NEXORA_PRODUCTION_ENV_FILE" \
  || { bad "production env file present at $NEXORA_PRODUCTION_ENV_FILE"; prod_detected=1; }

for p in /opt/nexora /etc/nexora/env /etc/nexora/pki/server /srv/nexora/staging/downloads; do
  [ -e "$p" ] && ok "path present: $p" || info "path absent (provision in bootstrap): $p"
done

# ------------------------------------------------------------------ verdict --
printf '\n[5] Composite guard\n'
if staging_guard >/dev/null 2>&1; then
  ok "staging_guard() returns OK"
else
  bad "staging_guard() refuses this host"
fi

printf '\n================================================================\n'
printf 'checks passed: %d   failed: %d\n' "$pass" "$fail"

if [ "$prod_detected" -eq 1 ]; then
  cat >&2 <<'EOF'

VERDICT: PRODUCTION

This host is positively identified as Production. Do not provision staging
here, do not install systemd units, do not create system users, and do not
create roles or schemas in its database. Provision a separate host — see
docs/staging-architecture.md.
EOF
  exit 2
fi

if [ "$fail" -eq 0 ]; then
  printf '\nVERDICT: VERIFIED STAGING TARGET — privileged staging steps may proceed.\n'
  exit 0
fi

cat >&2 <<'EOF'

VERDICT: NOT A STAGING TARGET

Not Production, but not a fully-provisioned staging host either. Complete
docs/staging-bootstrap.md and re-run. Every failed check above must pass
before any privileged staging entrypoint runs.
EOF
exit 1
