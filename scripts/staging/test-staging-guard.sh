#!/usr/bin/env bash
# Regression coverage for scripts/staging/staging-guard.sh.
#
# Runs entirely inside a throwaway container as root, because the guard
# legitimately requires the environment marker to be root:root 0400 and the
# staging env file to be root:root 0600. Faking those ownership checks away
# would weaken the guard to make a test pass, which is the wrong trade — so
# the fixtures are built with real ownership instead.
#
# `hostname` and `docker` are shimmed on PATH so each scenario can present an
# exact host/container/database identity without needing real infrastructure.
#
# Covers the five required regressions:
#   1. fully valid staging fixture            -> 0
#   2. missing staging marker                 -> non-zero
#   3. Production container identity present  -> non-zero
#   4. Production database identity present   -> non-zero
#   5. mixed Production/Staging identity      -> non-zero
# plus the specific `&& rc=1` vs `|| rc=1` bug that once let a detected
# Production database print a refusal without actually enforcing it.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

IMAGE="${NEXORA_GUARD_TEST_IMAGE:-nexora-task010-integration}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "test image '$IMAGE' not present; set NEXORA_GUARD_TEST_IMAGE" >&2; exit 1; }

docker run --rm -i --network none \
  -v "$PWD/scripts/staging/staging-guard.sh:/guard.sh:ro" \
  --entrypoint bash "$IMAGE" -s <<'INNER'
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "fixture container must run as root" >&2; exit 1; }

pass=0; fail=0
ok(){ printf '  [ PASS ] %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }

SHIM=/shim; mkdir -p "$SHIM"; export PATH="$SHIM:$PATH"

# ---- fixture builders ------------------------------------------------------
set_hostname() { # <short> <fqdn>
  printf '#!/bin/bash\n[ "${1:-}" = -f ] && echo "%s" || echo "%s"\n' "$2" "$1" > "$SHIM/hostname"
  chmod 755 "$SHIM/hostname"
}
set_docker() { # <container-names-newline-separated> <db-names-newline-separated>
  { printf '#!/bin/bash\n'
    printf 'case "$1" in\n'
    printf '  ps)      cat <<'"'"'EOFC'"'"'\n%s\nEOFC\n           ;;\n' "$1"
    printf '  inspect) grep -qxF "$2" <<'"'"'EOFI'"'"'\n%s\nEOFI\n           exit $? ;;\n' "$1"
    printf '  exec)    cat <<'"'"'EOFD'"'"'\n%s\nEOFD\n           ;;\n' "$2"
    printf '  *)       exit 0 ;;\nesac\n'
  } > "$SHIM/docker"
  chmod 755 "$SHIM/docker"
}
make_marker() { # <path> <env> <host> <fqdn> [mode]
  printf 'ENVIRONMENT=%s\nHOSTNAME=%s\nFQDN=%s\n' "$2" "$3" "$4" > "$1"
  chown 0:0 "$1"; chmod "${5:-0400}" "$1"
}
make_envfile() { : > "$1"; chown 0:0 "$1"; chmod 0600 "$1"; }

run_guard() { # -> prints exit code
  ( set +u
    export NEXORA_STAGING_MARKER NEXORA_STAGING_ENV_FILE NEXORA_PRODUCTION_ENV_FILE
    source /guard.sh
    staging_guard >/dev/null 2>&1
    echo $? )
}

WORK=$(mktemp -d)
export NEXORA_STAGING_MARKER="$WORK/nexora-environment"
export NEXORA_STAGING_ENV_FILE="$WORK/staging.env"
export NEXORA_PRODUCTION_ENV_FILE="$WORK/prod.env"

STAGING_CONTAINERS=$'nexora-staging-postgres-1\nnexora-staging-api-1\nnexora-staging-web-1'
PROD_CONTAINERS=$'nexora-postgres-1\nnexora-api-1\nnexora-web-1'
STAGING_DBS=$'nexora_staging\npostgres'
PROD_DBS=$'nexora_staging\nnexora\npostgres'

reset_valid_staging() {
  rm -f "$NEXORA_PRODUCTION_ENV_FILE"
  make_marker "$NEXORA_STAGING_MARKER" staging nexora-staging nexora-staging.design.local
  make_envfile "$NEXORA_STAGING_ENV_FILE"
  set_hostname nexora-staging nexora-staging.design.local
  set_docker "$STAGING_CONTAINERS" "$STAGING_DBS"
}

echo
echo "=== staging-guard regression ==="

# 1 -------------------------------------------------------------------------
reset_valid_staging
rc=$(run_guard)
[ "$rc" -eq 0 ] && ok "fully valid staging fixture accepted (exit 0)" \
                || no "valid staging fixture rejected (exit $rc)"

# 2 -------------------------------------------------------------------------
reset_valid_staging; rm -f "$NEXORA_STAGING_MARKER"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "missing staging marker refused (exit $rc)" \
                || no "missing marker accepted"

# 2b ------------------------------------------------------------------------
reset_valid_staging; make_marker "$NEXORA_STAGING_MARKER" production Nexora nexora.design.local
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "marker declaring ENVIRONMENT=production refused (exit $rc)" \
                || no "production marker accepted"

# 2c ------------------------------------------------------------------------
reset_valid_staging; chmod 0644 "$NEXORA_STAGING_MARKER"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "marker with wrong mode (0644, not 0400) refused (exit $rc)" \
                || no "world-readable marker accepted"

# 3 -------------------------------------------------------------------------
reset_valid_staging; set_docker "$PROD_CONTAINERS" "$STAGING_DBS"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "Production container identity refused (exit $rc)" \
                || no "Production containers accepted"

# 4 -------------------------------------------------------------------------
# This is the exact case the `&& rc=1` bug broke: the refusal was printed but
# rc was never set, so the guard returned success on a Production database.
reset_valid_staging; set_docker "$STAGING_CONTAINERS" "$PROD_DBS"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "Production database 'nexora' refused (exit $rc) [&&-vs-|| regression]" \
                || no "REGRESSION: Production database detected but guard returned 0"

# 5 -------------------------------------------------------------------------
reset_valid_staging
set_docker "$(printf '%s\n%s' "$STAGING_CONTAINERS" "$PROD_CONTAINERS")" "$PROD_DBS"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "mixed Production/Staging identity refused (exit $rc)" \
                || no "mixed identity accepted"

# 6 -------------------------------------------------------------------------
reset_valid_staging; set_hostname nexora-prod nexora-prod.design.local
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "wrong hostname refused (exit $rc)" || no "wrong hostname accepted"

# 7 -------------------------------------------------------------------------
reset_valid_staging
make_marker "$NEXORA_STAGING_MARKER" staging nexora-staging staging.nexora.design.local
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "legacy FQDN staging.nexora.design.local refused (exit $rc)" \
                || no "legacy shared-host FQDN accepted"

# 8 -------------------------------------------------------------------------
reset_valid_staging; make_envfile "$NEXORA_PRODUCTION_ENV_FILE"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "production env file present refused (exit $rc)" \
                || no "production env file accepted"

# 9 -------------------------------------------------------------------------
reset_valid_staging; chmod 0644 "$NEXORA_STAGING_ENV_FILE"
rc=$(run_guard)
[ "$rc" -ne 0 ] && ok "staging env file with wrong mode refused (exit $rc)" \
                || no "0644 staging env file accepted"

# 10 ------------------------------------------------------------------------
reset_valid_staging; set_docker "$STAGING_CONTAINERS" "$STAGING_DBS"
rc=$(run_guard)
[ "$rc" -eq 0 ] && ok "guard returns to accepting after every negative case" \
                || no "guard did not recover (exit $rc)"

rm -rf "$WORK"
echo
echo "GUARD_REGRESSION: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
INNER
