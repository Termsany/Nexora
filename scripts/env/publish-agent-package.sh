#!/usr/bin/env bash
# Environment-aware Windows Agent package publisher.
#
#   scripts/env/publish-agent-package.sh development
#   scripts/env/publish-agent-package.sh staging
#   scripts/env/publish-agent-package.sh production      # requires approval
#
# Why this exists
# ---------------
# scripts/build-windows-agent-package.sh writes to ./pilot/downloads, and that
# directory is bind-mounted read-only into the *running customer* web
# container as /usr/share/nginx/downloads. It is therefore not a build output
# directory at all - it is production content, living inside a developer
# worktree, writable by any developer, with the customer-facing filename
# nexora-agent-pilot.zip as its default output name.
#
# That means a developer testing an Agent build today silently replaces the
# package customers download. This wrapper is what separates the two: each
# environment publishes to its own directory, and only a production operation
# may write the production one.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nexora-env.sh"

nexora_env_resolve "${1:-${NEXORA_ENV:-}}"

if [ "$NEXORA_IS_PRODUCTION" = "true" ]; then
  nexora_env_require_production_approval "Agent package publish"
  if [ -n "$(git -C "$NEXORA_REPO_ROOT" status --porcelain)" ]; then
    nexora_env_die "the worktree is dirty; customer-visible Agent packages are built from a
clean, reviewed tree only."
  fi
else
  # Belt and braces: even if this script were edited to compute the wrong
  # directory, the path guard refuses anything customer-visible.
  nexora_env_assert_not_production_path "Agent output directory" "$NEXORA_DOWNLOADS_DIR"
fi

mkdir -p "$NEXORA_DOWNLOADS_DIR"

printf 'environment : %s\noutput      : %s\n\n' "$NEXORA_ENV" "$NEXORA_DOWNLOADS_DIR"

NEXORA_AGENT_OUT_DIR="$NEXORA_DOWNLOADS_DIR" \
  exec "${NEXORA_REPO_ROOT}/scripts/build-windows-agent-package.sh"
