# Security model

Production transport is HTTPS-only. Enrollment credentials are separate from
per-agent credentials and are never used for telemetry. Agent bearer tokens are
hashed in the database and redacted from structured logs. The Windows agent
keeps its durable UUID under `%ProgramData%\Nexora\Agent` and protects
enrollment and agent credentials with machine-scoped Windows DPAPI. The raw
enrollment token is removed after successful enrollment. Non-loopback API
configuration requires HTTPS.

V1 intentionally exposes no shell, PowerShell, file transfer, remote desktop,
or arbitrary command execution capability.
