# Notification Engine V1

Nexora converts meaningful alert lifecycle events into durable notification intents. The alert transaction inserts both `nexora_alert_events` and one `nexora_notifications` row per enabled channel. External delivery never runs in metric ingestion, alert evaluation, or API request handlers.

## Event flow and routing

`CREATED`, `SEVERITY_CHANGED`, and `RESOLVED` map to `ALERT_CREATED`, `ALERT_ESCALATED`, and `ALERT_RESOLVED`. `ACKNOWLEDGED` maps to `ALERT_ACKNOWLEDGED`, but routing is disabled unless `NOTIFY_ACKNOWLEDGED=true`. Warning, critical, and resolved events route to every channel that is both configured and explicitly enabled. Occurrence-count updates create no intent.

Each intent is unique by alert event, channel, and a SHA-256 destination fingerprint. The database stores a safe destination label, a delivery snapshot, and no credentials. A worker restart skips `SENT` rows. Delivery is intentionally at-least-once: a crash after the external service accepts a request but before PostgreSQL records success can cause a retry. Webhook consumers can use `X-Nexora-Delivery` for idempotency.

## Worker and retry model

The `notification-worker` Compose service has no published ports. It claims one eligible row with PostgreSQL `FOR UPDATE SKIP LOCKED`, marks it `PROCESSING`, and assigns a five-minute lease. A crashed worker's expired lease becomes claimable. Claims increment `attempt_count`; successful adapter confirmation moves the row to `SENT`.

Transient network, timeout, HTTP 429/5xx, and SMTP 4xx failures use the following schedule:

1. Initial attempt immediately
2. Retry after 1 minute
3. Retry after 5 minutes
4. Retry after 15 minutes
5. Retry after 60 minutes

After five attempts the row becomes `FAILED`. Clear configuration errors, Telegram/webhook 4xx responses, and SMTP 5xx responses fail immediately. Telegram `retry_after` is honored when longer than the configured delay. Sanitized codes and messages are retained; credentials, URLs containing secrets, response bodies, and stack traces are excluded. `SENT`, `FAILED`, and `CANCELLED` rows older than 90 days are removed daily. Pending work is never removed.

Worker heartbeat is stored in `nexora_worker_heartbeats`. Administration reports it healthy when updated within 30 seconds. Delivery logs contain only notification ID, channel, attempt, duration, and result.

## Server configuration

Create `/home/mustafa/Nexora/.env` from `.env.example`, fill only the required values, and protect it:

```bash
cd /home/mustafa/Nexora
cp .env.example .env
chmod 600 .env
docker compose up -d notification-worker api maintenance
```

Do not commit `.env`. Channel configuration is read-only in the browser and secret values are never returned by the API.

### Telegram

```text
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<secret>
TELEGRAM_CHAT_ID=<chat-id>
```

Create a bot with BotFather, start a chat with it or add it to the target group, determine the target chat ID, configure the server environment, restart the services above, and use Administration > Notifications > Send test. Telegram messages use HTML with all dynamic text escaped. The bot token is used only in the worker's Bot API request.

### Email

```text
EMAIL_ENABLED=true
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=<username>
SMTP_PASSWORD=<secret>
SMTP_FROM=nexora@example.com
SMTP_TO=operations@example.com
```

Port 465 commonly uses `SMTP_SECURE=true`; STARTTLS deployments generally use port 587 and `false`. Certificate verification is always enabled. V1 sends concise plain-text messages.

### Webhook

```text
WEBHOOK_ENABLED=true
WEBHOOK_URL=https://example.com/nexora/events
WEBHOOK_SIGNING_SECRET=<secret>
```

Production webhooks require HTTPS. Localhost, loopback, private, link-local, and metadata-style destinations are blocked after DNS resolution. Redirects are rejected. When a signing secret is configured, the worker sends `X-Nexora-Signature: sha256=<hmac>`, plus `X-Nexora-Event` and `X-Nexora-Delivery`.

## APIs and troubleshooting

- `GET /api/v1/notifications` filters by `state`, `channel`, `event_type`, `alert_id`, and `device_id`, with `page` and `page_size`.
- `GET /api/v1/notifications/:notification_id` returns sanitized delivery detail.
- `GET /api/v1/admin/notification-channels` returns configured/enabled status, safe destination labels, queue totals, and worker health.
- `POST /api/v1/admin/notification-channels/:channel/test` creates a `TEST` queue row and returns `202`; it never bypasses the worker.

All endpoints require the administrative bearer token. For failures, inspect the sanitized code in Administration and worker logs. Confirm the channel is explicitly enabled, the worker heartbeat is current, DNS/TLS connectivity is available, and credentials were updated server-side. Per-organization routing, quiet hours, maintenance windows, suppression, digests, and escalation chains remain future work.
