# Host Disk Hygiene & Recurrence Prevention (DISK-01)

Prepared during the DISK-01 emergency (host `/dev/sda1`, 28 GB, hit 94% used /
1.7 GB free). Recovery brought it to 66% / 9.2 GB free by removing only
disposable Docker/test/build artifacts. Production PostgreSQL and its volume
were never touched.

## Root cause

Cumulative disposable-resource debris from the PR-04A/04B and Task008/009/010
test cycles on a small disk with **no pruning or retention guardrails**:

| Class | Before | Notes |
|---|---|---|
| Orphaned anonymous Docker volumes | ~4.0 GB (77 vols) | disposable `postgres:16-alpine` test containers `--rm`'d without `-v`; each left a ~50 MB anonymous volume |
| One-off test/build images | ~5.6 GB | `nexora-api-task010b-release-check`, `nexora-api-task010b-signing-fix`, `nexora-phase1-workspace`, an ad-hoc `node:22` pull |
| Stale Docker build cache | ~2.6 GB | layers from superseded builds, never pruned |
| Superseded `publish/` build outputs | ~0.3 GB | `publish/task010a-*` (gitignored scratch) |

No runaway process; no single large file. Small disk + heavy disposable test
throughput + no cleanup policy.

## Guardrails (LOCAL recommendations — not yet applied)

### 1. Disposable test containers must own-delete their volumes
Every script that runs `docker run ... postgres:16-alpine` for a test must use
`--rm` **and** either a named volume it explicitly removes in a trap, or
`--tmpfs /var/lib/postgresql/data` (fastest; nothing to clean up). Audit:
`scripts/run-task008-tenancy.sh`, `run-task009-security.sh`,
`run-task010-*.sh`, `run-api-integration.sh`.

### 2. Weekly targeted Docker cleanup (never blanket prune)
A cron/systemd-timer script that removes **only**:
- `docker volume ls -qf dangling=true` filtered to 64-hex anonymous names
- images with 0 containers and a name matching `*-task0*-*` / `*-signing-fix` / `*-release-check` / `*-workspace`
- `docker builder prune -f --filter until=168h`

Never `docker system prune`, `docker volume prune`, `docker compose down -v`.

### 3. Docker build cache ceiling
Set `builder.gc` in `/etc/docker/daemon.json`:
```json
{ "builder": { "gc": { "enabled": true, "defaultKeepStorage": "4GB" } } }
```
(Requires a Docker daemon restart — schedule with a maintenance window, do
NOT restart the daemon ad hoc while Production runs.)

### 4. Container log rotation
Add to `/etc/docker/daemon.json`:
```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "3" } }
```
Existing containers keep their old setting until recreated — acceptable, our
containers log little.

### 5. Backup retention
`scripts/backup/retention.sh` already implements 14d/8w/12m. Ensure it runs
after every backup and that `/home/mustafa/.nexora-backups/production/` is the
only backup root. Encrypted PR-04B artifact + `.sha256` + `backup-state.json`
+ `/home/mustafa/.nexora-backups/keys/` are PROTECTED, never in scope.

### 6. `publish/` and Agent build artifacts
`publish/` is gitignored scratch. A build step should `rm -rf publish/<old>`
before writing a new package. `publish/windows-agent/` currently holds
root-owned files from container builds — needs `sudo rm -rf` (left in place
during DISK-01, ~184 MB, harmless).

### 7. VS Code server cache
`~/.vscode-server/cli/servers/` accumulates one directory per server commit
(~2 GB seen). Safe to delete all but the currently-connected version.
`~/.vscode-server/data/CachedExtensionVSIXs/` (~235 MB) is re-downloadable.
Not touched during DISK-01 (active IDE session).

### 8. Disk alert thresholds (for PR-06 self-monitoring)
| Level | Threshold | Action |
|---|---|---|
| WARNING | >= 75% used | notify, review disposable resources |
| HIGH | >= 85% used | run targeted cleanup, page on-call |
| CRITICAL | >= 92% used | emergency cleanup runbook (this doc) |

Wire into the platform self-monitoring being built in PR-06.

## Emergency recovery runbook (what DISK-01 did)

1. `df -hT`, `df -ih`, `docker system df -v`, `du -xhd1 ~` — audit read-only.
2. Capture Production baseline: `docker inspect nexora-postgres-1` (Id,
   StartedAt, RestartCount).
3. Remove dangling anonymous volumes explicitly (loop `docker volume rm` over
   `docker volume ls -qf dangling=true`, guarding each name matches
   `^[0-9a-f]{64}$` so no named volume is caught). **Never `docker volume prune`.**
4. Remove images with 0 containers that are clearly one-off test/build images.
5. `docker builder prune -f --filter until=6h` (keeps active-iteration cache).
6. Delete superseded gitignored `publish/` build dirs.
7. Verify: `df -h`; Production Postgres container Id/StartedAt/RestartCount
   unchanged; migrations = 13; HTTPS 200; `/api/healthz` 200;
   `REMOTE_COMMANDS_ENABLED=false`.
8. Do NOT restart Production, mutate PostgreSQL, or prune broadly.
