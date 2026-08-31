# Windows services and processes inventory

Agent 0.3.0 adds read-only Windows services and current-process inventory. It does not expose service control, process termination, remote shell, PowerShell, or arbitrary command execution.

## Collection

- Services run independently every 5 minutes and use typed `Win32_Service` WMI records. `service_name` is the stable per-device identity; display names are metadata.
- Processes run independently every 60 seconds and use `System.Diagnostics.Process`. Identity is `(device_id, pid, started_at)`, which prevents PID reuse from merging processes.
- CPU time is cumulative. CPU percent requires two samples and is calculated as `(CPU time delta / wall-time delta / logical processors) * 100`, clamped to 0-100. The first sample is null.
- Access-denied and exited-process failures are isolated per item and make the snapshot partial. A collector-wide failure produces a failed snapshot.
- Command lines are intentionally not collected in V1 because generic redaction cannot reliably cover every application's secret syntax. Environment variables, window titles, file contents, and process memory are also not collected.
- Owner and executable path may be unavailable under Windows service permissions. Architecture is reported as unknown when it cannot be determined safely.

Every payload carries a UUID snapshot ID, collection time, complete/partial/failed status, item count, and agent version. Retries of a snapshot ID are idempotent. Only complete snapshots can mark missing services absent or replace the current process set. Partial snapshots may refresh visible records but never infer disappearance.

## Storage and retention

Services are canonical current-state rows and are marked absent rather than hard-deleted. Meaningful changes after the first complete baseline are retained for 365 days. Processes use a current-state table only; no process start/stop event stream is created. Process snapshot receipts are retained for 24 hours and other idempotency receipts for 365 days.

## Upgrade

Install the 0.3.0 package over the existing Windows service. The installer preserves `%ProgramData%\Nexora`, including device identity and DPAPI-protected credentials, so re-enrollment is not required. Older 0.1.0 and 0.2.0 agents remain accepted by existing ingestion endpoints.
