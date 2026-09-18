#!/usr/bin/env bash
# Environment-aware `docker compose` wrapper.
#
#   scripts/env/nexora-compose.sh development up -d
#   scripts/env/nexora-compose.sh staging up -d
#   scripts/env/nexora-compose.sh production up -d      # requires approval
#
# This exists because plain `docker compose up` inside this worktree is
# currently a production operation: compose.yaml declares `name: nexora`,
# which is the live customer stack. The wrapper removes the possibility of
# performing that operation by accident - there is no default environment, and
# production additionally requires human approval and a pinned release.
#
# Destructive subcommands (down -v, rm, kill) are refused against production
# outright; those belong in the backup/restore runbook (PR-04), not here.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nexora-env.sh"

env_arg="${1:-${NEXORA_ENV:-}}"
[ $# -gt 0 ] && shift || true
nexora_env_resolve "$env_arg"

if [ $# -eq 0 ]; then
  nexora_env_die "no docker compose subcommand given (e.g. 'up -d', 'ps', 'logs')."
fi

subcommand="$1"

# --------------------------------------------------------------------------
# Guard 1 - a stray COMPOSE_PROJECT_NAME must not redirect this at production
# --------------------------------------------------------------------------
# Docker Compose gives COMPOSE_PROJECT_NAME precedence over the `name:` field
# in the compose file, so an exported variable left over from an earlier
# session would silently retarget the whole stack. Catch it rather than
# quietly honouring it.
if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "${COMPOSE_PROJECT_NAME}" != "${NEXORA_COMPOSE_PROJECT}" ]; then
  nexora_env_die "COMPOSE_PROJECT_NAME is set to '${COMPOSE_PROJECT_NAME}' but this is a
'${NEXORA_ENV}' operation, which must run as '${NEXORA_COMPOSE_PROJECT}'.

Unset it (unset COMPOSE_PROJECT_NAME) and re-run."
fi
export COMPOSE_PROJECT_NAME="$NEXORA_COMPOSE_PROJECT"

# --------------------------------------------------------------------------
# Guard 2 - non-production must not inherit production connection strings
# --------------------------------------------------------------------------
if [ "$NEXORA_IS_PRODUCTION" != "true" ]; then
  nexora_env_assert_no_production_marker "DATABASE_URL" "${DATABASE_URL:-}"
  nexora_env_assert_no_production_marker "API_BASE_URL" "${API_BASE_URL:-}"
fi

# --------------------------------------------------------------------------
# Guard 3 - production requires approval, a release, and immutable images
# --------------------------------------------------------------------------
if [ "$NEXORA_IS_PRODUCTION" = "true" ]; then
  case "$subcommand" in
    ps | logs | config | top | events | images | version)
      : # read-only, always allowed
      ;;
    down | rm | kill | stop)
      nexora_env_die "'${subcommand}' against production is not permitted through this wrapper.

Taking the customer stack down is a planned maintenance operation with a
backup taken first. Follow docs/environment-isolation.md and the PR-04
backup/restore runbook."
      ;;
    build | push)
      nexora_env_die "production images are never built here.

Production runs reviewed, immutable images only. Build a release with
scripts/env/build-release.sh, verify it, then deploy it by tag."
      ;;
    *)
      nexora_env_require_production_approval "'${subcommand}'"

      for var in NEXORA_IMAGE_API NEXORA_IMAGE_WEB NEXORA_IMAGE_MIGRATE; do
        if [ -z "${!var:-}" ]; then
          nexora_env_die "production ${subcommand} requires ${var} to name an approved immutable image tag."
        fi
        if ! docker image inspect "${!var}" >/dev/null 2>&1; then
          nexora_env_die "${var}='${!var}' does not exist locally.

Production never builds and never pulls implicitly. The approved image must
already be present on this host."
        fi

        # Existing is not the same as approved. An image tagged
        # "nexora-api:first-customer-rc1" with no labels looks like a release
        # and is not one - it cannot be traced to any source tree. Require the
        # provenance scripts/env/build-release.sh stamps on.
        image_labels="$(docker image inspect "${!var}" --format '{{json .Config.Labels}}')"
        for label in org.nexora.release org.nexora.source.tree org.opencontainers.image.revision; do
          if ! printf '%s' "$image_labels" | grep -q "\"${label}\""; then
            nexora_env_die "${var}='${!var}' is missing the '${label}' label.

Production runs only images built by scripts/env/build-release.sh from a
clean checkout, so that every running container can be traced back to an
exact source tree. This image cannot be."
          fi
        done

        # And it must be the release actually being deployed.
        image_tree="$(docker image inspect "${!var}" --format '{{index .Config.Labels "org.nexora.source.tree"}}')"
        if [ -n "${NEXORA_RELEASE_TREE:-}" ] && [ "$image_tree" != "$NEXORA_RELEASE_TREE" ]; then
          nexora_env_die "${var}='${!var}' was built from tree ${image_tree},
but the approved release tree is ${NEXORA_RELEASE_TREE}."
        fi
      done
      ;;
  esac
fi

# --------------------------------------------------------------------------
# Secret file
# --------------------------------------------------------------------------
env_file_args=()
if [ -f "$NEXORA_ENV_FILE" ]; then
  perms="$(stat -c '%a' "$NEXORA_ENV_FILE")"
  case "$perms" in
    600 | 400) : ;;
    *)
      nexora_env_die "${NEXORA_ENV_FILE} has permissions ${perms}; expected 600.

  chmod 600 ${NEXORA_ENV_FILE}"
      ;;
  esac
  env_file_args=(--env-file "$NEXORA_ENV_FILE")
elif [ "$NEXORA_ENV" = "development" ]; then
  nexora_env_die "missing ${NEXORA_ENV_FILE}.

Create it from the template (the values in it are disposable test values, not
secrets):

  cp .env.development.example .env.development && chmod 600 .env.development"
else
  nexora_env_die "missing ${NEXORA_ENV_FILE}. ${NEXORA_ENV} secrets are provisioned on the
host, outside every developer worktree, and are never stored in git."
fi

printf 'environment : %s\nproject     : %s\ndatabase    : %s\nvolume      : %s\nenv file    : %s\n\n' \
  "$NEXORA_ENV" "$NEXORA_COMPOSE_PROJECT" "$NEXORA_PG_DB" "$NEXORA_PG_VOLUME" "$NEXORA_ENV_FILE"

# shellcheck disable=SC2086 # NEXORA_COMPOSE_FILES is a deliberate -f word list
exec docker compose "${env_file_args[@]}" $NEXORA_COMPOSE_FILES "$@"
