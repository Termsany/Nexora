# Remote console latency candidate and rollout

Baseline: the frontend source reproduced byte-identical assets of the production
Web release, plus the subsequently deployed device Remote Desktop toggle.
Baseline snapshot: `/tmp/nexora-rd-button-release/source`.

Confirmed source defect: each binary WebSocket message starts an independent
asynchronous JPEG decode. There is no concurrency bound or stale-socket paint
guard. This can permit decode backlog and out-of-order display; it does **not**
prove the cause of the reported PDC/DEPLOY keyboard latency without runtime data.

The candidate reuses `LatestFrameQueue` (one decoder, one replaceable pending
frame), disposes queues on disconnect, closes decoded bitmaps in `finally`, and
guards canvas/socket identity before painting. Keyboard messages, authentication,
server and Agent are unchanged. Gateway RTT is measured using the existing
session.ping/pong contract and labelled explicitly. It is not Agent input latency
or glass-to-glass latency; an absent measurement displays Unavailable.

Reproducible patch: `scripts/patches/remote-console-input-latency.patch`.
Apply only to a copy of the named baseline, not the divergent primary worktree.
`git apply --check` passed against that baseline. This preserves the production
standalone console, input fixes, reconnect behavior and Remote Desktop toggle.

Candidate source: `/tmp/nexora-input-latency/source`.
Built assets: `/tmp/nexora-input-latency/candidate`.
Tests: 29 passed, 0 failed, 0 skipped (queue, actual paint callback, console and
toggle). Typecheck and Vite production build passed. Existing sourcemap and
bundle-size warnings remain. Two old source-shape tests were updated: one forbade
any ms label, the other required unbounded direct decoding. They now check the
measured RTT source and bounded-decoder integration; new executable paint tests
check stale socket/canvas rejection and bitmap cleanup.

No browser/Windows end-to-end latency result is claimed. Candidate preparation
did not change production, deploy an Agent, change gates or create sessions.

## Approved Web-only rollout, 2026-09-17

User explicitly approved publishing the frontend fix. Tests passed again (29/29),
typecheck passed, and a fresh build matched the candidate bytes before rollout.
Only Web was recreated using `docker compose up -d --no-deps --no-build web`.

- New Web image: `sha256:40fe41b5b694c416cde86e3baea2578d11d320ffe3dddb23859bec99effb1564`.
- Rollback image: `nexora-web:before-input-latency-0993d43b`, pinned to the previous
  image `sha256:0993d43b0a96a2d79b510535b7cdce4ef0479b8a5ca4bd04cdf83fc575b835c6`.
- HTTPS `/api/healthz`: 200 with TLS verification. Web healthy.
- API and PostgreSQL container IDs and start times unchanged, both healthy.
- No Agent deployment, migrations, gate changes or commands/sessions created.

Observed keyboard/display improvement still needs an operator test after loading
the new frontend. Gateway RTT is not end-to-end input latency.
