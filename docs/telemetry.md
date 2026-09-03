# Historical telemetry

## Data flow and time

The Windows Agent samples every 30 seconds. Agent 0.2.0 posts one device sample and
one disk sample per reported volume. The API keeps `captured_at` for diagnostics but
uses PostgreSQL `timestamptz` `received_at`, assigned by the server, for ordering,
bucketing, range filtering, and retention. API timestamps are ISO 8601 UTC; charts
format them in the browser's local timezone.

Agent 0.1.0 remains compatible. Its metrics payload has no per-volume `disks` array,
so device CPU, memory, uptime, and legacy highest-disk history continue normally.
Its periodic inventory posts create truthful, sparse per-volume disk observations.

## Schema

`nexora_device_metrics` is the recent raw device series: device, captured/received
time, CPU percentage, memory percentage and byte counts, legacy highest disk
percentage, and uptime. `(device_id, received_at)` supports history and latest-value
queries; `received_at` indexes support global retention cleanup.

`nexora_disk_metrics` is the raw per-volume series: device, optional parent metric,
volume, filesystem, byte counts, usage percentage, and captured/received time. It
has `(device_id, received_at)`, `(device_id, volume, received_at)`, and unique
`(metric_id, volume)` indexes. A null parent identifies a sparse inventory sample.

`nexora_metric_aggregates` contains hourly and daily device buckets. It stores CPU
and memory average/minimum/maximum, average memory bytes, latest uptime, and sample
count. `nexora_disk_metric_aggregates` contains usage average/minimum/maximum/latest,
latest byte counts, and sample count per volume. Unique bucket keys make reruns
idempotent; matching compound indexes serve API ranges.

Migration `lib/db/drizzle/0002_wooden_catseye.sql` adds these structures and
`lib/db/drizzle/0003_windy_harpoon.sql` adds the retention indexes, without dropping
or rewriting existing Pilot data.

## Aggregation and retention

- Raw device and disk samples: 7 days.
- Hourly aggregates: 90 days.
- Daily aggregates: 365 days.
- Buckets use UTC hour/day boundaries.
- Missing samples are absent and never converted to zero.

The dedicated Compose `maintenance` service starts after successful migrations,
runs a full repair/backfill immediately, then refreshes the latest two hours and
two days every five minutes. A restart repeats the full repair. One database
transaction upserts hourly buckets from raw data, upserts weighted daily buckets from hourly data,
and only then deletes expired raw, hourly, and daily rows. A failure rolls back the
whole run, is logged, and is retried on the next cycle. The service exposes no port
and restarts independently from the API and web services.

## Historical API

`GET /api/v1/devices/:device_id/metrics` accepts optional ISO 8601 `from`, `to`, and
`resolution=raw|hour|day|auto`. The default is the last hour. `auto` selects raw at
up to 6 hours, hourly above 6 hours through 7 days, and daily above 7 days. Total
ranges above 365 days and raw ranges above 7 days return HTTP 400, as do invalid or
reversed timestamps and unsupported resolutions. HTTP 404 is returned for an
unknown device. Results contain typed device points and per-volume disk series.

## Health and downtime

`GET /api/v1/devices/:device_id/monitoring` and
`GET /api/v1/dashboard/health` use the same backend classifier. Status precedence is
Offline, then Unknown, before telemetry classification. For online devices, CPU and
memory use the average of the latest five available samples. Disk uses the latest
legacy highest-volume value. Critical is CPU or memory >=95%, or disk >=95%.
Warning is CPU or memory >=80%, or disk >=85%. With no samples health is Unknown;
otherwise it is Healthy. This creates no alerts or notifications.

Downtime pairs `ONLINE_TO_OFFLINE` with the next `OFFLINE_TO_ONLINE` event. The API
reports the last offline time, last recovery time, last completed duration, and an
ongoing duration only while an unpaired offline event exists. It never invents a
completed recovery. Activity also records `AGENT_ENROLLED` for newly created devices;
heartbeats and metrics do not create activity noise.

## Capacity

At 30 seconds there are 2,880 cycles per endpoint per day. With three disks, each
cycle writes one device row plus three disk rows: 11,520 raw rows/day/endpoint and
80,640 rows over the seven-day raw window.

| Endpoints | Raw rows/day | Raw rows/7 days | Hourly rows/90 days | Daily rows/365 days |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 11,520 | 80,640 | 8,640 | 1,460 |
| 100 | 1,152,000 | 8,064,000 | 864,000 | 146,000 |
| 500 | 5,760,000 | 40,320,000 | 4,320,000 | 730,000 |

Aggregate estimates assume one device plus three volume buckets: 96 hourly rows and
four daily rows per endpoint per day. Actual disk-row volume scales linearly with
the number of reported volumes.
