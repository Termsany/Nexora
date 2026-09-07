#!/usr/bin/env bash
set -euo pipefail

name="nexora-task010-pg-$$"
port="${NEXORA_TEST_PG_PORT:-55432}"
db="nexora_task010"
user="task010"
pass="task010-disposable-password"
url="postgresql://${user}:${pass}@127.0.0.1:${port}/${db}"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" -e POSTGRES_DB="$db" -e POSTGRES_USER="$user" -e POSTGRES_PASSWORD="$pass" -p "${port}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name" pg_isready -U "$user" -d "$db" >/dev/null

if ! docker image inspect nexora-task010-integration >/dev/null 2>&1; then
  docker build --target integration -t nexora-task010-integration .
fi

# Every file touched while completing Task #010's signed-protocol acceptance
# suite is bind-mounted read-only over the built image so this always
# exercises the current working tree's production code, not whatever was
# baked into the image at build time.
mounts=(
  -v "$PWD/artifacts/api-server/src/app.ts:/app/artifacts/api-server/src/app.ts:ro"
  -v "$PWD/artifacts/api-server/src/routes/remote-commands.ts:/app/artifacts/api-server/src/routes/remote-commands.ts:ro"
  -v "$PWD/artifacts/api-server/src/routes/security.ts:/app/artifacts/api-server/src/routes/security.ts:ro"
  -v "$PWD/artifacts/api-server/src/remote-commands/maintenance.ts:/app/artifacts/api-server/src/remote-commands/maintenance.ts:ro"
  -v "$PWD/artifacts/api-server/src/security/agent-signing.ts:/app/artifacts/api-server/src/security/agent-signing.ts:ro"
  -v "$PWD/artifacts/api-server/src/security/rate-limit.ts:/app/artifacts/api-server/src/security/rate-limit.ts:ro"
  -v "$PWD/artifacts/api-server/src/tenancy/audit.ts:/app/artifacts/api-server/src/tenancy/audit.ts:ro"
  -v "$PWD/artifacts/api-server/src/task010.integration.mjs:/app/artifacts/api-server/src/task010.integration.mjs:ro"
  -v "$PWD/artifacts/api-server/src/task010.security.integration.mjs:/app/artifacts/api-server/src/task010.security.integration.mjs:ro"
  -v "$PWD/artifacts/api-server/src/task010v.integration.mjs:/app/artifacts/api-server/src/task010v.integration.mjs:ro"
  -v "$PWD/artifacts/api-server/package.json:/app/artifacts/api-server/package.json:ro"
  -v "$PWD/scripts/run-task010-test.mjs:/app/scripts/run-task010-test.mjs:ro"
  -v "$PWD/scripts/run-task010-security-test.mjs:/app/scripts/run-task010-security-test.mjs:ro"
  -v "$PWD/scripts/run-task010v-test.mjs:/app/scripts/run-task010v-test.mjs:ro"
)

docker run --rm --network host \
  "${mounts[@]}" \
  -e NODE_ENV=production -e PORT=0 -e DATABASE_URL="$url" \
  -e JWT_SECRET=task010-disposable-jwt-secret-0123456789 \
  -e ENROLLMENT_SECRET=task010-disposable-enrollment-secret-0123456789 \
  -e ADMIN_API_TOKEN=task010-disposable-admin-token-0123456789 \
  -e CORS_ALLOWED_ORIGINS=http://127.0.0.1 \
  -e REMOTE_COMMANDS_ENABLED=true \
  nexora-task010-integration pnpm --filter @workspace/db run migrate
docker run --rm --network host \
  "${mounts[@]}" \
  -e NODE_ENV=production -e PORT=0 -e DATABASE_URL="$url" \
  -e JWT_SECRET=task010-disposable-jwt-secret-0123456789 \
  -e ENROLLMENT_SECRET=task010-disposable-enrollment-secret-0123456789 \
  -e ADMIN_API_TOKEN=task010-disposable-admin-token-0123456789 \
  -e CORS_ALLOWED_ORIGINS=http://127.0.0.1 \
  -e REMOTE_COMMANDS_ENABLED=true \
  nexora-task010-integration
