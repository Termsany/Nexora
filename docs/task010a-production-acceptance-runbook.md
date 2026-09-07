# Task010A Production Acceptance Checkpoint

Run `scripts/deploy/task010a-host-preflight.sh` on the actual Debian production host. Do not use `curl -k`; a Codex sandbox networking failure is not evidence of host failure.

1. Human A authenticates normally and creates a `CMD hostname` request for DEPLOY with an approximately 30-second timeout.
2. Human B, using a separate authorized account, independently reviews and approves the privileged action. Self-approval is rejected.
3. Observe `READY -> CLAIMED -> RUNNING -> SUCCEEDED`, signed claim/start/heartbeat/result, nonce persistence, exit code `0`, separated stdout/stderr, and audit events.
4. Disable DEPLOY's device flag, then the global flag, and verify every device is disabled.

No ADMIN token, direct SQL, fabricated Agent request, or credential pasted into chat is permitted. The only unavoidable manual actions are package placement/upgrade on DEPLOY and independent approval.
