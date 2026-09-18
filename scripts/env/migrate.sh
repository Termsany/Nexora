#!/usr/bin/env bash
# Environment-aware migration runner - the only sanctioned way to run
# drizzle-kit against any Nexora database.
#
#   scripts/env/migrate.sh development
#   scripts/env/migrate.sh staging
#   scripts/env/migrate.sh production          # requires approval + release
#
# Why this exists
# ---------------
# `pnpm --filter @workspace/db run migrate` applies whatever is in
# lib/db/drizzle to whatever DATABASE_URL happens to be exported. In a
# worktree that has an uncommitted migration (as this one does), and a shell
# that has ever touched production, that is a one-command production schema
# change. This wrapper makes the target explicit and refuses the combinations
# that cannot be undone.
#
# `drizzle-kit push` is destructive schema diffing with no migration history.
# It is permitted in development only, and this script is the only place that
# says so.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nexora-env.sh"

env_arg="${1:-${NEXORA_ENV:-}}"
mode="${2:-migrate}"
nexora_env_resolve "$env_arg"

case "$mode" in
  migrate | push | generate) : ;;
  *) nexora_env_die "unknown mode '${mode}' (expected migrate, push, or generate)." ;;
esac

# --------------------------------------------------------------------------
# `push` is development-only, unconditionally
# --------------------------------------------------------------------------
if [ "$mode" = "push" ] && [ "$NEXORA_ENV" != "development" ]; then
  nexora_env_die "'drizzle-kit push' is permitted in development only.

push diffs the schema and applies the difference directly, with no versioned
migration and no record in drizzle.__drizzle_migrations. Staging and
production apply reviewed, ordered migration files - nothing else."
fi

# --------------------------------------------------------------------------
# Resolve the target URL and prove it is the intended database
# --------------------------------------------------------------------------
# An inherited DATABASE_URL is the single most likely way a developer ends up
# migrating production, so it is never trusted: outside production it must
# either be absent or already point at this environment's database.
if [ "$NEXORA_IS_PRODUCTION" != "true" ]; then
  nexora_env_assert_no_production_marker "inherited DATABASE_URL" "${DATABASE_URL:-}"

  if [ -n "${DATABASE_URL:-}" ] && [[ "${DATABASE_URL}" != *"/${NEXORA_PG_DB}" ]]; then
    nexora_env_die "inherited DATABASE_URL does not target the ${NEXORA_ENV} database.

  expected database : ${NEXORA_PG_DB}
  DATABASE_URL ends : ${DATABASE_URL##*/}

Unset DATABASE_URL and let this script derive it, or point it at ${NEXORA_PG_DB}."
  fi
fi

if [ "$NEXORA_ENV" = "development" ]; then
  : "${NEXORA_DEV_PG_PORT:=55430}"
  target_url="${DATABASE_URL:-postgresql://nexora_dev:dev-disposable-not-a-secret@127.0.0.1:${NEXORA_DEV_PG_PORT}/nexora_dev}"
else
  if [ ! -f "$NEXORA_ENV_FILE" ]; then
    nexora_env_die "missing ${NEXORA_ENV_FILE}; ${NEXORA_ENV} credentials are provisioned on the host."
  fi
  # Read the URL out of the env file without echoing it anywhere.
  target_url="$(grep -m1 '^DATABASE_URL=' "$NEXORA_ENV_FILE" | cut -d= -f2- || true)"
  if [ -z "$target_url" ]; then
    nexora_env_die "${NEXORA_ENV_FILE} does not define DATABASE_URL."
  fi
fi

# Final sanity check on the derived URL, whichever path produced it.
if [ "$NEXORA_IS_PRODUCTION" != "true" ]; then
  nexora_env_assert_no_production_marker "resolved migration target" "$target_url"
fi
if [[ "$target_url" != *"/${NEXORA_PG_DB}" ]]; then
  nexora_env_die "resolved migration target is not the ${NEXORA_ENV} database '${NEXORA_PG_DB}'."
fi

# --------------------------------------------------------------------------
# Production: approval, pinned release, clean worktree
# --------------------------------------------------------------------------
if [ "$NEXORA_IS_PRODUCTION" = "true" ]; then
  nexora_env_require_production_approval "migration"

  if [ -n "$(git -C "$NEXORA_REPO_ROOT" status --porcelain)" ]; then
    nexora_env_die "the worktree is dirty.

Production migrations run from a clean, reviewed tree only - otherwise the
migration set being applied is whatever the developer happened to have open.
This worktree currently has uncommitted changes, including migrations that
are not part of any approved release."
  fi

  if [ -n "${NEXORA_RELEASE_TREE:-}" ]; then
    actual_tree="$(git -C "$NEXORA_REPO_ROOT" rev-parse HEAD^{tree})"
    if [ "$actual_tree" != "$NEXORA_RELEASE_TREE" ]; then
      nexora_env_die "worktree tree ${actual_tree} does not match the approved release tree ${NEXORA_RELEASE_TREE}."
    fi
  fi

  printf '\nAbout to apply migrations to PRODUCTION.\n  release  : %s\n  database : %s\n\n' \
    "$NEXORA_RELEASE" "$NEXORA_PG_DB"
  read -r -p "Type the database name to proceed: " typed
  if [ "$typed" != "$NEXORA_PG_DB" ]; then
    nexora_env_die "confirmation did not match; nothing was applied."
  fi
fi

printf 'environment : %s\nmode        : %s\ndatabase    : %s\n\n' "$NEXORA_ENV" "$mode" "$NEXORA_PG_DB"

DATABASE_URL="$target_url" exec pnpm --dir "$NEXORA_REPO_ROOT" --filter @workspace/db run "$mode"
