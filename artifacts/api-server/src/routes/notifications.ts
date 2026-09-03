import { Router, type IRouter } from "express";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { alertsTable, db, devicesTable, notificationsTable, workerHeartbeatsTable } from "@workspace/db";
import { channelStatuses } from "../notifications/config.ts";
import { enqueueTestNotification } from "../notifications/outbox.ts";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { organizationScope, tenantCondition } from "../tenancy/scope.ts";

const router: IRouter = Router();
const states = ["PENDING", "PROCESSING", "SENT", "RETRY", "FAILED", "CANCELLED"] as const;
const channels = ["telegram", "email", "webhook"] as const;
const events = ["ALERT_CREATED", "ALERT_ESCALATED", "ALERT_ACKNOWLEDGED", "ALERT_RESOLVED", "TEST"] as const;

router.use("/v1/notifications", requireTenantContext);
router.use("/v1/admin/notification-channels", requireTenantContext);

const listQuery = z.object({
  state: z.enum(states).optional(), channel: z.enum(channels).optional(), event_type: z.enum(events).optional(),
  alert_id: z.string().uuid().optional(), device_id: z.string().uuid().optional(), organization_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25),
});

function publicNotification(row: { notification: typeof notificationsTable.$inferSelect; hostname: string | null }) {
  const n = row.notification;
  return {
    id: n.id, organization_id: n.organizationId, alert_id: n.alertId, alert_event_id: n.alertEventId,
    channel: n.channel, destination: n.destination, event_type: n.eventType, severity: n.severity, state: n.state,
    attempt_count: n.attemptCount, max_attempts: n.maxAttempts, next_attempt_at: n.nextAttemptAt,
    last_attempt_at: n.lastAttemptAt, sent_at: n.sentAt, failed_at: n.failedAt,
    last_error_code: n.lastErrorCode, last_error_message: n.lastErrorMessage,
    created_at: n.createdAt, updated_at: n.updatedAt,
    device: n.alertId ? { hostname: row.hostname } : null,
  };
}

/**
 * Delivery history, scoped to the caller's organizations.
 *
 * Notifications with no organization are platform-level deliveries — currently
 * only the channel test — and are visible to platform principals alone, never
 * to a tenant.
 */
router.get("/v1/notifications", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "notification:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const query = parsed.data;
  const scope = organizationScope(context, query.organization_id);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const filters: SQL[] = [];
  const tenant = tenantCondition(notificationsTable.organizationId, scope.organizationIds);
  if (tenant) filters.push(tenant);
  if (query.state) filters.push(eq(notificationsTable.state, query.state));
  if (query.channel) filters.push(eq(notificationsTable.channel, query.channel));
  if (query.event_type) filters.push(eq(notificationsTable.eventType, query.event_type));
  if (query.alert_id) filters.push(eq(notificationsTable.alertId, query.alert_id));
  if (query.device_id) filters.push(eq(alertsTable.deviceId, query.device_id));
  const where = filters.length ? and(...filters) : undefined;

  const base = db.select({ notification: notificationsTable, hostname: devicesTable.hostname })
    .from(notificationsTable)
    .leftJoin(alertsTable, eq(notificationsTable.alertId, alertsTable.id))
    .leftJoin(devicesTable, eq(alertsTable.deviceId, devicesTable.id));
  const [rows, totals] = await Promise.all([
    base.where(where).orderBy(desc(notificationsTable.createdAt)).limit(query.page_size).offset((query.page - 1) * query.page_size),
    db.select({ total: count() }).from(notificationsTable)
      .leftJoin(alertsTable, eq(notificationsTable.alertId, alertsTable.id)).where(where),
  ]);
  res.json({ items: rows.map(publicNotification), page: query.page, page_size: query.page_size, total: totals[0]?.total ?? 0 });
});

router.get("/v1/notifications/:notification_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "notification:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const id = z.string().uuid().safeParse(req.params.notification_id);
  if (!id.success) { res.status(400).json({ error: "Invalid notification ID" }); return; }
  const scope = organizationScope(context);
  if (!scope.ok) { res.status(404).json({ error: "Notification not found" }); return; }
  const tenant = tenantCondition(notificationsTable.organizationId, scope.organizationIds);

  const [row] = await db.select({ notification: notificationsTable, hostname: devicesTable.hostname })
    .from(notificationsTable)
    .leftJoin(alertsTable, eq(notificationsTable.alertId, alertsTable.id))
    .leftJoin(devicesTable, eq(alertsTable.deviceId, devicesTable.id))
    .where(tenant ? and(eq(notificationsTable.id, id.data), tenant) : eq(notificationsTable.id, id.data));
  if (!row) { res.status(404).json({ error: "Notification not found" }); return; }
  res.json(publicNotification(row));
});

/**
 * Notification channels are platform-global in this release: their destinations
 * come from server environment configuration and are shared by every tenant.
 * Both endpoints below are therefore restricted to platform principals, and
 * per-organization channel configuration is deferred (documented in
 * docs/multi-tenancy.md).
 */
router.get("/v1/admin/notification-channels", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!context.platformAccess || !can(context, "notification:manage")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const [heartbeat, queue] = await Promise.all([
    db.select().from(workerHeartbeatsTable).where(eq(workerHeartbeatsTable.worker, "notification-worker")),
    db.select({
      pending: sql<number>`count(*) filter (where ${notificationsTable.state} in ('PENDING','RETRY','PROCESSING'))`,
      failed: sql<number>`count(*) filter (where ${notificationsTable.state} = 'FAILED')`,
    }).from(notificationsTable),
  ]);
  const lastSeen = heartbeat[0]?.lastSeenAt ?? null;
  res.json({
    channels: channelStatuses(),
    worker: { healthy: Boolean(lastSeen && Date.now() - lastSeen.getTime() < 30_000), last_seen_at: lastSeen },
    queue: { pending: Number(queue[0]?.pending ?? 0), failed: Number(queue[0]?.failed ?? 0) },
  });
});

router.post("/v1/admin/notification-channels/:channel/test", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!context.platformAccess || !can(context, "notification:manage")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const channel = z.enum(channels).safeParse(req.params.channel);
  if (!channel.success) { res.status(400).json({ error: "Invalid notification channel" }); return; }
  const created = await enqueueTestNotification(channel.data);
  if (!created) { res.status(409).json({ error: "Channel is not enabled and configured" }); return; }
  res.status(202).json({ id: created.id, state: created.state, channel: created.channel });
});

export default router;
