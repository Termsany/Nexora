# Nexora

Nexora is an IT Operations Platform foundation for securely enrolling Windows
endpoints and displaying their health in an operational dashboard.

## Current foundation

- Responsive Nexora dashboard with overview, devices, detail, administration,
  and coming-soon operational modules
- Versioned enrollment, heartbeat, inventory, metrics, dashboard, and device APIs
- PostgreSQL schema managed through Drizzle
- Portable .NET 8 Windows Worker Service agent skeleton
- Structured API logging and backend-derived online/offline state

## Run locally

```bash
cp .env.example .env
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/nexora run dev
```

The dashboard is served through the configured preview. The API is mounted at
`/api`; OpenAPI contracts live in `lib/api-spec/openapi.yaml`.

## Run with Docker Compose

Build and launch the dashboard, API, and PostgreSQL database:

```bash
docker compose up --build
```

The `web` container terminates TLS and listens on `80` (HTTP → HTTPS
redirect) and `443`. Open `https://nexora.design.local` (or
`http://localhost` during local development without a certificate — see
below). The database schema is applied automatically on startup via
versioned Drizzle migrations (`lib/db/drizzle/*.sql`, run with
`drizzle-kit migrate`) — deterministic, ordered, and safe to re-run since
each migration is tracked in `drizzle.__drizzle_migrations`. `drizzle-kit
push` remains available for fast local schema iteration only (see Quickstart
above); it is never used by the `migrate` container or any deployment path.
When you change `lib/db/src/schema`, run
`pnpm --filter @workspace/db run generate` to add a new versioned migration
file, commit it, then apply it locally with
`pnpm --filter @workspace/db run migrate`. To use different host ports, set
`NEXORA_HTTP_PORT` / `NEXORA_HTTPS_PORT`, for example:

```bash
NEXORA_HTTP_PORT=8080 NEXORA_HTTPS_PORT=8443 docker compose up --build
```

TLS certificate and key are read from `/etc/nexora/pki/server/` on the host
(bind-mounted read-only into `web`); see `docs/deployment.md` for how this
is provisioned and backed up, and `docs/windows-internal-ca-trust.md` for
how Windows clients trust the internal CA that issued it.

For a non-local deployment, override `POSTGRES_PASSWORD`, `JWT_SECRET`,
`ENROLLMENT_SECRET`, `ADMIN_API_TOKEN`, `API_BASE_URL`, and
`CORS_ALLOWED_ORIGINS` with strong, deployment-specific values.

## Agent

Create an enrollment token from Administration or through the API:

```bash
curl --cacert /etc/nexora/pki/ca/nexora-root-ca.crt \
  -X POST https://nexora.design.local/api/v1/admin/enrollment-tokens \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"First Windows PC","organization":"Default","expires_at":"2030-01-01T00:00:00Z","max_uses":1}'
```

Publish the Windows x64 agent:

```powershell
dotnet publish agent/Nexora.Agent/Nexora.Agent.csproj `
  -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

Install it from an elevated PowerShell session:

```powershell
.\scripts\windows\install-agent.ps1 `
  -ApiBaseUrl "https://nexora.design.local/api" `
  -EnrollmentToken "<token>" `
  -SourcePath ".\agent\Nexora.Agent\bin\Release\net8.0-windows\win-x64\publish"
```

The agent persists its device UUID under `%ProgramData%\Nexora\Agent`, protects
credentials with machine-scoped DPAPI, and retries temporary failures with
bounded exponential backoff and jitter. See `docs/agent-v1-acceptance-test.md`
for the required real-Windows validation procedure.

## Verification

```bash
pnpm run typecheck
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/api-server run test
dotnet test agent/Nexora.Agent.Tests/Nexora.Agent.Tests.csproj
docker build --target agent-test .
```

See `docs/architecture.md`, `docs/agent-protocol.md`, `docs/security-model.md`,
and `docs/deployment.md` for the platform decisions.
