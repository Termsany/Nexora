#!/usr/bin/env bash
# Nexora staging safety guard.
#
# Sourced by any entrypoint that is about to perform a privileged, mutating
# operation which must only ever happen on the staging host. Supersedes
# scripts/monitoring/staging-guard.sh.
#
#   source scripts/staging/staging-guard.sh
#   staging_guard || exit 1
#
# Requires ALL SIX independent conditions to hold. Any single failure refuses.
# Fails closed: a missing marker, an unreadable file, or an unavailable Docker
# daemon is a refusal, never an assumption of safety.
#
# There is deliberately NO override. In the one real case so far where this
# guard's predecessor refused, the guard was right and the target was wrong.
# If an override is ever added it must take an explicit environment variable,
# print a loud multi-line warning, and be justified in writing.

NEXORA_STAGING_MARKER="${NEXORA_STAGING_MARKER:-/etc/nexora-environment}"
NEXORA_STAGING_HOSTNAME="${NEXORA_STAGING_HOSTNAME:-nexora-staging}"
NEXORA_STAGING_FQDN="${NEXORA_STAGING_FQDN:-nexora-staging.design.local}"
NEXORA_STAGING_DB="${NEXORA_STAGING_DB:-nexora_staging}"
NEXORA_STAGING_PROJECT="${NEXORA_STAGING_PROJECT:-nexora-staging}"
NEXORA_STAGING_ENV_FILE="${NEXORA_STAGING_ENV_FILE:-/etc/nexora/env/staging.env}"
NEXORA_PRODUCTION_ENV_FILE="${NEXORA_PRODUCTION_ENV_FILE:-/etc/nexora/.env}"

# Container names that positively identify the Production stack. Presence of
# ANY of these means the host is Production, whatever else it claims.
NEXORA_PRODUCTION_CONTAINERS=(
  nexora-postgres-1 nexora-api-1 nexora-web-1
  nexora-maintenance-1 nexora-notification-worker-1
)

_guard_fail() { printf 'REFUSED [%s]: %s\n' "$1" "$2" >&2; return 1; }

staging_guard() {
  local rc=0 hostname_now
  hostname_now="$(hostname)"

  # --- 1. environment marker ------------------------------------------------
  if [ -L "$NEXORA_STAGING_MARKER" ]; then
    _guard_fail marker "$NEXORA_STAGING_MARKER is a symlink" || rc=1
  elif [ ! -f "$NEXORA_STAGING_MARKER" ]; then
    _guard_fail marker "no environment marker at $NEXORA_STAGING_MARKER (absence is not 'probably staging')" || rc=1
  else
    local mode_owner
    mode_owner="$(stat -c '%u:%g:%a' "$NEXORA_STAGING_MARKER" 2>/dev/null)"
    [ "$mode_owner" = "0:0:400" ] || \
      _guard_fail marker "marker must be root:root mode 0400 (found $mode_owner)" || rc=1
    if grep -qiE '^ENVIRONMENT=production' "$NEXORA_STAGING_MARKER" 2>/dev/null; then
      _guard_fail marker "marker declares ENVIRONMENT=production" || rc=1
    fi
    grep -qxF 'ENVIRONMENT=staging' "$NEXORA_STAGING_MARKER" 2>/dev/null || \
      _guard_fail marker "marker does not contain ENVIRONMENT=staging" || rc=1
  fi

  # --- 2. hostname policy ---------------------------------------------------
  [ "$hostname_now" = "$NEXORA_STAGING_HOSTNAME" ] || \
    _guard_fail hostname "hostname '$hostname_now' != required '$NEXORA_STAGING_HOSTNAME'" || rc=1
  if [ -f "$NEXORA_STAGING_MARKER" ] && [ ! -L "$NEXORA_STAGING_MARKER" ]; then
    local marker_host
    marker_host="$(sed -n 's/^HOSTNAME=//p' "$NEXORA_STAGING_MARKER" 2>/dev/null | head -1)"
    [ -n "$marker_host" ] && [ "$marker_host" = "$hostname_now" ] || \
      _guard_fail hostname "marker HOSTNAME='$marker_host' does not match live hostname '$hostname_now'" || rc=1
  fi

  # --- 2b. FQDN policy ------------------------------------------------------
  # The marker is authoritative: `hostname -f` depends on resolver state and
  # can be empty or wrong on a half-configured box, so a mismatch there is a
  # refusal rather than something to paper over.
  if [ -f "$NEXORA_STAGING_MARKER" ] && [ ! -L "$NEXORA_STAGING_MARKER" ]; then
    local marker_fqdn
    marker_fqdn="$(sed -n 's/^FQDN=//p' "$NEXORA_STAGING_MARKER" 2>/dev/null | head -1)"
    [ "$marker_fqdn" = "$NEXORA_STAGING_FQDN" ] || \
      _guard_fail fqdn "marker FQDN='${marker_fqdn:-<absent>}' != required '$NEXORA_STAGING_FQDN'" || rc=1
  fi
  local fqdn_now
  fqdn_now="$(hostname -f 2>/dev/null || true)"
  if [ -n "$fqdn_now" ] && [ "$fqdn_now" != "$NEXORA_STAGING_FQDN" ]; then
    _guard_fail fqdn "resolved FQDN '$fqdn_now' != required '$NEXORA_STAGING_FQDN'" || rc=1
  fi
  case " $hostname_now ${NEXORA_ENV:-} ${NODE_ENV:-} " in
    *[Pp][Rr][Oo][Dd]*) _guard_fail hostname "production indicator in hostname/NEXORA_ENV/NODE_ENV" || rc=1 ;;
  esac

  # --- 3 & 4. Docker identity ----------------------------------------------
  local names
  if ! names="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"; then
    _guard_fail docker "cannot query the Docker daemon (failing closed)" || rc=1
  else
    local prod
    for prod in "${NEXORA_PRODUCTION_CONTAINERS[@]}"; do
      if grep -qxF "$prod" <<<"$names"; then
        _guard_fail docker "PRODUCTION container identity present: $prod" || rc=1
      fi
    done
    grep -qE "^${NEXORA_STAGING_PROJECT}-" <<<"$names" || \
      _guard_fail docker "no ${NEXORA_STAGING_PROJECT}-* container found; staging stack identity absent" || rc=1
  fi

  # --- 5. database identity -------------------------------------------------
  local pgc="${NEXORA_STAGING_PROJECT}-postgres-1" dbs
  if ! docker inspect "$pgc" >/dev/null 2>&1; then
    _guard_fail database "staging postgres container '$pgc' not found" || rc=1
  elif ! dbs="$(docker exec "$pgc" psql -U "${NEXORA_STAGING_DB}" -d "${NEXORA_STAGING_DB}" \
                  -tAc 'SELECT datname FROM pg_database' 2>/dev/null)"; then
    _guard_fail database "cannot enumerate databases in '$pgc' (failing closed)" || rc=1
  else
    grep -qxF "$NEXORA_STAGING_DB" <<<"$dbs" || \
      _guard_fail database "expected database '$NEXORA_STAGING_DB' not present" || rc=1
    # A database literally named "nexora" on this daemon means the customer
    # database is reachable from here. Refuse.
    # NOTE: must be `|| rc=1`, not `&& rc=1` — _guard_fail returns 1, so a
    # trailing `&& rc=1` would never execute and this refusal would be
    # printed but not enforced.
    if grep -qxF 'nexora' <<<"$dbs"; then
      _guard_fail database "PRODUCTION database name 'nexora' present on this daemon" || rc=1
    fi
  fi

  # --- 6. filesystem markers ------------------------------------------------
  if [ ! -f "$NEXORA_STAGING_ENV_FILE" ]; then
    _guard_fail filesystem "staging env file $NEXORA_STAGING_ENV_FILE absent" || rc=1
  else
    local envmode
    envmode="$(stat -c '%u:%g:%a' "$NEXORA_STAGING_ENV_FILE" 2>/dev/null)"
    [ "$envmode" = "0:0:600" ] || \
      _guard_fail filesystem "staging env file must be root:root 0600 (found $envmode)" || rc=1
  fi
  [ ! -e "$NEXORA_PRODUCTION_ENV_FILE" ] || \
    _guard_fail filesystem "production env file present at $NEXORA_PRODUCTION_ENV_FILE" || rc=1

  if [ "$rc" -ne 0 ]; then
    printf '\nstaging_guard: REFUSING. This host is not a verified staging target.\n' >&2
    return 1
  fi
  printf 'staging_guard: OK - verified staging target (%s)\n' "$hostname_now" >&2
  return 0
}

# Privileged entrypoints additionally require root; kept separate so the guard
# itself can be evaluated read-only by validate-staging-target.sh.
staging_guard_require_root() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || { printf 'REFUSED [privilege]: root operator required\n' >&2; return 1; }
}
