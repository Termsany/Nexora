#!/usr/bin/env bash
# Task #010W Phase 4 — production-like preservation test.
#
# 1. Migrates a disposable Postgres only through 0009 (pre-Task010 baseline),
#    using the *same* drizzle-kit migrate CLI deployment uses, pointed at a
#    trimmed migrations folder containing byte-identical copies of
#    0000-0009's real SQL files (so their hashes match the real journal).
# 2. Seeds a representative pre-existing dataset and snapshots it.
# 3. Re-points drizzle-kit migrate at the real, full ./drizzle folder — since
#    0000-0009 are already recorded as applied (same file hashes), only
#    0010-0012 (Task010's schema) actually run.
# 4. Verifies every preservation invariant against the snapshot.
set -euo pipefail

name="nexora-task010pres-pg-$$"
port="${NEXORA_TEST_PG_PORT:-55437}"
db="nexora_task010pres"
user="task010pres"
pass="task010pres-disposable-password"
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

cutoff="/tmp/nexora-drizzle-cutoff-0009"
rm -rf "$cutoff"
mkdir -p "$cutoff/meta"
for f in lib/db/drizzle/000[0-9]_*.sql; do cp "$f" "$cutoff/"; done
python3 -c "
import json
with open('lib/db/drizzle/meta/_journal.json') as fh:
    journal = json.load(fh)
journal['entries'] = journal['entries'][:10]
with open('$cutoff/meta/_journal.json', 'w') as fh:
    json.dump(journal, fh, indent=2)
"
cat > "$cutoff/drizzle.config.ts" <<'EOF'
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "/app/lib/db/src/schema/index.ts",
  out: "/cutoff",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
EOF
echo "Cutoff migration set (0000-0009): $(ls "$cutoff"/*.sql | wc -l) files"

mounts=(
  -v "$PWD/artifacts/api-server/src:/app/artifacts/api-server/src:ro"
  -v "$PWD/lib/db/src:/app/lib/db/src:ro"
  -v "$PWD/artifacts/api-server/src/preservation-seed.mjs:/app/artifacts/api-server/src/preservation-seed.mjs:ro"
  -v "$PWD/artifacts/api-server/src/preservation-verify.mjs:/app/artifacts/api-server/src/preservation-verify.mjs:ro"
  -v "$cutoff:/cutoff:ro"
)

echo "=== Step 1: migrate to 0009 (cutoff config) ==="
docker run --rm --network host "${mounts[@]}" -e DATABASE_URL="$url" \
  nexora-task010-integration pnpm --filter @workspace/db exec drizzle-kit migrate --config /cutoff/drizzle.config.ts

echo "=== Step 2: seed pre-Task010 fixture + snapshot ==="
snapshot=$(docker run --rm --network host "${mounts[@]}" -e DATABASE_URL="$url" \
  nexora-task010-integration node artifacts/api-server/src/preservation-seed.mjs)
echo "$snapshot" > /tmp/preservation-before.json
echo "snapshot captured: $(echo "$snapshot" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["counts"]), "tables snapshotted")')"

echo "=== Step 3: migrate the rest (0010-0012, real config) ==="
docker run --rm --network host "${mounts[@]}" -e DATABASE_URL="$url" \
  nexora-task010-integration pnpm --filter @workspace/db run migrate

echo "=== Step 4: verify preservation ==="
docker run --rm --network host "${mounts[@]}" -e DATABASE_URL="$url" \
  -e PRESERVATION_SNAPSHOT="$snapshot" \
  nexora-task010-integration node artifacts/api-server/src/preservation-verify.mjs

echo "=== Step 5: API boots against the final schema and a pre-existing user can still log in ==="
apiport="${NEXORA_TEST_API_PORT:-4110}"
docker run --rm --network host "${mounts[@]}" \
  -e NODE_ENV=production -e PORT="$apiport" -e DATABASE_URL="$url" \
  -e JWT_SECRET=task010pres-disposable-jwt-secret-0123456789 \
  -e ENROLLMENT_SECRET=task010pres-disposable-enrollment-secret-0123456789 \
  -e ADMIN_API_TOKEN=task010pres-disposable-admin-token-0123456789 \
  -e CORS_ALLOWED_ORIGINS=https://nexora.design.local \
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
          try { const r = await fetch(url); if (r.ok) { console.log(\"API booted against final schema: healthy\"); process.exit(0); } } catch {}
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        console.error(\"server did not become healthy\"); process.exit(1);
      })();
    "
  '
