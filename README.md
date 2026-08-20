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

## Agent

On Windows, configure `NEXORA_API_URL` and `NEXORA_ENROLLMENT_TOKEN`, then:

```powershell
dotnet publish agent/Nexora.Agent -c Release -r win-x64 --self-contained true
sc.exe create NexoraAgent binPath= "C:\Program Files\Nexora\nexora-agent.exe"
sc.exe start NexoraAgent
```

The agent persists its device UUID and uses retry backoff when the API is
unavailable. Windows Service packaging, DPAPI credential wrapping, and the
remaining modular collectors are subsequent foundation slices.

## Verification

```bash
pnpm run typecheck
pnpm --filter @workspace/api-spec run codegen
```

See `docs/architecture.md`, `docs/agent-protocol.md`, `docs/security-model.md`,
and `docs/deployment.md` for the platform decisions.