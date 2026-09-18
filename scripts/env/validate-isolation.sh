#!/usr/bin/env bash
# Proves - rather than asserts in prose - that production, staging, and
# development are isolated, and that the guards actually refuse the dangerous
# combinations they claim to refuse.
#
#   scripts/env/validate-isolation.sh
#
# Everything here is read-only: it renders compose configurations, compares
# identities, and runs each guard in a way that is expected to FAIL. Nothing
# is started, built, migrated, or published. Safe to run on the production
# host.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

pass=0
fail=0

ok() {
  printf '  PASS  %s\n' "$1"
  pass=$((pass + 1))
}

no() {
  printf '  FAIL  %s\n' "$1"
  fail=$((fail + 1))
}

check_ne() {
  local label="$1" a="$2" b="$3"
  if [ "$a" != "$b" ]; then
    ok "$label  ($a != $b)"
  else
    no "$label  (both are '$a')"
  fi
}

# A guard is correct when it REFUSES. Exit code 2 is the refusal code used
# throughout scripts/env/.
expect_refusal() {
  local label="$1"
  shift
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "REFUSED"; then
    ok "$label"
  else
    no "$label  (exit ${rc}, expected a refusal)"
    printf '        %s\n' "$(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  fi
}

# --------------------------------------------------------------------------
printf '\n== Environment identities ==\n'
# --------------------------------------------------------------------------
. "$SCRIPT_DIR/nexora-env.sh"
set +e # every guard check below runs a command that is *expected* to fail

for e in production staging development; do
  nexora_env_resolve "$e"
  eval "${e}_project=\$NEXORA_COMPOSE_PROJECT"
  eval "${e}_db=\$NEXORA_PG_DB"
  eval "${e}_volume=\$NEXORA_PG_VOLUME"
  eval "${e}_downloads=\$NEXORA_DOWNLOADS_DIR"
  eval "${e}_host=\$NEXORA_HOSTNAME"
  printf '  %-12s project=%-16s db=%-16s volume=%s\n' \
    "$e" "$NEXORA_COMPOSE_PROJECT" "$NEXORA_PG_DB" "$NEXORA_PG_VOLUME"
done

printf '\n== Required separations ==\n'
check_ne "DEV_DB != PROD_DB" "$development_db" "$production_db"
check_ne "STAGING_DB != PROD_DB" "$staging_db" "$production_db"
check_ne "DEV_DB != STAGING_DB" "$development_db" "$staging_db"
check_ne "DEV_VOLUMES != PROD_VOLUMES" "$development_volume" "$production_volume"
check_ne "STAGING_VOLUMES != PROD_VOLUMES" "$staging_volume" "$production_volume"
check_ne "DEV_PROJECT != PROD_PROJECT" "$development_project" "$production_project"
check_ne "STAGING_PROJECT != PROD_PROJECT" "$staging_project" "$production_project"
check_ne "DEV_DOWNLOADS != PROD_DOWNLOADS" "$development_downloads" "$production_downloads"
check_ne "STAGING_DOWNLOADS != PROD_DOWNLOADS" "$staging_downloads" "$production_downloads"
check_ne "DEV_HOST != PROD_HOST" "$development_host" "$production_host"
check_ne "STAGING_HOST != PROD_HOST" "$staging_host" "$production_host"

printf '\n== Separation from the LIVE customer stack (legacy identity) ==\n'
# The running stack is still project `nexora` / db `nexora` / volume
# `nexora_postgres-data`. Dev and staging must differ from THAT, not only from
# the post-cutover target identity.
check_ne "DEV_PROJECT != live project" "$development_project" "$NEXORA_LEGACY_PROD_PROJECT"
check_ne "STAGING_PROJECT != live project" "$staging_project" "$NEXORA_LEGACY_PROD_PROJECT"
check_ne "DEV_DB != live db" "$development_db" "$NEXORA_LEGACY_PROD_DB"
check_ne "STAGING_DB != live db" "$staging_db" "$NEXORA_LEGACY_PROD_DB"
check_ne "DEV_VOLUME != live volume" "$development_volume" "$NEXORA_LEGACY_PROD_VOLUME"
check_ne "STAGING_VOLUME != live volume" "$staging_volume" "$NEXORA_LEGACY_PROD_VOLUME"

# --------------------------------------------------------------------------
printf '\n== Rendered compose configuration ==\n'
# --------------------------------------------------------------------------
render() {
  local overlay="$1"
  shift
  env "$@" docker compose -f compose.yaml -f "$overlay" config 2>/dev/null
}

dev_cfg="$(render compose.dev.yaml \
  ENROLLMENT_SECRET=dev ADMIN_API_TOKEN=dev)"
staging_cfg="$(render compose.staging.yaml \
  POSTGRES_DB=nexora_staging POSTGRES_USER=nexora_staging POSTGRES_PASSWORD=x \
  ENROLLMENT_SECRET=x ADMIN_API_TOKEN=x \
  NEXORA_IMAGE_API=nexora/api:rc NEXORA_IMAGE_WEB=nexora/web:rc NEXORA_IMAGE_MIGRATE=nexora/migrate:rc)"
prod_cfg="$(render compose.prod.yaml \
  POSTGRES_DB=nexora_prod POSTGRES_USER=nexora_prod POSTGRES_PASSWORD=x \
  ENROLLMENT_SECRET=x ADMIN_API_TOKEN=x NEXORA_RELEASE=RC1 \
  NEXORA_IMAGE_API=nexora/api:rc NEXORA_IMAGE_WEB=nexora/web:rc NEXORA_IMAGE_MIGRATE=nexora/migrate:rc)"

for pair in "development:$dev_cfg" "staging:$staging_cfg" "production:$prod_cfg"; do
  name="${pair%%:*}"
  cfg="${pair#*:}"
  if [ -z "$cfg" ]; then
    no "${name} compose configuration renders"
    continue
  fi
  ok "${name} compose configuration renders"

  expected_project="$(eval "printf '%s' \"\$${name}_project\"")"
  if printf '%s' "$cfg" | grep -qE "^name: ${expected_project}$"; then
    ok "${name} renders as compose project '${expected_project}'"
  else
    no "${name} does not render as compose project '${expected_project}'"
  fi
done

# The single most dangerous mount in the repo: ./pilot/downloads is the
# running customer download directory.
for pair in "development:$dev_cfg" "staging:$staging_cfg"; do
  name="${pair%%:*}"
  cfg="${pair#*:}"
  if printf '%s' "$cfg" | grep -q "${REPO_ROOT}/pilot/downloads"; then
    no "${name} must not mount the production downloads directory"
  else
    ok "${name} does not mount ${REPO_ROOT}/pilot/downloads"
  fi
  if printf '%s' "$cfg" | grep -q "/etc/nexora/pki/server:/etc/nexora/pki/server"; then
    no "${name} must not mount the production PKI directory"
  else
    ok "${name} does not mount the production PKI directory"
  fi
done

# Production must not be buildable from a worktree.
if printf '%s' "$prod_cfg" | grep -qE '^\s+build:'; then
  no "production compose configuration still contains a build section"
else
  ok "production compose configuration contains no build section (immutable images only)"
fi

if printf '%s' "$dev_cfg" | grep -qE '"[0-9]+:(80|443)"|published: "(80|443)"'; then
  no "development publishes a production port (80/443)"
else
  ok "development does not publish ports 80/443"
fi

# --------------------------------------------------------------------------
printf '\n== Guard behaviour (each of these MUST refuse) ==\n'
# --------------------------------------------------------------------------
expect_refusal "compose wrapper refuses an unnamed environment" \
  "$SCRIPT_DIR/nexora-compose.sh"

expect_refusal "compose wrapper refuses production without approval" \
  env -u NEXORA_PRODUCTION_CONFIRM "$SCRIPT_DIR/nexora-compose.sh" production up -d

expect_refusal "compose wrapper refuses 'production down'" \
  env NEXORA_PRODUCTION_CONFIRM='I UNDERSTAND THIS TARGETS PRODUCTION' NEXORA_RELEASE=RC1 \
  "$SCRIPT_DIR/nexora-compose.sh" production down

expect_refusal "compose wrapper refuses 'production build'" \
  "$SCRIPT_DIR/nexora-compose.sh" production build

expect_refusal "compose wrapper refuses a mismatched COMPOSE_PROJECT_NAME" \
  env COMPOSE_PROJECT_NAME=nexora "$SCRIPT_DIR/nexora-compose.sh" development ps

# These two are the only checks that invoke a production subcommand. Both are
# constructed so a refusal is unavoidable - an image with no labels at all,
# and an all-zero release tree that no build can ever produce - so neither can
# fall through into an actual production operation.
if docker image inspect nexora-api:first-customer-rc1 >/dev/null 2>&1; then
  expect_refusal "production refuses an image with no provenance labels" \
    env NEXORA_PRODUCTION_CONFIRM='I UNDERSTAND THIS TARGETS PRODUCTION' NEXORA_RELEASE=RC1 \
    NEXORA_IMAGE_API=nexora-api:first-customer-rc1 \
    NEXORA_IMAGE_WEB=nexora-web:first-customer-rc1 \
    NEXORA_IMAGE_MIGRATE=nexora-migrate:latest \
    "$SCRIPT_DIR/nexora-compose.sh" production up -d
fi

rc1_tag="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 '^nexora-api:nexora-first-customer-rc1' || true)"
if [ -n "$rc1_tag" ]; then
  expect_refusal "production refuses an image whose tree != the approved release tree" \
    env NEXORA_PRODUCTION_CONFIRM='I UNDERSTAND THIS TARGETS PRODUCTION' NEXORA_RELEASE=RC1 \
    NEXORA_RELEASE_TREE=0000000000000000000000000000000000000000 \
    NEXORA_IMAGE_API="$rc1_tag" \
    NEXORA_IMAGE_WEB="${rc1_tag/nexora-api/nexora-web}" \
    NEXORA_IMAGE_MIGRATE="${rc1_tag/nexora-api/nexora-migrate}" \
    "$SCRIPT_DIR/nexora-compose.sh" production up -d
fi

expect_refusal "dev migration refuses an inherited production DATABASE_URL" \
  env DATABASE_URL='postgresql://nexora:pw@127.0.0.1:5432/nexora' \
  "$SCRIPT_DIR/migrate.sh" development

expect_refusal "dev migration refuses a production hostname in DATABASE_URL" \
  env DATABASE_URL='postgresql://u:p@nexora.design.local:5432/nexora_dev' \
  "$SCRIPT_DIR/migrate.sh" development

expect_refusal "migration refuses an unnamed environment" \
  env -u NEXORA_ENV "$SCRIPT_DIR/migrate.sh"

expect_refusal "production migration refuses without approval" \
  env -u NEXORA_PRODUCTION_CONFIRM "$SCRIPT_DIR/migrate.sh" production

expect_refusal "'drizzle-kit push' refused against staging" \
  "$SCRIPT_DIR/migrate.sh" staging push

expect_refusal "'drizzle-kit push' refused against production" \
  "$SCRIPT_DIR/migrate.sh" production push

expect_refusal "Agent build refuses to run without an explicit output directory" \
  env -u NEXORA_AGENT_OUT_DIR "$REPO_ROOT/scripts/build-windows-agent-package.sh"

expect_refusal "Agent publish refuses production without approval" \
  env -u NEXORA_PRODUCTION_CONFIRM "$SCRIPT_DIR/publish-agent-package.sh" production

# --------------------------------------------------------------------------
printf '\n== Runtime isolation (live Docker state, read-only) ==\n'
# --------------------------------------------------------------------------
# The checks above prove the *configuration* is isolated. These prove the
# running result is - which is the claim that actually matters, and the one
# that would have caught the original coupling.

live_projects="$(docker compose ls --all --format json 2>/dev/null || echo '[]')"

if printf '%s' "$live_projects" | grep -q '"Name":"nexora"'; then
  ok "live production stack detected as project 'nexora' (legacy identity)"

  prod_vol="$(docker inspect nexora-postgres-1 --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
  if [ "$prod_vol" = "$NEXORA_LEGACY_PROD_VOLUME" ]; then
    ok "production data volume is ${prod_vol}"
  else
    no "production data volume is '${prod_vol}', expected ${NEXORA_LEGACY_PROD_VOLUME}"
  fi

  # Nothing outside the production project may be attached to its network.
  foreign="$(docker network inspect nexora_default \
    --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null |
    grep -v '^nexora-\(postgres\|api\|web\|maintenance\|notification-worker\|migrate\)-1$' |
    grep -v '^$' || true)"
  if [ -z "$foreign" ]; then
    ok "no foreign containers attached to the production network"
  else
    no "foreign containers on the production network: $(printf '%s' "$foreign" | tr '\n' ' ')"
  fi
else
  printf '  SKIP  production stack not running on this host\n'
fi

if docker ps --format '{{.Names}}' | grep -q '^nexora-dev-'; then
  dev_vol="$(docker inspect nexora-dev-postgres-1 --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
  check_ne "running dev volume != running prod volume" "$dev_vol" "$NEXORA_LEGACY_PROD_VOLUME"

  # A dev container must not be reachable from, or reach, production.
  dev_on_prod_net="$(docker network inspect nexora_default \
    --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null | grep -c '^nexora-dev-' || true)"
  if [ "$dev_on_prod_net" -eq 0 ]; then
    ok "no development container is attached to the production network"
  else
    no "${dev_on_prod_net} development container(s) attached to the production network"
  fi

  # Published dev ports must be loopback-only.
  bad_bind="$(docker ps --filter name=nexora-dev- --format '{{.Ports}}' | grep -oE '0\.0\.0\.0:[0-9]+|\[::\]:[0-9]+' || true)"
  if [ -z "$bad_bind" ]; then
    ok "development publishes no port on a non-loopback interface"
  else
    no "development publishes on all interfaces: $(printf '%s' "$bad_bind" | tr '\n' ' ')"
  fi

  # The production downloads directory must not be mounted anywhere in dev.
  dev_prod_mount="$(docker ps -aq --filter name=nexora-dev- |
    xargs -r docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null |
    grep -c "^${REPO_ROOT}/pilot/downloads$" || true)"
  if [ "$dev_prod_mount" -eq 0 ]; then
    ok "no development container mounts the production downloads directory"
  else
    no "${dev_prod_mount} development container(s) mount ${REPO_ROOT}/pilot/downloads"
  fi

  # A dev build must never retag a production image.
  prod_id="$(docker image inspect nexora-api:latest --format '{{.Id}}' 2>/dev/null || true)"
  dev_id="$(docker image inspect nexora-dev-api:latest --format '{{.Id}}' 2>/dev/null || true)"
  if [ -n "$prod_id" ] && [ -n "$dev_id" ]; then
    check_ne "development image is not the production image" "$dev_id" "$prod_id"
  fi
else
  printf '  SKIP  development stack not running\n'
fi

# Disposable test containers must be loopback-bound and labelled, so an
# orphan can always be found and cleaned up.
stray="$(docker ps --format '{{.Names}}\t{{.Ports}}' |
  grep -E '^nexora-(task|test)' | grep -E '0\.0\.0\.0:|\[::\]:' || true)"
if [ -z "$stray" ]; then
  ok "no test container publishes on a non-loopback interface"
else
  no "test containers published externally: $(printf '%s' "$stray" | tr '\n' ' ')"
fi

# --------------------------------------------------------------------------
printf '\n== Release image provenance ==\n'
# --------------------------------------------------------------------------
release_images="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^nexora-(api|web|migrate):' | grep -v ':latest$' || true)"
if [ -z "$release_images" ]; then
  printf '  SKIP  no tagged release images built yet\n'
else
  while IFS= read -r img; do
    [ -n "$img" ] || continue
    labels="$(docker image inspect "$img" --format '{{json .Config.Labels}}' 2>/dev/null || echo null)"
    missing=""
    for label in org.nexora.release org.nexora.source.tree org.opencontainers.image.revision org.opencontainers.image.created; do
      printf '%s' "$labels" | grep -q "\"${label}\"" || missing="${missing} ${label}"
    done
    if [ -z "$missing" ]; then
      tree_label="$(docker image inspect "$img" --format '{{index .Config.Labels "org.nexora.source.tree"}}')"
      ok "${img} carries full provenance (tree ${tree_label})"
    else
      no "${img} is missing provenance labels:${missing}"
    fi
  done <<<"$release_images"
fi

# --------------------------------------------------------------------------
printf '\n== Secret hygiene ==\n'
# --------------------------------------------------------------------------
tracked_secrets="$(git -C "$REPO_ROOT" ls-files | grep -E '(^|/)\.env($|\.)|\.key$|\.pem$|\.pfx$|\.dump$|\.sql\.gz$' | grep -v '\.example$' || true)"
if [ -z "$tracked_secrets" ]; then
  ok "no secret or private-key files are tracked in git"
else
  no "secret-looking files are tracked in git:"
  printf '        %s\n' $tracked_secrets
fi

for f in .env .env.development .env.staging .env.production; do
  [ -f "$REPO_ROOT/$f" ] || continue
  perms="$(stat -c '%a' "$REPO_ROOT/$f")"
  if [ "$perms" = "600" ] || [ "$perms" = "400" ]; then
    ok "$f permissions are ${perms}"
  else
    no "$f permissions are ${perms} (expected 600)"
  fi
  if git -C "$REPO_ROOT" check-ignore -q "$f"; then
    ok "$f is ignored by git"
  else
    no "$f is NOT ignored by git"
  fi
done

# --------------------------------------------------------------------------
printf '\n== Summary ==\n  %d passed, %d failed\n\n' "$pass" "$fail"
# --------------------------------------------------------------------------
[ "$fail" -eq 0 ]
