#!/usr/bin/env bash
# Builds the immutable, labelled images that staging and production run.
#
#   scripts/env/build-release.sh "Nexora First Customer RC1"
#
# Produces:
#   nexora-api:<release-slug>-<short-sha>
#   nexora-web:<release-slug>-<short-sha>
#   nexora-migrate:<release-slug>-<short-sha>
#
# Every image carries its provenance as OCI labels, so a running container can
# always be traced back to an exact source tree:
#
#   org.nexora.release        release name
#   org.opencontainers.image.revision   commit SHA
#   org.nexora.source.tree    git tree hash (content identity, not just commit)
#   org.opencontainers.image.created    build timestamp
#   org.nexora.version        Agent/product version
#
# The tree hash matters more than the commit SHA: two commits can share a
# tree, and a commit SHA says nothing about whether the build actually used
# that content. Recording the tree lets a deployment be verified by content.
#
# Refuses to build from a dirty worktree. A release built from uncommitted
# changes is unreviewable and unreproducible - and this worktree currently has
# uncommitted work (Remote Desktop) that is explicitly excluded from RC1.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nexora-env.sh"

# The source to build is normally this worktree, but a release is usually cut
# from a *different* commit than the one being developed - and that commit
# predates this script, so the script cannot live inside it. NEXORA_BUILD_SOURCE_DIR
# lets the current tooling build an older checkout:
#
#   git worktree add /tmp/nexora-rc1 <release-commit>
#   NEXORA_BUILD_SOURCE_DIR=/tmp/nexora-rc1 \
#     scripts/env/build-release.sh "Nexora First Customer RC1"
#
# A clean, detached checkout of the exact release commit is the only thing
# that can honestly claim to be that release.
build_src="${NEXORA_BUILD_SOURCE_DIR:-$NEXORA_REPO_ROOT}"
if [ ! -d "$build_src/.git" ] && [ ! -f "$build_src/.git" ]; then
  nexora_env_die "NEXORA_BUILD_SOURCE_DIR='${build_src}' is not a git worktree."
fi
cd "$build_src"

release="${1:-${NEXORA_RELEASE:-}}"
if [ -z "$release" ]; then
  nexora_env_die "no release name given.

  scripts/env/build-release.sh \"Nexora First Customer RC1\""
fi

if [ -n "$(git status --porcelain)" ]; then
  nexora_env_die "the worktree is dirty.

A release image must correspond to a reviewed commit. Uncommitted changes
present:

$(git status --short | sed 's/^/  /')"
fi

sha="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short HEAD)"
tree="$(git rev-parse HEAD^{tree})"
created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
version="$(grep -oP '(?<=<Version>)[^<]+' agent/Nexora.Agent/Nexora.Agent.csproj | head -n1 || echo "0.0.0")"
slug="$(printf '%s' "$release" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9._-')"
tag="${slug}-${short_sha}"

printf 'release : %s\ncommit  : %s\ntree    : %s\ntag     : %s\n\n' "$release" "$sha" "$tree" "$tag"

for target in api web migrate; do
  printf '==> building nexora-%s:%s\n' "$target" "$tag"
  docker build \
    --target "$target" \
    --label "org.nexora.release=${release}" \
    --label "org.nexora.source.tree=${tree}" \
    --label "org.nexora.version=${version}" \
    --label "org.nexora.environment=immutable-release" \
    --label "org.opencontainers.image.revision=${sha}" \
    --label "org.opencontainers.image.created=${created}" \
    --label "org.opencontainers.image.version=${version}" \
    --label "org.opencontainers.image.title=nexora-${target}" \
    -t "nexora-${target}:${tag}" \
    .
done

cat <<EOF

Built. To run this release:

  export NEXORA_RELEASE='${release}'
  export NEXORA_RELEASE_TREE='${tree}'
  export NEXORA_IMAGE_API='nexora-api:${tag}'
  export NEXORA_IMAGE_WEB='nexora-web:${tag}'
  export NEXORA_IMAGE_MIGRATE='nexora-migrate:${tag}'

  scripts/env/nexora-compose.sh staging up -d     # validate here first
EOF
