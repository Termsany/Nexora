#!/usr/bin/env bash
# Regression coverage for scripts/monitoring/production-guard.sh.
#
# Runs as root in a throwaway container because the guard legitimately
# requires the environment marker to be root:root 0400. `hostname` and
# `docker` are shimmed so each scenario presents an exact identity.
#
# Proves the two properties that matter most:
#   * identity alone NEVER authorizes a mutation
#   * the approval phrase alone NEVER substitutes for identity
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
IMAGE="${NEXORA_GUARD_TEST_IMAGE:-nexora-task010-integration}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "test image missing" >&2; exit 1; }

docker run --rm -i --network none \
  -v "$PWD/scripts/monitoring/production-guard.sh:/guard.sh:ro" \
  --entrypoint bash "$IMAGE" -s <<'INNER'
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
pass=0; fail=0
ok(){ printf '  [ PASS ] %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }
SHIM=/shim; mkdir -p "$SHIM"; export PATH="$SHIM:$PATH"
W=$(mktemp -d)
export NEXORA_ENV_MARKER="$W/marker"
PHRASE='I UNDERSTAND THIS DEPLOYS MONITORING TO PRODUCTION'

set_host(){ printf '#!/bin/bash\n[ "${1:-}" = -f ] && echo "%s.design.local" || echo "%s"\n' "$1" "$1" > "$SHIM/hostname"; chmod 755 "$SHIM/hostname"; }
set_docker(){ printf '#!/bin/bash\ncase "$1" in\n ps) cat <<%s\n%s\n%s\n ;;\n inspect) exit 0 ;;\n exec) cat <<%s\n%s\n%s\n ;;\n *) exit 0 ;;\nesac\n' "EOFA" "$1" "EOFA" "EOFB" "$2" "EOFB" > "$SHIM/docker"; chmod 755 "$SHIM/docker"; }
mk_marker(){ printf 'ENVIRONMENT=%s\nHOSTNAME=%s\n' "$1" "${2:-Nexora}" > "$NEXORA_ENV_MARKER"; chown 0:0 "$NEXORA_ENV_MARKER"; chmod "${3:-0400}" "$NEXORA_ENV_MARKER"; }

PROD_C=$'nexora-postgres-1\nnexora-api-1\nnexora-web-1\nnexora-maintenance-1\nnexora-notification-worker-1'
PROD_DB=$'nexora\npostgres'
STAGING_C=$'nexora-staging-postgres-1\nnexora-staging-api-1'

guard(){ ( source /guard.sh; production_guard >/dev/null 2>&1; echo $? ); }
approve(){ ( source /guard.sh; production_deploy_approved >/dev/null 2>&1; echo $? ); }

valid(){ mk_marker production Nexora; set_host Nexora; set_docker "$PROD_C" "$PROD_DB"; }

echo; echo "=== production-guard regression ==="
valid; [ "$(guard)" -eq 0 ] && ok "valid production host accepted" || no "valid production host rejected"

valid; rm -f "$NEXORA_ENV_MARKER"
[ "$(guard)" -ne 0 ] && ok "missing environment marker refused" || no "missing marker accepted"

valid; mk_marker staging Nexora
[ "$(guard)" -ne 0 ] && ok "marker declaring ENVIRONMENT=staging refused" || no "staging marker accepted"

valid; chmod 0644 "$NEXORA_ENV_MARKER"
[ "$(guard)" -ne 0 ] && ok "world-readable marker (0644) refused" || no "0644 marker accepted"

valid; set_host nexora-staging
[ "$(guard)" -ne 0 ] && ok "wrong hostname refused" || no "wrong hostname accepted"

valid; set_docker "$(printf '%s\n%s' "$PROD_C" "$STAGING_C")" "$PROD_DB"
[ "$(guard)" -ne 0 ] && ok "staging compose identity present on host refused" || no "staging containers accepted"

valid; set_docker "$PROD_C" $'nexora\nnexora_staging\npostgres'
[ "$(guard)" -ne 0 ] && ok "staging database present refused" || no "staging DB accepted"

valid; set_docker $'nexora-postgres-1\nnexora-api-1' "$PROD_DB"
[ "$(guard)" -ne 0 ] && ok "missing expected production container refused" || no "incomplete production stack accepted"

valid; set_docker "$PROD_C" $'postgres'
[ "$(guard)" -ne 0 ] && ok "production database absent refused" || no "missing production DB accepted"

valid; : > /etc/nexora-staging-host
[ "$(guard)" -ne 0 ] && ok "legacy staging marker present refused" || no "legacy staging marker accepted"
rm -f /etc/nexora-staging-host

echo; echo "=== identity is NOT authorization ==="
valid
unset NEXORA_PRODUCTION_DEPLOY_APPROVED
[ "$(guard)" -eq 0 ] && [ "$(approve)" -ne 0 ] \
  && ok "identity passes but approval refuses without the phrase" || no "approval gate did not refuse"

export NEXORA_PRODUCTION_DEPLOY_APPROVED='yes'
[ "$(approve)" -ne 0 ] && ok "a wrong approval phrase is refused" || no "wrong phrase accepted"

export NEXORA_PRODUCTION_DEPLOY_APPROVED="$PHRASE"
[ "$(approve)" -eq 0 ] && ok "exact approval phrase accepted (as root)" || no "exact phrase rejected"

# approval must never rescue a bad identity
rm -f "$NEXORA_ENV_MARKER"
[ "$(guard)" -ne 0 ] && ok "approval phrase does NOT bypass a failed identity check" || no "approval bypassed identity"
unset NEXORA_PRODUCTION_DEPLOY_APPROVED

valid; [ "$(guard)" -eq 0 ] && ok "guard recovers after every negative case" || no "guard did not recover"

rm -rf "$W"
echo; echo "PRODUCTION_GUARD_TESTS: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
INNER
