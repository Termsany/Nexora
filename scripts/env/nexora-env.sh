#!/usr/bin/env bash
# Single source of truth for Nexora environment identities.
#
# Sourced (never executed) by every environment-aware script. Defining the
# identities in exactly one place is what makes the guards trustworthy: a
# guard that carried its own copy of "which database is production" would
# drift away from the compose overlays it is supposed to protect.
#
#   . scripts/env/nexora-env.sh
#   nexora_env_resolve development     # exports NEXORA_* for that environment
#   nexora_env_require_non_production  # fail closed if it resolved to prod
#
# No secret values live here - only non-sensitive identities (project names,
# database names, volume names, hostnames, ports, and the *paths* of the
# secret files, not their contents).

# This file is a library: it deliberately does NOT set shell options, because
# `set -e` leaks into whoever sources it. Callers set their own.

NEXORA_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --------------------------------------------------------------------------
# Production identities that are LIVE right now
# --------------------------------------------------------------------------
# The running customer stack still uses the legacy identity "nexora": Compose
# project `nexora`, database `nexora`, volume `nexora_postgres-data`. It is
# deliberately NOT renamed by this change - renaming a running Compose project
# orphans its containers and detaches its data volume, which is exactly the
# kind of production impact this stage exists to prevent.
#
# Both the legacy identity and the target identity below are treated as
# production by every guard, so the protection applies before AND after the
# eventual cutover, and the cutover itself can be a separate approved
# operation rather than a prerequisite for having guards at all.
NEXORA_LEGACY_PROD_PROJECT="nexora"
NEXORA_LEGACY_PROD_DB="nexora"
NEXORA_LEGACY_PROD_USER="nexora"
NEXORA_LEGACY_PROD_VOLUME="nexora_postgres-data"

# Any of these appearing in a non-production context is a hard failure.
NEXORA_PRODUCTION_MARKERS=(
  "nexora-prod"
  "nexora_prod"
  "nexora-prod_postgres-data"
  "$NEXORA_LEGACY_PROD_PROJECT"
  "$NEXORA_LEGACY_PROD_DB"
  "$NEXORA_LEGACY_PROD_VOLUME"
  "nexora.design.local"
)

# Host paths that are visible to real customers. Nothing outside a production
# operation may write to them.
NEXORA_PRODUCTION_WRITE_PATHS=(
  "/srv/nexora/production/downloads"
  "${NEXORA_REPO_ROOT}/pilot/downloads"
  "/etc/nexora/pki"
  "/etc/nexora/env/production.env"
)

# --------------------------------------------------------------------------
# Environment registry
# --------------------------------------------------------------------------
# nexora_env_resolve <production|staging|development>
#
# Exports, for the selected environment:
#   NEXORA_ENV                 canonical environment name
#   NEXORA_COMPOSE_PROJECT     docker compose project name
#   NEXORA_COMPOSE_FILES       -f arguments for docker compose
#   NEXORA_ENV_FILE            path to the secret file (contents never read here)
#   NEXORA_PG_DB / _USER       database identity
#   NEXORA_PG_VOLUME           named volume (fully qualified, as docker shows it)
#   NEXORA_NETWORK             docker network name
#   NEXORA_HOSTNAME            public FQDN (kept as the historical name;
#                              every existing consumer reads it as an FQDN)
#   NEXORA_FQDN                explicit alias of NEXORA_HOSTNAME
#   NEXORA_SHORT_HOSTNAME      unqualified host label (e.g. nexora-staging)
#   NEXORA_HTTP_PORT / _HTTPS_PORT
#   NEXORA_DOWNLOADS_DIR       Agent artifact publish target
#   NEXORA_IS_PRODUCTION       true|false
nexora_env_resolve() {
  local env="${1:-}"

  case "$env" in
    prod | production)
      NEXORA_ENV="production"
      NEXORA_COMPOSE_PROJECT="nexora-prod"
      NEXORA_COMPOSE_FILES="-f ${NEXORA_REPO_ROOT}/compose.yaml -f ${NEXORA_REPO_ROOT}/compose.prod.yaml"
      NEXORA_ENV_FILE="/etc/nexora/env/production.env"
      NEXORA_PG_DB="nexora_prod"
      NEXORA_PG_USER="nexora_prod"
      NEXORA_PG_VOLUME="nexora-prod_postgres-data"
      NEXORA_NETWORK="nexora-prod_default"
      NEXORA_HOSTNAME="nexora.design.local"
      NEXORA_SHORT_HOSTNAME="Nexora"
      NEXORA_HTTP_PORT="80"
      NEXORA_HTTPS_PORT="443"
      NEXORA_DOWNLOADS_DIR="/srv/nexora/production/downloads"
      NEXORA_IS_PRODUCTION="true"
      ;;
    staging | stage)
      NEXORA_ENV="staging"
      NEXORA_COMPOSE_PROJECT="nexora-staging"
      NEXORA_COMPOSE_FILES="-f ${NEXORA_REPO_ROOT}/compose.yaml -f ${NEXORA_REPO_ROOT}/compose.staging.yaml"
      NEXORA_ENV_FILE="/etc/nexora/env/staging.env"
      NEXORA_PG_DB="nexora_staging"
      NEXORA_PG_USER="nexora_staging"
      NEXORA_PG_VOLUME="nexora-staging_postgres-data"
      NEXORA_NETWORK="nexora-staging_default"
      # Staging runs on its OWN dedicated VM (created at the VMware layer),
      # so it uses the same ports and URL shape production does. The former
      # 8081/8444 offsets existed only to avoid colliding with production on
      # a shared host; that design is obsolete and deliberately not retained.
      NEXORA_HOSTNAME="nexora-staging.design.local"
      NEXORA_SHORT_HOSTNAME="nexora-staging"
      NEXORA_HTTP_PORT="80"
      NEXORA_HTTPS_PORT="443"
      NEXORA_DOWNLOADS_DIR="/srv/nexora/staging/downloads"
      NEXORA_IS_PRODUCTION="false"
      ;;
    dev | development | local)
      NEXORA_ENV="development"
      NEXORA_COMPOSE_PROJECT="nexora-dev"
      NEXORA_COMPOSE_FILES="-f ${NEXORA_REPO_ROOT}/compose.yaml -f ${NEXORA_REPO_ROOT}/compose.dev.yaml"
      NEXORA_ENV_FILE="${NEXORA_REPO_ROOT}/.env.development"
      NEXORA_PG_DB="nexora_dev"
      NEXORA_PG_USER="nexora_dev"
      NEXORA_PG_VOLUME="nexora-dev_postgres-data"
      NEXORA_NETWORK="nexora-dev_default"
      NEXORA_HOSTNAME="localhost"
      NEXORA_SHORT_HOSTNAME="localhost"
      NEXORA_HTTP_PORT="8080"
      NEXORA_HTTPS_PORT="8443"
      NEXORA_DOWNLOADS_DIR="${NEXORA_REPO_ROOT}/.local/dev-downloads"
      NEXORA_IS_PRODUCTION="false"
      ;;
    "")
      nexora_env_die "no environment selected.

Every Nexora operation must name its target environment explicitly - there is
no default, because the only safe default would be the one that can damage
customers. Pass one of:

  production | staging | development

either as the first argument or via NEXORA_ENV."
      ;;
    *)
      nexora_env_die "unknown environment '${env}' (expected production, staging, or development)."
      ;;
  esac

  export NEXORA_ENV NEXORA_COMPOSE_PROJECT NEXORA_COMPOSE_FILES NEXORA_ENV_FILE
  export NEXORA_PG_DB NEXORA_PG_USER NEXORA_PG_VOLUME NEXORA_NETWORK
  NEXORA_FQDN="$NEXORA_HOSTNAME"
  export NEXORA_HOSTNAME NEXORA_SHORT_HOSTNAME NEXORA_FQDN NEXORA_HTTP_PORT NEXORA_HTTPS_PORT
  export NEXORA_DOWNLOADS_DIR NEXORA_IS_PRODUCTION
}

nexora_env_die() {
  printf '\nREFUSED: %s\n\n' "$1" >&2
  exit 2
}

# Fail closed unless the resolved environment is production. Guards call this
# before doing anything a developer could regret.
nexora_env_require_non_production() {
  if [ "${NEXORA_IS_PRODUCTION:-}" = "true" ]; then
    nexora_env_die "this operation is not permitted against production."
  fi
}

# nexora_env_assert_no_production_marker <label> <value>
#
# Rejects a value that names any production identity. Used to catch the real
# failure mode: a developer running dev tooling with a stray DATABASE_URL,
# COMPOSE_PROJECT_NAME, or output path still pointing at the customer stack.
nexora_env_assert_no_production_marker() {
  local label="$1" value="${2:-}" marker token
  [ -n "$value" ] || return 0

  # Compare whole tokens rather than substrings. A substring test would reject
  # "nexora_dev" for containing "nexora" - noise that developers learn to work
  # around - while a naive prefix/suffix test misses the case that actually
  # matters, a production host buried mid-URL
  # (postgresql://u:p@nexora.design.local:5432/nexora_dev).
  #
  # Splitting a URL on its structural delimiters leaves exactly the parts that
  # carry identity: scheme, user, password, host, port, database, query keys.
  local -a tokens
  IFS='/:@?&=, ' read -r -a tokens <<<"$value"

  for token in "${tokens[@]}"; do
    for marker in "${NEXORA_PRODUCTION_MARKERS[@]}"; do
      if [ "$token" = "$marker" ]; then
        nexora_env_die "${label} names the production identity '${marker}'.

Refusing to continue: this is a '${NEXORA_ENV:-unset}' operation, not production.

  ${label} = ${value}

If you meant to work on production, run the operation with an explicit
production target and the approval it requires."
      fi
    done
  done
}

# Rejects a filesystem path that is customer-visible.
nexora_env_assert_not_production_path() {
  local label="$1" value="${2:-}" prod_path resolved
  [ -n "$value" ] || return 0
  resolved="$(cd "$(dirname "$value")" 2>/dev/null && pwd)/$(basename "$value")" || resolved="$value"

  for prod_path in "${NEXORA_PRODUCTION_WRITE_PATHS[@]}"; do
    case "$resolved" in
      "$prod_path" | "$prod_path"/*)
        nexora_env_die "${label} points into a customer-visible production path.

  ${label} = ${resolved}
  production path = ${prod_path}

Environment is '${NEXORA_ENV:-unset}'. Development and staging must never
write where production reads."
        ;;
    esac
  done
}

# Human approval + immutable release, required for every production write.
nexora_env_require_production_approval() {
  local operation="${1:-operation}"

  if [ "${NEXORA_IS_PRODUCTION:-}" != "true" ]; then
    nexora_env_die "internal error: production approval requested for '${NEXORA_ENV:-unset}'."
  fi

  if [ "${NEXORA_PRODUCTION_CONFIRM:-}" != "I UNDERSTAND THIS TARGETS PRODUCTION" ]; then
    nexora_env_die "production ${operation} requires explicit human approval.

Set, in the interactive shell performing the operation:

  export NEXORA_PRODUCTION_CONFIRM='I UNDERSTAND THIS TARGETS PRODUCTION'

This is intentionally awkward to type and intentionally absent from every
script, so it cannot be satisfied by accident or by automation."
  fi

  if [ -z "${NEXORA_RELEASE:-}" ]; then
    nexora_env_die "production ${operation} requires an approved release name.

  export NEXORA_RELEASE='Nexora First Customer RC1'"
  fi
}
