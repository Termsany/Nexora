# Multi-tenancy

Nexora manages many independent companies from one deployment. Tenant isolation
is a security boundary enforced server-side, never by frontend filtering.

## Tenant model

```
Organization (nexora_organizations)
    └── Site (nexora_sites)
            └── Device (nexora_devices)
                    ├── metrics, disk metrics, aggregates
                    ├── alerts → notifications
                    ├── software + software changes
                    └── services, service events, processes
```

An organization is identified internally by an immutable UUID. `name` is a
display label and `slug` a stable handle; neither is ever a foreign key, so
renaming an organization changes nothing about ownership. Organizations are
`ACTIVE`, `SUSPENDED` or `ARCHIVED` — they are never hard-deleted, so telemetry
and incident history survive.

A site belongs to exactly one organization. A device belongs to exactly one
organization (`organization_id NOT NULL`) and optionally to one site.

## Ownership strategy

The **device is the authoritative tenant boundary** for device-derived data.
Metrics, disk metrics, aggregates, activity, software, services and processes
carry no `organization_id` of their own; they resolve through `device_id`. This
avoids duplicating a tenant key across the highest-volume tables — 70k+ metric
rows and 114k+ disk-metric rows on the pilot alone — and removes any chance of
those copies drifting from the device they describe.

Three tables *do* carry a denormalized `organization_id`, because each is
independently addressable by ID and sits on a hot listing path where the tenant
predicate needs to be an index lookup rather than a join:

| Table | Why | Source of truth |
|---|---|---|
| `nexora_alerts` | Alerts are fetched and acknowledged by ID; the list is paged and filtered constantly | Copied from the device by the alert engine |
| `nexora_notifications` | Delivery history is listed per tenant | Copied from the originating alert |
| `nexora_enrollment_tokens` | The token *is* the tenant assignment (see below) | Set by the issuing administrator |

In every case the server derives the value. Nothing an agent sends ever
influences it.

`nexora_audit_log` also carries a nullable `organization_id` so tenant-scoped
security events can be retrieved without joining through a target that may since
have been archived.

## Cross-tenant assignment is unrepresentable, not merely rejected

`nexora_sites` carries a redundant `UNIQUE (id, organization_id)`. Devices and
enrollment tokens then reference sites through a **composite** foreign key on
`(site_id, organization_id)` rather than on `site_id` alone:

```sql
ALTER TABLE nexora_devices ADD CONSTRAINT nexora_devices_site_organization_fk
  FOREIGN KEY (site_id, organization_id)
  REFERENCES nexora_sites (id, organization_id);
```

A device can therefore only point at a site inside its own organization. The
constraint uses MATCH SIMPLE, so it is inert while `site_id` is NULL, which
keeps site assignment optional. This holds against direct SQL, not just against
the API:

```
UPDATE nexora_devices SET site_id = '<site in another org>' WHERE hostname='DEPLOY';
ERROR:  insert or update on table "nexora_devices" violates foreign key
        constraint "nexora_devices_site_organization_fk"
```

`nexora_users` carries a matching CHECK constraint: a `PLATFORM` user must have a
`platform_role` and an `ORGANIZATION` user must not have one, so an organization
account cannot be given a platform role by any code path.

## Authentication

Two credential kinds reach the API, and they are deliberately separate.

**Interactive users** sign in at `POST /v1/auth/login` and receive an httpOnly,
SameSite=Lax session cookie (12 hours, no sliding renewal). Only the SHA-256
hash of the session token is stored, so a database disclosure cannot be replayed
as a login. Passwords are hashed with scrypt (N=2^15, r=8) using Node's built-in
crypto — no native dependency. Login answers unknown-email, wrong-password and
disabled-account identically and with comparable timing, so it cannot be used to
enumerate accounts. Changing a password or disabling an account revokes that
user's live sessions.

**The administrative API token** (`ADMIN_API_TOKEN`) remains a platform-level
machine credential. It is never issued to a tenant, never placed in agent config
or GPO, and — as of Task #008 — never held by the browser. The console
previously kept it in `sessionStorage`; it now holds no credential at all.

**Agents** authenticate with their own per-device bearer token, unchanged.

## TenantContext

Every request that carries a valid credential gets a `TenantContext`:

```ts
{
  principal: { kind: "user", user } | { kind: "platform-api" },
  platformAccess: boolean,
  organizationIds: string[] | null,   // null ⇒ every organization
  memberships: Map<organizationId, OrganizationRole>,
}
```

`organizationIds === null` means "no tenant predicate needed" and is produced
**only** for platform access. For everyone else it is the explicit membership
list. An empty list is a valid, fully-denying scope: `tenantSqlClause` renders it
as `FALSE` and `tenantCondition` as a false predicate, so a user with no
memberships sees nothing rather than everything. That is the default-deny rule.

The pure decisions live in `src/tenancy/policy.ts` with no database or Express
imports, so they are unit-testable in isolation. `context.ts` adds credential
resolution and membership loading; `scope.ts` adds the query helpers.

Routes use three helpers rather than open-coding comparisons:

- `organizationScope(context, requestedOrganizationId?)` — resolves the scope.
  A requested organization the caller cannot reach is **refused (403)**, never
  silently ignored, which would otherwise return the caller's own rows under
  another tenant's label.
- `tenantCondition(column, scope)` / `tenantSqlClause(expr, scope, values)` —
  the predicate for Drizzle and for the hand-written pool queries.
- `findDeviceInScope(context, id)` / `findSiteInScope(context, id)` — resolve an
  object only if the caller may reach it.

Filtering always happens in SQL, inside the same WHERE clause used for both the
page and the total, so tenant restriction precedes `LIMIT`/`OFFSET` and a
pagination total cannot disclose another tenant's row count.

## Roles

| Role | Reach |
|---|---|
| `PLATFORM_SUPER_ADMIN` | All organizations, plus user administration |
| `PLATFORM_ADMIN` | All organizations; create/update organizations, sites, memberships, tokens, notification channels |
| `PLATFORM_TECHNICIAN` | All organizations, operational only — no organization/site/membership creation, no user or channel administration |
| `ORGANIZATION_ADMIN` | Assigned organizations: sites, memberships, enrollment tokens, acknowledgement |
| `ORGANIZATION_TECHNICIAN` | Assigned organizations: read, acknowledge, assign device sites |
| `ORGANIZATION_VIEWER` | Assigned organizations: read only |

Memberships (`nexora_organization_memberships`, unique on `(user_id,
organization_id)`) let one technician serve several customers without duplicate
accounts. Platform users draw access from their platform role and hold no
memberships.

Escalation is blocked at several points: only `user:manage` (super admin) can
create accounts; an organization admin cannot change their own role, remove
their own membership, suspend their own organization, or touch another tenant;
and `scope`/`platform_role` are not updatable through the user edit endpoint.

## IDOR

A tenant-invisible object returns **404, not 403** — devices, alerts, sites,
organizations, enrollment tokens and notifications alike. 403 would confirm the
ID exists and allow cross-tenant enumeration. 403 is reserved for objects the
caller *can* see but lacks the permission to act on.

## Enrollment

Every enrollment token belongs to exactly one organization and optionally to one
site. On `POST /v1/agents/enroll` the server reads the tenant from the consumed
token and assigns `device.organization_id` (and `site_id`) from it. Nothing in
the request body participates: an agent that submits `organization_id`,
`organization` or `site_id` is ignored, and the device lands in the token's
tenant. Re-enrolling a device that already exists in a different organization is
refused (409) rather than moving it.

Existing agents are unaffected. Their per-device bearer tokens still resolve to
their device, and the device's organization supplies the tenant context:

```
agent credential → device → device.organization_id → tenant context
```

No agent update is required for multi-tenancy, and no re-enrollment.

## Device organization is immutable

There is no API that changes `device.organization_id`. `PATCH
/v1/devices/:id/site` accepts only `site_id`, and validates the site against the
device's own organization — even a platform administrator cannot move a device
into another tenant's site. Tenant transfer, if ever needed, belongs in a
dedicated audited workflow, not in ordinary device editing.

## Suspended and archived organizations

| | SUSPENDED | ARCHIVED |
|---|---|---|
| Existing data | Retained | Retained |
| Organization users | No access — 403 on every route | No access — 403 |
| Platform admin | Can still inspect | Can still inspect |
| New enrollment | **Blocked** (403) | **Blocked** (403) |
| Existing agent telemetry | **Continues** | Continues |
| Listed in active views | Yes, flagged | Hidden by default |

Suspension drops the organization out of a user's membership set entirely, so
they hold no capability anywhere and every route answers 403 rather than an
empty 200. That is the default-deny outcome, and a clearer answer than "you may
look at nothing".

Existing agents keep reporting from a suspended organization deliberately: it is
a commercial or administrative state, and platform operators should not lose
monitoring visibility of endpoints that are still running. Suspension stops
*people* and *new endpoints*, not telemetry already flowing. Historical
telemetry is never deleted.

## PostgreSQL Row Level Security — deferred, with reasons

**Decision: Option A — application-layer isolation through centralized scoped
helpers. RLS is not enabled in this release.**

RLS was evaluated and rejected *for now* because the current connection model
would make it unsafe or misleading rather than protective:

1. **A single pooled role.** The API connects as one PostgreSQL role through a
   `pg.Pool`. RLS would have to be driven by a session variable
   (`SET LOCAL app.organization_ids`), which is only correct inside an explicit
   transaction. Most read paths here are single statements checked out from the
   pool, so a `SET` without `LOCAL` would persist on a pooled connection and
   leak the previous request's tenant into the next one. That is precisely the
   "superficial RLS that can accidentally retain tenant context between pooled
   requests" the task warns against, and it would be worse than no RLS because
   it looks like protection.
2. **The application role owns the tables.** A table owner bypasses RLS unless
   `FORCE ROW LEVEL SECURITY` is set, so adopting RLS also means introducing a
   separate non-owning runtime role and a migration/ownership split.
3. **Background workers legitimately cross tenants.** The alert engine,
   maintenance and notification workers process the whole fleet. They would need
   an explicit, audited bypass, which is a second policy surface to keep correct.

Doing it properly therefore means: a dedicated non-owning runtime role, every
tenant-scoped read wrapped in a transaction that sets the context with `SET
LOCAL`, an explicit bypass role for workers, and tests proving no leakage across
pooled checkouts. That is a coherent piece of work, but it is a change to the
data-access model rather than an addition to it, and it is not a prerequisite
for the isolation this task requires.

What is in place instead: every tenant-scoped query goes through the shared
helpers above, the composite foreign keys and CHECK constraint make the
dangerous rows unrepresentable at the database level regardless of application
code, and the cross-tenant suite exercises the routes over real HTTP.

**Follow-up:** adopt RLS as defence-in-depth (Option B) in a dedicated task —
separate runtime role, transaction-scoped context, worker bypass, pooled-leakage
tests.

## Background workers

The alert engine, maintenance worker and notification worker operate across all
tenants by design — they process the fleet, not a user's view. Interactive
tenant restrictions are deliberately not applied to them. What they must do is
preserve ownership on what they persist, and they do: the alert engine copies
`organization_id` from the device it is evaluating, and the notification outbox
copies it from the originating alert. A platform channel test carries no
organization at all.

## Known limitations

- **Notification channels are platform-global.** Telegram, email and webhook
  destinations come from server environment configuration and are shared by
  every tenant. Delivery *history* is tenant-isolated (`organization_id` derived
  from the alert), and a platform channel test carries no organization so it is
  visible to platform principals only. Per-organization channel configuration is
  deferred; the semantics of the existing channels are deliberately unchanged.
- **RLS deferred** — see above.
- **No self-service password reset, MFA or SSO.** Authentication is intentionally
  minimal in this release: a platform super admin creates accounts and sets
  passwords through `/v1/admin/users`.
- **Services and processes carry no tenant column.** They resolve through the
  device like other device-derived data. The tables are currently empty on the
  pilot because deployed agents do not yet send those snapshots.
- **No caching layer exists**, so there are no tenant-dependent cache keys to
  scope. If one is introduced, every tenant-dependent key must include the
  organization, and platform-global entries must be kept explicitly separate.
