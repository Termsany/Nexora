# Agent protocol

All agent routes are versioned under `/api/v1/agents`. Enrollment accepts a
one-time deployment credential plus a persistent device UUID and returns an
agent token. Subsequent heartbeat, inventory, and metrics requests use
`Authorization: Bearer <agent-token>`.

The backend records `received_at` independently of `captured_at`. Payloads are
validated at the API boundary, and tokens are hashed before persistence.