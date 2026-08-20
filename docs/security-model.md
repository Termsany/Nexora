# Security model

Production transport is HTTPS-only. Enrollment credentials are separate from
per-agent credentials and are never used for telemetry. Agent bearer tokens are
hashed in the database and redacted from structured logs. The Windows agent
keeps its durable identity under `%ProgramData%\Nexora\Agent`; credential
storage is reserved for DPAPI-backed configuration in the next agent slice.

V1 intentionally exposes no shell, PowerShell, file transfer, remote desktop,
or arbitrary command execution capability.