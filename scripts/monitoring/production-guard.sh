#!/usr/bin/env bash
# Nexora PRODUCTION deployment guard.
#
# Deliberately NOT scripts/staging/staging-guard.sh. That guard proves "this is
# staging" and refuses production. This one proves "this is the expected
# production host" and refuses anything else - including staging. The two are
# mirror images and neither may substitute for the other.
#
#   source scripts/monitoring/production-guard.sh
#   production_guard            || exit 1     # identity only
#   production_deploy_approved  || exit 1     # explicit human approval
#
# IDENTITY IS NOT AUTHORIZATION. production_guard() proves *where* you are. It
# never authorizes a mutation on its own. Every mutating entrypoint must call
# production_deploy_approved() as well, which requires an approval phrase a
# human typed in this shell. Fails closed everywhere.

NEXORA_ENV_MARKER="${NEXORA_ENV_MARKER:-/etc/nexora-environment}"
NEXORA_PROD_HOSTNAME="${NEXORA_PROD_HOSTNAME:-Nexora}"
NEXORA_PROD_PROJECT="${NEXORA_PROD_PROJECT:-nexora}"
NEXORA_PROD_DB="${NEXORA_PROD_DB:-nexora}"
NEXORA_PROD_PG="${NEXORA_PROD_PG:-nexora-postgres-1}"
NEXORA_STAGING_PROJECT="${NEXORA_STAGING_PROJECT:-nexora-staging}"
NEXORA_STAGING_MARKER_LEGACY="${NEXORA_STAGING_MARKER_LEGACY:-/etc/nexora-staging-host}"

NEXORA_PROD_CONTAINERS=(
  nexora-postgres-1 nexora-api-1 nexora-web-1
  nexora-maintenance-1 nexora-notification-worker-1
)

NEXORA_DEPLOY_APPROVAL_PHRASE='I UNDERSTAND THIS DEPLOYS MONITORING TO PRODUCTION'

_pg_fail() { printf 'REFUSED [%s]: %s\n' "$1" "$2" >&2; return 1; }

production_guard() {
  local rc=0 host_now
  host_now="$(hostname)"

  # --- 1. explicit production marker ---------------------------------------
  if [ -L "$NEXORA_ENV_MARKER" ]; then
    _pg_fail marker "$NEXORA_ENV_MARKER is a symlink" || rc=1
  elif [ ! -f "$NEXORA_ENV_MARKER" ]; then
    _pg_fail marker "no environment marker at $NEXORA_ENV_MARKER - absence is never read as 'probably production'" || rc=1
  else
    local mo; mo="$(stat -c '%u:%g:%a' "$NEXORA_ENV_MARKER" 2>/dev/null)"
    [ "$mo" = "0:0:400" ] || _pg_fail marker "marker must be root:root 0400 (found $mo)" || rc=1
    grep -qxF 'ENVIRONMENT=production' "$NEXORA_ENV_MARKER" 2>/dev/null \
      || _pg_fail marker "marker does not contain ENVIRONMENT=production" || rc=1
    if grep -qiE '^ENVIRONMENT=staging' "$NEXORA_ENV_MARKER" 2>/dev/null; then
      _pg_fail marker "marker declares ENVIRONMENT=staging" || rc=1
    fi
  fi

  # --- 2. hostname ----------------------------------------------------------
  [ "$host_now" = "$NEXORA_PROD_HOSTNAME" ] \
    || _pg_fail hostname "hostname '$host_now' != expected production host '$NEXORA_PROD_HOSTNAME'" || rc=1

  # --- 3/4. production compose project and containers -----------------------
  local names
  if ! names="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"; then
    _pg_fail docker "cannot query the Docker daemon (failing closed)" || rc=1
  else
    local c
    for c in "${NEXORA_PROD_CONTAINERS[@]}"; do
      grep -qxF "$c" <<<"$names" || _pg_fail docker "expected production container absent: $c" || rc=1
    done
    # --- 6. staging identity must be absent --------------------------------
    if grep -qE "^${NEXORA_STAGING_PROJECT}-" <<<"$names"; then
      _pg_fail staging "staging compose identity (${NEXORA_STAGING_PROJECT}-*) present on this host" || rc=1
    fi
  fi

  # --- 5. production database identity --------------------------------------
  local dbs
  if ! docker inspect "$NEXORA_PROD_PG" >/dev/null 2>&1; then
    _pg_fail database "production postgres container '$NEXORA_PROD_PG' not found" || rc=1
  elif ! dbs="$(docker exec "$NEXORA_PROD_PG" sh -c \
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT datname FROM pg_database"' 2>/dev/null)"; then
    _pg_fail database "cannot enumerate databases in '$NEXORA_PROD_PG' (failing closed)" || rc=1
  else
    grep -qxF "$NEXORA_PROD_DB" <<<"$dbs" \
      || _pg_fail database "expected production database '$NEXORA_PROD_DB' not present" || rc=1
    if grep -qxF 'nexora_staging' <<<"$dbs"; then
      _pg_fail staging "staging database 'nexora_staging' present on this daemon" || rc=1
    fi
  fi

  # --- 6b. no staging filesystem identity -----------------------------------
  [ ! -e "$NEXORA_STAGING_MARKER_LEGACY" ] \
    || _pg_fail staging "legacy staging marker present at $NEXORA_STAGING_MARKER_LEGACY" || rc=1
  [ ! -e /etc/nexora/env/staging.env ] \
    || _pg_fail staging "staging env file present at /etc/nexora/env/staging.env" || rc=1

  if [ "$rc" -ne 0 ]; then
    printf '\nproduction_guard: REFUSING. This host is not the verified production target.\n' >&2
    return 1
  fi
  printf 'production_guard: identity OK - verified production host (%s)\n' "$host_now" >&2
  printf 'production_guard: identity is NOT authorization; an approved mutation also needs production_deploy_approved.\n' >&2
  return 0
}

# Explicit, human-typed approval. Separate from identity on purpose: being on
# production is exactly when an accidental run is most damaging.
production_deploy_approved() {
  local operation="${1:-monitoring deployment}"
  [ "${EUID:-$(id -u)}" -eq 0 ] || { _pg_fail privilege "root operator required for $operation"; return 1; }
  if [ "${NEXORA_PRODUCTION_DEPLOY_APPROVED:-}" != "$NEXORA_DEPLOY_APPROVAL_PHRASE" ]; then
    cat >&2 <<EOF

REFUSED [approval]: production $operation requires explicit human approval.

Set, in the interactive shell performing the operation:

  export NEXORA_PRODUCTION_DEPLOY_APPROVED='$NEXORA_DEPLOY_APPROVAL_PHRASE'

Intentionally awkward to type and intentionally absent from every script, so
it cannot be satisfied by accident or by automation. Setting it authorizes
ONLY the operation you are about to run, on this host, now.

EOF
    return 1
  fi
  printf 'production_deploy_approved: operator approval present for %s.\n' "$operation" >&2
  return 0
}
