# Nexora

Nexora is an IT Operations Platform for securely enrolling Windows endpoints and monitoring their health.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/nexora run dev` — run the Nexora dashboard
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (portable HTTP contract; FastAPI parity can be introduced when the backend is split)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/nexora` — dashboard UI and routes
- `artifacts/api-server` — versioned API routes
- `lib/api-spec/openapi.yaml` — API source of truth
- `lib/db/src/schema/nexora.ts` — PostgreSQL schema source
- `agent/Nexora.Agent` — portable .NET Worker Service source
- `docs/` — architecture, protocol, security, and deployment notes

## Architecture decisions

- Device health is derived from backend receive time, not agent timestamps.
- Device UUID is the durable endpoint identity; human-readable agent IDs are display-only.
- API contracts are generated from OpenAPI and consumed by the dashboard hooks.
- Zod 4 is used because current Orval output relies on `zod.int()` and `zod.uuid()`.

## Product

The dashboard shows fleet health, searchable devices, endpoint detail tabs, recent
activity, and an administration surface for enrollment. Future RMM modules are
clearly marked as coming soon rather than presented as fake functionality.

## User preferences

The product is intended to remain portable beyond Replit and must avoid vendor-specific runtime dependencies.

## Gotchas

- Run OpenAPI codegen after changing `lib/api-spec/openapi.yaml`.
- Run `pnpm --filter @workspace/db run push` after changing the Drizzle schema.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
