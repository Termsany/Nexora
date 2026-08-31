# Alert Engine V1

Nexora evaluates operational alerts in the maintenance container every 30 seconds. Metric ingestion does not run alert queries, so agent requests remain fast. The evaluator loads devices, active alerts, each device's five most recent CPU/memory samples from the last 180 seconds, and the latest per-volume disk sample from the last 90 seconds. A failure while persisting one device is logged without preventing evaluation of the remaining devices. Telemetry retention and alert evaluation have separate failure handling.

## Alert types and thresholds

| Type | Resource identity | Warning | Critical | Recovery |
| --- | --- | ---: | ---: | ---: |
| `DEVICE_OFFLINE` | Device | n/a | Derived status is `OFFLINE` | Derived status is no longer `OFFLINE` |
| `CPU_HIGH` | Device | 5-sample average >= 80% | 5-sample average >= 95% | 5-sample average < 70% |
| `MEMORY_HIGH` | Device | 5-sample average >= 80% | 5-sample average >= 95% | 5-sample average < 70% |
| `DISK_HIGH` | Device and volume | Latest value >= 85% | Latest value >= 95% | Latest value < 80% |

CPU and memory require exactly five recent samples. The newest sample must be no more than 90 seconds old and the oldest sample must be no more than 180 seconds old. A value between the recovery and warning thresholds holds the existing state. An active alert retains critical severity until recovery. Disk is evaluated independently for each volume and requires a sample no more than 90 seconds old. Stale or missing telemetry never creates a telemetry alert and resolves an existing telemetry alert with a `TELEMETRY_STALE` reason. Offline detection continues independently using the backend-derived device status.

Agent 0.1.0 remains compatible but may not publish continuous per-volume disk metrics. Such sparse inventory data is not used as a current disk signal. The prepared Agent 0.2.0 protocol publishes continuous volume metrics.

## Lifecycle and deduplication

Alerts use `OPEN`, `ACKNOWLEDGED`, and `RESOLVED` states. Detection creates an `OPEN` alert. An administrator can transition `OPEN` to `ACKNOWLEDGED`; acknowledgement records the server-controlled actor and does not suppress evaluation. Recovery transitions either active state to `RESOLVED`. A resolved alert cannot be acknowledged or reopened. A later condition creates a new incident.

Deduplication keys combine type, device, and resource, for example `CPU_HIGH:<device-id>` and `DISK_HIGH:<device-id>:C:`. PostgreSQL enforces one `OPEN` or `ACKNOWLEDGED` row per key with a partial unique index. Continued detections update the current value and time and increment `occurrence_count`; only meaningful lifecycle or severity changes create history events.

## Database model

`nexora_alerts` stores organization, device, type, severity, state, resource, display fields, lifecycle timestamps, acknowledgement actor, trigger and threshold values, deduplication key, occurrence count, and audit timestamps. It is indexed for active deduplication, state/severity/recent lists, device lists, and organization lists.

`nexora_alert_events` stores `CREATED`, `SEVERITY_CHANGED`, `ACKNOWLEDGED`, and `RESOLVED` events with before/after state and severity, actor, timestamp, and metadata. Events are indexed by alert and timestamp. Device organization is copied into each alert so future tenant authorization and policy lookup can be added without changing incident history.

## API and UI

- `GET /api/v1/alerts` supports `state`, `severity`, `type`, `device_id`, `organization`, `active`, `page`, and `page_size`. Results sort by most recently triggered first.
- `GET /api/v1/alerts/:alert_id` returns the alert, device context, and ordered event timeline.
- `POST /api/v1/alerts/:alert_id/acknowledge` requires the existing administrative bearer token. The actor cannot be supplied by the client.
- `GET /api/v1/dashboard/alerts` returns active, critical, and warning totals plus five recent active alerts.

The Alerts page provides lifecycle tabs, severity/type/device filters, pagination, detail timeline, and acknowledgement. Device Details has a device-filtered Alerts tab. Overview keeps health and alert counts separate and shows a concise active-alert list. Empty datasets display real empty states and never synthetic incidents.

## Operations and future work

At 100 endpoints the evaluator reads at most 500 CPU/memory rows plus one current row per reported volume every 30 seconds. Queries are set based and use recent time windows; dashboard aggregation is not performed per device. At larger scale, evaluation can be partitioned by organization or device range without changing alert keys or lifecycle semantics.

Notifications, policy editing, per-device overrides, suppression, maintenance windows, and automatic remediation are extension points and are not implemented in V1. Maintenance windows and tenant-aware authorization are required before a larger production rollout.
