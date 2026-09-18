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

> [!WARNING]
> **Never run bare `docker compose` in this directory.** `compose.yaml`
> declares `name: nexora`, which is the identity of the **running customer
> production stack**. A plain `docker compose up`, `build`, `restart`, or
> `down -v` here operates on real customer data — and `up` also runs the
> `migrate` service, applying whatever migrations are currently in your
> worktree to the customer database.
>
> Always select an environment explicitly:
>
> ```bash
> scripts/env/nexora-compose.sh development up -d
> ```
>
> See [docs/environment-isolation.md](docs/environment-isolation.md).

## Run locally

Live-reload development, straight from source:

```bash
cp .env.development.example .env.development && chmod 600 .env.development
pnpm install
scripts/env/migrate.sh development        # never targets production
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/nexora run dev
```

The dashboard is served through the configured preview. The API is mounted at
`/api`; OpenAPI contracts live in `lib/api-spec/openapi.yaml`.

`pnpm --filter @workspace/db run push` (destructive schema diffing, no
migration history) is still available for fast local iteration, but go through
`scripts/env/migrate.sh development push` — the wrapper refuses to run `push`
against anything but a development database.

## Run with Docker Compose

Build and launch the dashboard, API, and PostgreSQL database as a
production-like **local** stack (project `nexora-dev`, its own database,
volume, network, and loopback-only ports):

```bash
scripts/env/nexora-compose.sh development up -d --build
```

That starts PostgreSQL, the migrations, the API, and the workers on
`127.0.0.1` only (API `3011`, PostgreSQL `55430`). The `web` container is
opt-in — add `--profile web` — because it needs a local certificate in
`.local/dev-pki`; it then serves on `8080`/`8443`, never `80`/`443`.

The database schema is applied automatically on startup via versioned Drizzle
migrations (`lib/db/drizzle/*.sql`, run with `drizzle-kit migrate`) —
deterministic, ordered, and safe to re-run since each migration is tracked in
`drizzle.__drizzle_migrations`. When you change `lib/db/src/schema`, run
`pnpm --filter @workspace/db run generate` to add a new versioned migration
file, commit it, then apply it with `scripts/env/migrate.sh development`.

In production the `web` container terminates TLS on `80` (HTTP → HTTPS
redirect) and `443` at `https://nexora.design.local`. Its certificate and key
are read from `/etc/nexora/pki/server/` on the host (bind-mounted read-only);
see `docs/deployment.md` for how this is provisioned and backed up, and
`docs/windows-internal-ca-trust.md` for how Windows clients trust the internal
CA that issued it.

Production and staging take every secret from `/etc/nexora/env/*.env` on their
own hosts — never from a file in this repository. See
`.env.production.example` / `.env.staging.example` for the required keys, and
`docs/environment-isolation.md` for the environment model as a whole.

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
