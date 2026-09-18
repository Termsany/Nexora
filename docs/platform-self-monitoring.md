# Nexora Platform Self-Monitoring (PR-06)

> The least-privilege implementation and validation status are now documented in
> [monitoring-least-privilege.md](monitoring-least-privilege.md). Its runtime,
> credentials, TCP/view access, metadata and sandbox instructions supersede the
> historical Docker-group/socket/dump-access deployment draft below. Do not
> install units using the legacy instructions in this document.

Operational monitoring of **Nexora itself** — the piece that has to work before
the first external customer goes live. This is separate from `DEVICE_OFFLINE`
and the per-endpoint alerting the product already does; it watches the
platform.

Nothing here is deployed yet. Local implementation + disposable validation
only.

## Components

| Path | Runs where | Purpose |
|---|---|---|
| `scripts/monitoring/platform-health.sh` | Nexora host (systemd timer, every 2 min) | One pass over all 8 health domains; emits JSON + a structured exit code (0 healthy / 1 warning / 2 critical / 3 unknown). Read-only. No secrets in output. |
| `scripts/monitoring/edge-watch.sh` | **A different host** | Independent external check of the public endpoints with consecutive-failure logic and its own notification hook. The only thing that can report a *total* Nexora outage. |
| `scripts/monitoring/notify-local.sh` | Nexora host | Incident notifier that does **not** depend on the notification-worker (so it can report that the worker is dead). journal + spool file + optional webhook/mail. |
| `scripts/monitoring/systemd/*.{service,timer}` | templates | `nexora-platform-health.*` for the host; `nexora-edge-watch.*` for the external host. |
| `scripts/run-pr06-monitoring-scenarios.sh` | dev/CI | 23 disposable failure/recovery assertions. |

## Health model

State values: `HEALTHY` · `WARNING` · `CRITICAL` · `UNKNOWN`. Overall = worst domain.

| Domain | Signal | Healthy | Warning | Critical | Interval | Notify |
|---|---|---|---|---|---|---|
| **EDGE** | `GET /` + `GET /api/healthz` from off-box, consecutive failures | both 200 | 2 consecutive failures | 3 consecutive failures | 60 s (external), 2 min (host) | on state change only |
| **API** | api container status + healthcheck + restart count | running, healthcheck `healthy` | running but `RestartCount >= 3` | not running, or healthcheck `unhealthy` | 2 min | on state change |
| **DATABASE** | `SELECT 1` + migration count over the local socket (independent of the API process) | reachable, latency < 250 ms | latency 250–1500 ms | unreachable, or migration metadata unreadable | 2 min | on state change |
| **WORKERS** | container running **and** `nexora_worker_heartbeats.last_seen_at` fresh | both fresh (< 10 min) | heartbeat 10–30 min stale | container down, or heartbeat > 30 min stale | 2 min | on state change |
| **BACKUP** | `backup-state.json` age + checksum re-verify | age ≤ 24 h, checksum ok | age 24–36 h | age > 36 h, no successful backup recorded, or checksum mismatch | 30 min | on state change; daily reminder while WARNING |
| **CAPACITY** | `df` bytes + inodes for `/` and `/var/lib/docker`; MemAvailable %; swap % | disk < 75 %, inode < 75 %, mem-available > 15 %, swap < 50 % | disk 75–92 %, inode 75–92 %, mem-available ≤ 15 %, swap ≥ 50 % | disk ≥ 92 %, inode ≥ 92 %, mem-available ≤ 7 %, swap ≥ 80 % | 5 min | on state change; repeat every 30 min while CRITICAL |
| **TLS** | server cert days-remaining + issuer check | > 45 days, issuer = Nexora Internal Root CA | ≤ 45 days, or unexpected issuer | ≤ 14 days, or handshake fails | 6 h | on state change; daily reminder while WARNING/CRITICAL |
| **AGENT_INGESTION** | fleet-wide: devices online vs. last global telemetry/inventory ingest time | telemetry ingested < 15 min ago (or no devices yet) | ≥ 1 agent online but no telemetry for 15–45 min | ≥ 1 agent online but no telemetry for > 45 min | 5 min | on state change |

Noise control: alerts fire **only on a state transition**, never every interval.
EDGE uses consecutive-failure counting so a single blip never pages. CAPACITY
and TLS add a bounded reminder cadence while unhealthy. `platform-health.sh`
persists per-domain counters in `$NEXORA_MON_STATE_DIR`
(`${XDG_STATE_HOME:-~/.local/state}/nexora-monitoring`).

## Internal self-monitoring API (optional, not built)

If a UI surface is wanted later, add `GET /api/v1/admin/platform-health`
(platform role only) that shells `platform-health.sh --json-only` or
re-implements the same checks and returns the same
`{overall, domains:{<name>:{state,detail}}}` contract. It must never echo
credentials, environment variables, tokens or secret paths — the `detail`
strings are already limited to states, ages, percentages and counts.

## External failure detection

`edge-watch.sh` **must** run on a host that is not the Nexora host — a small
VM, a Raspberry Pi, a CI runner, anything with `curl`, `date` and a way to
notify. It depends on nothing inside Nexora. Deploy:

```
# on the watcher host
install -D -m755 edge-watch.sh /opt/nexora-edge-watch/edge-watch.sh
install -D -m755 <your notifier> /usr/local/bin/nexora-oncall-notify
# trust the Nexora Internal Root CA so TLS verifies (do NOT set NEXORA_WATCH_INSECURE)
cp nexora-root-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates
systemctl enable --now nexora-edge-watch.timer
```

`NEXORA_WATCH_NOTIFY_CMD` gets the one-line message on stdin and must reach a
human through a path that does not traverse Nexora (SMS gateway, a different
provider's webhook, PagerDuty, etc.).

Until a second host exists: `EXTERNAL_WATCHER_HOST = NOT_CONFIGURED`. The
script is implemented and validated locally; only the deployment target is
missing.

## Notification routing for platform incidents

| Incident | Primary path | Independent of |
|---|---|---|
| Total Nexora outage (EDGE CRITICAL) | `edge-watch.sh` → `NEXORA_WATCH_NOTIFY_CMD` on the external host | the entire Nexora host |
| API / DATABASE / WORKERS / CAPACITY / TLS / BACKUP / INGESTION | `platform-health.sh` non-zero exit → systemd `ExecStopPost` → `notify-local.sh` | the notification-worker (uses journal + spool + optional direct webhook/mail) |
| notification-worker itself dead | WORKERS CRITICAL via the path above | the notification-worker |

`notify-local.sh` always writes the journal and a spool file
(`/var/log/nexora-platform-incidents.log`) so an incident is never lost even
if every outbound channel fails.

## Runbook — per signal

### EDGE CRITICAL (public outage)
- **Causes:** web/nginx down, api down, host down, DNS, cert, network/firewall.
- **First response:** from the external host, `curl -v https://nexora.design.local/`. On the Nexora host (if reachable): `docker compose -f compose.yaml ps`, `docker logs --tail 100 nexora-web-1`, `docker logs --tail 100 nexora-api-1`.
- **Common fix:** api container recreated and nginx holding a stale upstream IP → `docker restart nexora-web-1` (the dynamic-resolution nginx fix in `docker/nginx.conf` removes this once released).
- **Escalation:** host unreachable → infrastructure / hosting provider.
- **Recovery check:** `platform-health.sh` overall HEALTHY for 2 consecutive passes; external watcher back to HEALTHY.

### API WARNING/CRITICAL
- **Causes:** crash loop (bad config/secret, DB unreachable at boot), OOM kill, healthcheck failing.
- **First response:** `docker inspect nexora-api-1 --format '{{.State.Health.Status}} {{.RestartCount}}'`; `docker logs --tail 200 nexora-api-1`. Check DATABASE domain first — API cannot boot without the DB.
- **Escalation:** repeated crash after DB confirmed healthy → roll back to the last known-good image (do **not** rebuild from the worktree).
- **Recovery check:** running, healthcheck `healthy`, RestartCount stable.

### DATABASE CRITICAL
- **Causes:** postgres container stopped, disk full (see CAPACITY), volume issue, connection exhaustion.
- **First response:** `docker inspect nexora-postgres-1 --format '{{.State.Status}} {{.State.Health.Status}}'`; `docker logs --tail 100 nexora-postgres-1`; `df -h /var/lib/docker`.
- **Do not:** run migrations, `pg_restore`, or mutate data as a "fix". A restore is a separate, authorized operation.
- **Recovery check:** `SELECT 1` returns, migration count = 13, latency normal.

### WORKERS WARNING/CRITICAL
- **Causes:** worker process crashed inside a "running" container, wedged on a slow query, DB unreachable.
- **First response:** `docker logs --tail 200 nexora-maintenance-1` / `nexora-notification-worker-1`; check the last heartbeat: `docker exec nexora-postgres-1 psql -U nexora -d nexora -tAc "SELECT worker, last_seen_at FROM nexora_worker_heartbeats"`.
- **Fix:** `docker restart nexora-maintenance-1` (or the notification worker). Confirm the heartbeat advances.
- **Recovery check:** heartbeat fresh (< 10 min) for both workers.

### BACKUP WARNING/CRITICAL
- **Causes:** nightly backup timer didn't run, `pg_dump` failed, disk full, checksum mismatch (corruption or partial write).
- **First response:** `scripts/backup/backup-status.sh /home/mustafa/.nexora-backups/production`; check the systemd backup timer; `df -h` on the backup filesystem.
- **RPO:** target ≤ 24 h. WARNING at 24 h gives one missed run of margin before CRITICAL at 36 h.
- **Off-host:** currently `NOT_CONFIGURED` — provision an off-host destination for `scripts/backup/offhost-copy.sh` before go-live.
- **Recovery check:** a fresh successful backup, checksum ok, age < 24 h.

### CAPACITY WARNING/CRITICAL — with the DISK-01 incident as the worked example
- **What happened:** the host filled to 94 % (1.7 GB free). Root cause was cumulative disposable Docker debris — ~77 orphaned anonymous volumes (~4 GB) from `--rm` test containers that dropped their data volumes, ~5.6 GB of one-off test/build images, ~2.6 GB stale build cache — on a 28 GB disk with no pruning guardrails. No runaway process; no single large file.
- **First response:** `df -hT`, `df -ih`, `docker system df -v`, `du -xhd1 ~`.
- **Recovery (what DISK-01 did):** remove *dangling anonymous volumes* explicitly — loop `docker volume rm` over `docker volume ls -qf dangling=true`, guarding each name matches `^[0-9a-f]{64}$` so no named volume is caught; remove images with 0 containers that are clearly one-off test/build images; `docker builder prune -f --filter until=6h`; delete superseded gitignored `publish/` build dirs. Recovered ~7.5 GB → 9.2 GB free.
- **Never:** `docker system prune`, `docker volume prune`, `docker compose down -v`, or restart Production to free space.
- **Memory/swap:** alert on `MemAvailable` %, not bare "used" (Linux uses free RAM for cache). The host previously saw VS Code extensionHost pressure; `~/.vscode-server/cli/servers/` accumulates one dir per version and is safe to trim to the connected one.
- **Prevention:** see `docs/disk-hygiene.md` — weekly targeted cleanup timer, `builder.gc` storage ceiling in `/etc/docker/daemon.json`, container log rotation, and test scripts that use `--tmpfs` or own-delete their volumes.
- **Recovery check:** disk < 75 %, inodes < 75 %, swap < 50 %.

### TLS WARNING/HIGH/CRITICAL
- **Causes:** cert approaching expiry; unexpected issuer (wrong cert deployed); handshake failure.
- **First response:** `echo | openssl s_client -connect nexora.design.local:443 -servername nexora.design.local 2>/dev/null | openssl x509 -noout -subject -issuer -enddate`.
- **Fix:** issue a new server cert from the Nexora Internal CA (private key stays on the host, `/etc/nexora/pki/`), install it, `docker restart nexora-web-1`. Never move the CA private key.
- **Recovery check:** days-remaining > 45, issuer = Nexora Internal Root CA.

### AGENT_INGESTION WARNING/CRITICAL (systemic, not one endpoint)
- **Causes:** ingestion route broken by a bad deploy, DB write failures, a queue/lease stuck, clock skew rejecting payloads.
- **Not this alert:** a single endpoint offline — that's `DEVICE_OFFLINE`.
- **First response:** `docker logs --tail 200 nexora-api-1 | grep -i metric`; check DATABASE and WORKERS domains; `SELECT max(received_at) FROM nexora_device_metrics` vs `count(*) FROM nexora_devices WHERE last_seen_at > now() - interval '5 min'`.
- **Recovery check:** last global telemetry ingest < 15 min, inventory advancing.

## Deploying (later, with the next immutable release)

Host: `install` the three scripts under `/opt/nexora-monitoring/`, drop the
two host units in `/etc/systemd/system/`, `systemctl enable --now
nexora-platform-health.timer`. Configure `notify-local.sh` env
(`NEXORA_NOTIFY_WEBHOOK` / `NEXORA_NOTIFY_MAIL_TO`).

External host: as in *External failure detection* above.

Do not deploy any of this as part of PR-06.
