#!/usr/bin/env bash
# Runs the EXACT Task #008 cross-tenant isolation suite
# (artifacts/api-server/src/tenancy/tenancy.integration.mjs) against the real
# built server (dist/index.mjs, not createApp() imported in-process) over a
# disposable PostgreSQL 16, exactly as production would run it.
set -euo pipefail

name="nexora-task008-pg-$$"
port="${NEXORA_TEST_PG_PORT:-55435}"
apiport="${NEXORA_TEST_API_PORT:-4108}"
db="nexora_task008"
user="task008"
pass="task008-disposable-password"
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

mounts=(
  -v "$PWD/artifacts/api-server/src:/app/artifacts/api-server/src:ro"
  -v "$PWD/lib/db/src:/app/lib/db/src:ro"
)

docker run --rm --network host "${mounts[@]}" \
  -e NODE_ENV=production -e PORT=0 -e DATABASE_URL="$url" \
  -e JWT_SECRET=task008-disposable-jwt-secret-0123456789 \
  -e ENROLLMENT_SECRET=task008-disposable-enrollment-secret-0123456789 \
  -e ADMIN_API_TOKEN=task008-disposable-admin-token-0123456789 \
  -e CORS_ALLOWED_ORIGINS=https://nexora.design.local \
  nexora-task010-integration pnpm --filter @workspace/db run migrate

docker run --rm --network host "${mounts[@]}" \
  -e NODE_ENV=production -e PORT="$apiport" -e DATABASE_URL="$url" \
  -e JWT_SECRET=task008-disposable-jwt-secret-0123456789 \
  -e ENROLLMENT_SECRET=task008-disposable-enrollment-secret-0123456789 \
  -e ADMIN_API_TOKEN=task008-disposable-admin-token-0123456789 \
  -e CORS_ALLOWED_ORIGINS=https://nexora.design.local \
  -e NEXORA_TEST_BASE_URL="http://127.0.0.1:${apiport}" \
  -e NEXORA_TEST_ORIGIN=https://nexora.design.local \
  nexora-task010-integration bash -c '
    set -euo pipefail
    pnpm --filter @workspace/api-server run build >/tmp/build.log 2>&1
    node --enable-source-maps artifacts/api-server/dist/index.mjs &
    server_pid=$!
    trap "kill $server_pid 2>/dev/null || true" EXIT
    node -e "
      const url = \"http://127.0.0.1:'"$apiport"'/api/healthz\";
      (async () => {
        for (let i = 0; i < 60; i++) {
          try { const r = await fetch(url); if (r.ok) process.exit(0); } catch {}
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        console.error(\"server did not become healthy\"); process.exit(1);
      })();
    "
    node --test artifacts/api-server/src/tenancy/tenancy.integration.mjs
  '
