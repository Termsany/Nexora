# First Customer Onboarding + Secure Agent Distribution (PR-05)

Preparation and acceptance-test record for onboarding the first real customer.
Nothing here has been executed against a real customer. Production was read
only for this stage.

---

## 1. Onboarding model & who does what

| # | Step | Performed by | Interface |
|---|------|--------------|-----------|
| 1 | Create customer **organization** | Nexora Platform Admin | `POST /v1/organizations` (platform-only capability `organization:create`) |
| 2 | Create **site(s)** | Nexora Platform Admin *or* Customer Org Admin | `POST /v1/organizations/:id/sites` (`site:manage`) |
| 3 | Invite **customer users**, assign org roles | Nexora Platform Admin (first user) → then Customer Org Admin | user management + `POST /v1/organizations/:id/members` |
| 4 | Mint a **scoped enrollment token** (org + exact site, short expiry, low `max_uses`) | Customer Org Admin (preferred) or Platform Admin | `POST /v1/admin/enrollment-tokens` (`enrollment-token:manage`) |
| 5 | Verify **Stable Agent package** SHA-256 against Administration → Enrollment | Customer Technician | `Get-FileHash` vs `agent-manifest.json` |
| 6 | Establish **TLS trust** for the Nexora Internal Root CA | Customer IT (GPO or per-machine) | see §6 |
| 7 | **Install Agent** on the device | Customer Technician (elevated PowerShell) | `install-agent.ps1 -ApiBaseUrl https://… -EnrollmentToken … -SourcePath …` |
| 8 | Agent **enrolls** (token consumed server-side) | Agent | `POST /v1/agents/enroll` |
| 9 | Verify device in **correct org + site**, telemetry, inventory, alerts | Customer Technician + Nexora | console / API |
| 10 | **Revoke** the enrollment token | Customer Org Admin | `POST /v1/admin/enrollment-tokens/:id/revoke` |
| 11 | **Review audit** trail | Nexora Platform Admin | `GET /v1/audit` |

Least privilege: the Platform Admin does **not** perform routine customer
actions after step 3. Token minting, device viewing, alert triage and site
management are all available to the Customer Org Admin within their own tenant.

---

## 2. Recommended first-customer roles

RBAC source of truth: `artifacts/api-server/src/tenancy/policy.ts`. Three
organization roles exist; map them as:

| Recommended name | Nexora role | Grants (within own org only) | Explicitly denied |
|---|---|---|---|
| **Organization Admin** | `ORGANIZATION_ADMIN` | read all; `sites.manage`, `devices.manage`, `members.manage`, `enrollment_tokens.{read,create,revoke}`, `alerts.acknowledge`, `audit.read`, `notifications.read`, `organizations.manage` (own settings) | create organizations; manage platform users; reach any other tenant |
| **Technician / Operator** | `ORGANIZATION_TECHNICIAN` | read all; `devices.manage` (site assignment), `alerts.acknowledge`, `enrollment_tokens.read`, `audit.read` | create/revoke enrollment tokens; manage members; change org settings |
| **Viewer** | `ORGANIZATION_VIEWER` | read-only: devices, telemetry, alerts, software, services, processes | any mutation; enrollment tokens; audit; members |

Verified by test (`ORGANIZATION_ROLE_*` in `policy.ts`, exercised by
`tenancy.test.mjs` + `tenancy.integration.mjs`):

- org settings: Admin only.
- site create/assign: Admin; site assignment also Technician.
- device / alert / inventory viewing: all three, scoped to own org (and to
  assigned sites where site scoping applies).
- audit read: Admin + Technician.
- enrollment token create/revoke: Admin only. Token **read**: Admin + Technician.
- dangerous features (remote commands / desktop / deployment): see §14 — the
  `remote_commands.*` permissions gate only *request/approval workflow rows*;
  they never enable execution, which is a separate global + per-device gate
  that stays OFF.

---

## 3. Enrollment token security (audited)

Schema `lib/db/src/schema/nexora.ts::enrollmentTokensTable`, logic
`routes/administration.ts` (create/revoke) + `routes/nexora.ts` (consume).

| Property | Status | Evidence |
|---|---|---|
| Tenant-bound | ✅ | `organizationId NOT NULL` FK; org read from consumed token, never from agent |
| Site-bound (optional) | ✅ | `siteId` nullable; composite FK `(siteId, organizationId) → sites(id, organizationId)` blocks pointing at another tenant's site |
| Expiration | ✅ | `expiresAt NOT NULL`; consume predicate `expiresAt > now()` |
| Max-usage | ✅ | `maxUses` / `uses`; consume predicate `uses < maxUses`, atomic `uses = uses + 1` |
| Revocation | ✅ | `active=false, revokedAt=now()`; consume predicate `active = true AND revokedAt IS NULL` |
| Value not recoverable | ✅ | raw `nxen_<base64url(32B)>` returned once at creation; only `sha256(raw)` stored; GET listing never selects `token_hash` |
| Cross-org enroll blocked | ✅ | consumed token row supplies org+site; agent-supplied `organization_id`/`site_id` ignored |
| Expired / revoked / exhausted / malformed all rejected | ✅ | single atomic conditional `UPDATE … RETURNING`; 401 `"Invalid, expired, revoked, or exhausted"` — now covered explicitly by `tenancy.integration.mjs` "enrollment token lifecycle" test |

**First-customer token policy:** `max_uses` = (device count for the batch,
typically 1–5); `expires_at` = end of the deployment window (hours, not days);
`site_id` = the exact target site; **revoke immediately** after the last device
is confirmed enrolled (step 10). One token per site.

---

## 4. Agent distribution model

The current `/downloads/` path (nginx `alias`, `autoindex off`, unauthenticated
but unlisted) is acceptable for the pilot but **not** the long-term
first-customer model. Target model:

| Element | Design |
|---|---|
| Release channels | **STABLE** (first external customer) and **PILOT** (dev/test) — see §15 |
| Immutable package | `nexora-agent-<version>-<gitsha>.zip`; never overwritten in place; a new build is a new filename |
| Integrity | `*.zip.sha256` sidecar + `agent-manifest.json` (`version`, `packageSha256`, `agentSha256`, `packageSizeBytes`, `publishedAt`) |
| Source/release identity | git sha in the filename + manifest; build only from a clean checkout |
| Authenticity | near-term: publish `packageSha256` in the authenticated Administration UI so the technician verifies out-of-band. Next: Authenticode-sign `nexora-agent.exe` with a Nexora code-signing cert (private key on a signing host / HSM, never in the repo or the package) |
| Storage separation | production packages live under a production-only path (`scripts/env/publish-agent-package.sh` resolves it); `build-windows-agent-package.sh` **refuses to run** without an explicit `NEXORA_AGENT_OUT_DIR` so a developer build can never overwrite the customer-visible artifact |
| No developer overwrite path | enforced by the `NEXORA_AGENT_OUT_DIR` guard above |

No new customer-visible package is published in this stage.

---

## 5. Agent package content audit

`build-windows-agent-package.sh` stages exactly five flat entries and
**fails closed** on prohibited content:

- Contents: `nexora-agent.exe` (self-contained, size-checked ≥ 30 MB),
  `install-agent.ps1`, `uninstall-agent.ps1`, `nexora-root-ca.crt`
  (**public** CA cert), `README.txt`.
- Built-in scan rejects: `BEGIN … PRIVATE KEY`, `*.key`, `.env` / `.env.*`,
  `nexora-root-ca.key`, `nexora.design.local.key`, `ADMIN_API_TOKEN=`,
  `JWT_SECRET=`, `ENROLLMENT_SECRET=`, `POSTGRES_PASSWORD=`,
  `DATABASE_URL=…:…@`.
- ZIP entry list is asserted to be exactly the five expected names.

No enrollment token, admin token, DB/JWT secret, CA/server private key,
developer config, logs or test credentials are present. **PASS.**

---

## 6. TLS trust path (first customer)

Server TLS uses the **Nexora Internal CA** (`/etc/nexora/pki/` on the host —
private keys never leave it). Customer must trust the **root CA public cert**
(`nexora-root-ca.crt`, shipped in the package):

- **Domain-joined fleet:** GPO → *Computer Configuration → Policies → Windows
  Settings → Security Settings → Public Key Policies → Trusted Root
  Certification Authorities* → import `nexora-root-ca.crt`.
- **Non-domain device:** elevated PowerShell —
  `Import-Certificate -FilePath .\nexora-root-ca.crt -CertStoreLocation Cert:\LocalMachine\Root`.
- **Customer-managed enterprise PKI:** if the customer would rather issue the
  Nexora server cert from their own CA, that is a separate server-cert
  provisioning task; the Agent only needs the machine trust store to chain.

Agent HTTPS validation stays strict: `install-agent.ps1` requires
`^https://`, and the Agent has **no** insecure-TLS / cert-bypass switch. Ref:
`docs/windows-internal-ca-trust.md`.

---

## 7. Windows installer acceptance (`scripts/windows/install-agent.ps1`)

| Check | Result |
|---|---|
| HTTPS required | ✅ `[ValidatePattern('^https://')]` on `-ApiBaseUrl` |
| Enrollment token required (fresh install) | ✅ `-EnrollmentToken` mandatory |
| Elevation required | ✅ explicit Administrator role check |
| Install path | ✅ `%ProgramFiles%\Nexora\Agent`; data `%ProgramData%\Nexora\Agent`; logs under data |
| Service automatic | ✅ `New-Service … -StartupType Automatic` |
| Service recovery | ✅ `sc.exe failure … restart/10000/restart/30000/restart/60000` + `failureflag 1` |
| Credential storage | ✅ DPAPI **LocalMachine** (`SecureStorageService.cs`: `ProtectedData.Protect(…, DataProtectionScope.LocalMachine)`) |
| No secrets printed | ✅ only prints install path + service state |
| Repeat install | ✅ stops + `sc.exe delete` existing service, re-copies, re-configures |
| Upgrade | ✅ separate `upgrade-agent.ps1` — SHA-256 verified, zip-slip guarded, downgrade-refused, backup + auto-restore on failure, never touches `%ProgramData%` identity/credentials |
| Uninstall | ✅ `uninstall-agent.ps1` (`-PurgeData` optional) |
| Failure state | ⚠️ throws on error; a partially-copied `%ProgramFiles%\Nexora\Agent` can remain. Agent logs under `%ProgramData%\Nexora\Agent\Logs`. |

**Local hardening recommended for next release:** add an optional
`-ExpectedSha256` to `install-agent.ps1` (parity with `upgrade-agent.ps1`) and
clean up a partial install dir on failure. PowerShell execution policy is
**not** weakened globally — run the packaged scripts with
`powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 …` from the
elevated session, or `Unblock-File` the extracted scripts first.

---

## 8–13. Acceptance testing (disposable, automated)

The disposable multi-tenant customer simulation and its enrollment / isolation
/ telemetry / audit acceptance are the **Task008** integration suite
(`artifacts/api-server/src/tenancy/tenancy.integration.mjs`, run by
`scripts/run-task008-tenancy.sh` against a throwaway Postgres + real built
server). It seeds multiple organizations, sites and role-differentiated users
entirely through the API — no manual DB edits.

Covered and passing (**38/38**):

- **Enrollment (§9):** cross-org mint denied; agent cannot choose its own
  org/site; **exhausted / revoked / expired / malformed tokens refused**
  (added this stage); suspended org rejects enrollment; token listing
  tenant-scoped and never returns the secret.
- **Post-enrollment device (§10):** device lands in the token's org+site;
  agent's own bearer credential drives heartbeat + metrics; tenant follows the
  device; a stolen agent credential opens no console route.
- **Isolation (§12) — hard go-live gate:** User A cannot list, open by direct
  ID (404 not 403 — IDOR), search, paginate into, aggregate, or mutate Org B's
  devices / metrics / inventory / alerts / sites; the DB itself refuses a
  cross-tenant site assignment; even a platform admin cannot place a device in
  another tenant's site; site-level restrictions inside one org hold.
- **Audit (§13):** `ENROLLMENT_TOKEN_CREATED`, `ENROLLMENT_TOKEN_REVOKED`,
  `AGENT_ENROLLED` rows written; `recordAudit` metadata carries name/scope/limits
  only — never the token or its hash (Task009 also asserts audit rows never
  contain submitted passwords/secrets).

RBAC / session / CSRF / break-glass token / two-person approval: **Task009**
(`scripts/run-task009-security.sh`) — **28/28**.

Alerting (§11): `alerts/*.test.mjs` (dedup, state lifecycle, tenant ownership)
pass in the 60/60 unit run; `DEVICE_OFFLINE` / `CPU_HIGH` / `MEMORY_HIGH` /
`DISK_HIGH` evaluation is exercised by the maintenance worker
(`AlertEvaluationSucceeded` in production logs). External notification delivery
is validated separately when SMTP/webhook credentials are available.

---

## 14. Remote-execution lockdown (first-customer policy)

Onboarding requires **no** remote execution. Confirmed:

- `REMOTE_COMMANDS_ENABLED=false` on the live API container (global gate).
- `nexora_devices.remote_commands_enabled` default `false`; 0 devices enabled.
- `remote_command_jobs` in a runnable state: 0.
- `privileged_actions` is an approval-workflow table only — "No dispatch,
  execution, output, or command queue exists" (schema comment).
- No onboarding step in §1 touches any of these.

First-customer deployment policy: Remote Commands OFF, Remote Desktop OFF,
Software Deployment OFF, Patch Deployment OFF, File Transfer OFF. Device
remote-command gate default: `false`.

---

## 15. Agent release channels

| Channel | Audience | Package name | Guardrail |
|---|---|---|---|
| **STABLE** | first external customer, production | `nexora-agent-<version>-<gitsha>.zip` published via `scripts/env/publish-agent-package.sh production` | only this script may target the customer-visible path |
| **PILOT** | internal dev/test | `nexora-agent-pilot.zip` | `build-windows-agent-package.sh` refuses to run without `NEXORA_AGENT_OUT_DIR`, so a dev build cannot land on the STABLE path |

`agent-manifest.json` records `version` + `publishedAt`; add a `channel` field
when the STABLE publish path is wired. A dev/PILOT build is never renamed to a
STABLE filename.

---

## 16. nginx upstream hardening (local, for next release)

Confirmed failure mode: `proxy_pass http://api:3001;` pins the API container's
IP at nginx worker start; after the API container is recreated, nginx returns
502 until `web` is restarted.

Fix applied to `docker/nginx.conf` (not deployed):

```nginx
location /api/ {
    resolver 127.0.0.11 valid=10s ipv6=off;   # Docker embedded DNS
    set $nexora_api_upstream "api:3001";
    proxy_pass http://$nexora_api_upstream;    # variable ⇒ per-request re-resolution
    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_connect_timeout 2s;
    …
}
```

`nginx -t` passes. In a disposable bridge-network repro, the recreated backend
was picked up by the new config (request proxied to the new container, not a
502 from the stale IP); the old static config stayed broken. Ships with the
next immutable release; Production nginx unchanged this stage.

---

## 17. First-customer installation runbook

**Pre-check (Nexora):** HTTPS 200, `/api/healthz` 200, PostgreSQL healthy,
migrations = 13, `REMOTE_COMMANDS_ENABLED=false`, a verified encrypted backup
exists.

1. **Create org** — `POST /v1/organizations` (Platform Admin).
2. **Create site(s)** — `POST /v1/organizations/:id/sites`.
3. **Create users / assign roles** — first Org Admin by Platform Admin; the
   rest by the Org Admin. Roles per §2.
4. **Create a limited enrollment token** — Org Admin,
   `POST /v1/admin/enrollment-tokens`: exact `site_id`, `max_uses` = batch
   size, `expires_at` = end of the deployment window.
5. **Verify Stable Agent package** — download; `Get-FileHash .\<pkg>.zip
   -Algorithm SHA256` must equal `packageSha256` in Administration →
   Enrollment. Verify `nexora-agent.exe` hash against `agentSha256`.
6. **Establish TLS trust** — GPO or `Import-Certificate … Cert:\LocalMachine\Root`
   (§6). Confirm `https://<host>` opens with no warning.
7. **Install Agent** — elevated PowerShell:
   `powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -ApiBaseUrl "https://<host>/api" -EnrollmentToken "<token>" -SourcePath "<extracted-package>"`.
8. **Verify device / site** — device appears in the correct org **and** site;
   `Agent ID` present; status goes online.
9. **Verify telemetry** — CPU / memory / disk metrics arriving; historical
   points accumulate.
10. **Verify inventory** — software, services, and (where the Agent supports
    it) process inventory populated; OS identity + uptime correct.
11. **Verify alerting** — take one device offline briefly → `DEVICE_OFFLINE`
    raised, owned by the correct tenant, visible in API + UI; clears on
    recovery. (Don't generate noisy alerts.)
12. **Revoke the enrollment token** — `POST /v1/admin/enrollment-tokens/:id/revoke`;
    confirm a further enroll attempt returns 401.
13. **Review audit** — `GET /v1/audit`: org create, site create, membership
    changes, token create, token revoke, `AGENT_ENROLLED` all present; no raw
    token values.
14. **Confirm dangerous features OFF** — global gate false; device
    `remote_commands_enabled` false.
15. **Customer acceptance** — walk the checklist in §18 with the customer.

**Rollback / uninstall:**
`powershell -ExecutionPolicy Bypass -File .\uninstall-agent.ps1` (add
`-PurgeData` to also remove `%ProgramData%\Nexora\Agent`). Revoke the
enrollment token. Optionally delete the device record from Administration.
Trust-root removal (if required): `Get-ChildItem Cert:\LocalMachine\Root |
? Subject -match 'Nexora' | Remove-Item`.

---

## 18. Customer acceptance checklist

| Item | Pass criteria |
|---|---|
| ORG_CREATED | organization visible, status ACTIVE |
| SITES_CREATED | each target site present under the org |
| ROLES_VERIFIED | Org Admin / Technician / Viewer behave per §2 |
| TOKEN_SCOPED | token bound to exact org + site |
| TOKEN_EXPIRY_SET | `expires_at` within the deployment window |
| TOKEN_USAGE_LIMIT_SET | `max_uses` = batch size |
| TLS_TRUSTED | `https://<host>` opens with no cert warning on the device |
| AGENT_CHECKSUM_VERIFIED | `Get-FileHash` matches `packageSha256` / `agentSha256` |
| AGENT_INSTALLED | `Get-Service NexoraAgent` = Running, StartType Automatic |
| DEVICE_CORRECT_TENANT | device under the customer org, not visible to any other |
| DEVICE_CORRECT_SITE | device under the intended site |
| TELEMETRY_RECEIVED | CPU/mem/disk metrics + history |
| INVENTORY_RECEIVED | software + services (+ processes where supported) |
| ALERTS_WORKING | `DEVICE_OFFLINE` raised + cleared for the test device |
| TOKEN_REVOKED | post-deployment enroll attempt → 401 |
| AUDIT_PRESENT | create/revoke/enroll rows in `GET /v1/audit`, no secrets |
| CROSS_TENANT_DENIED | another tenant's user gets 404 for this device by ID |
| REMOTE_COMMANDS_OFF | global gate false; device gate false |
| REMOTE_DESKTOP_OFF | not enabled |
