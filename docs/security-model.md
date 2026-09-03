# Security model

Production transport is HTTPS-only.

## Console authentication

Operators sign in with an email and password and receive an httpOnly,
SameSite=Lax session cookie (12 hours, no sliding renewal). Only the SHA-256
hash of the session token is stored, so a database disclosure cannot be replayed
as a login. Passwords are hashed with scrypt (N=2^15, r=8). Login answers
unknown-email, wrong-password and disabled-account identically and with
comparable timing, so it cannot enumerate accounts; changing a password or
disabling an account revokes that user's live sessions.

`ADMIN_API_TOKEN` remains a platform-level machine credential for bootstrapping
and automation. It is never issued to a tenant, never placed in agent
configuration, and never held by the browser — the console stores no credential
at all.

## Tenant isolation

Every request resolves to a tenant scope that is applied in SQL, and a
tenant-invisible object returns 404 rather than 403 so IDs cannot be enumerated
across organizations. Cross-tenant assignment is additionally unrepresentable in
the schema: composite foreign keys tie a device or enrollment token to a site
inside its own organization. See [multi-tenancy.md](multi-tenancy.md) for the
full model, the role matrix, and the reasoning behind deferring PostgreSQL RLS.

## Agent credentials

Enrollment credentials are separate from
per-agent credentials and are never used for telemetry. Agent bearer tokens are
hashed in the database and redacted from structured logs. The Windows agent
keeps its durable UUID under `%ProgramData%\Nexora\Agent` and protects
enrollment and agent credentials with machine-scoped Windows DPAPI. The raw
enrollment token is removed after successful enrollment. Non-loopback API
configuration requires HTTPS.

An agent bearer token authenticates telemetry for exactly one device and opens
no console route: its tenant is derived from the device it belongs to, never
from anything the agent sends.

V1 intentionally exposes no shell, PowerShell, file transfer, remote desktop,
or arbitrary command execution capability.

## Threat model

Trust boundaries are the HTTPS reverse proxy, the Express API, PostgreSQL, the
browser console, and each managed Windows endpoint. Platform super administrators,
platform operators, organization administrators/technicians/viewers, and the
Windows Agent are distinct principals. Unauthenticated clients, compromised
tenant accounts, compromised endpoints, and malicious insiders are assumed
hostile.

Tenant data, telemetry, alerts, inventory, sessions, enrollment material,
Agent credentials, and future remote-action approvals are protected assets.
The primary threats are IDOR and cross-tenant queries, role escalation,
session theft/fixation/CSRF, brute force and credential stuffing, leaked
tokens, enrollment replay or tenant override, compromised Agents, and abuse
of future privileged operations. Server-derived tenant scope, default-deny
capabilities, hidden 404s, hashed credentials, bounded sessions, CSRF/origin
checks, rate limiting, append-only audit records, and two-person approval
address these threats. TLS protects requests in transit; captured Agent
requests remain a future replay-hardening consideration.
