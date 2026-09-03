# Agent protocol

All agent routes are versioned under `/api/v1/agents`. Enrollment accepts a
one-time deployment credential plus a persistent device UUID and returns an
agent token. Subsequent heartbeat, inventory, and metrics requests use
`Authorization: Bearer <agent-token>`.

The backend records `received_at` independently of `captured_at`. Payloads are
validated at the API boundary, and tokens are hashed before persistence.

Enrollment tokens are created through `/api/v1/admin/enrollment-tokens`, shown
only in the create response, and stored as SHA-256 hashes. Expiration, usage
limits, and revocation are enforced atomically. Agent tokens are independently
generated and stored only as hashes. The Windows agent stores its copy using
machine-scoped DPAPI.

Metric samples are retained as raw history in V1. Initial deployments should
schedule a PostgreSQL retention job once their retention window is known. A
reasonable starting point is 30 days of 30-second samples followed by deletion
or downsampling. No additional time-series infrastructure is required for V1.
