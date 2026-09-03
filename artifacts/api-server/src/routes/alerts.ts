import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { alertEventsTable, alertsTable, db, devicesTable, organizationsTable } from "@workspace/db";
import { recordAlertEvent } from "../notifications/outbox.ts";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { organizationScope, tenantCondition } from "../tenancy/scope.ts";
import { actorName } from "../tenancy/audit.ts";

const router: IRouter = Router();
const states = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
const severities = ["warning", "critical"] as const;
const types = ["DEVICE_OFFLINE", "CPU_HIGH", "MEMORY_HIGH", "DISK_HIGH"] as const;

router.use("/v1/alerts", requireTenantContext);
router.use("/v1/dashboard/alerts", requireTenantContext);

const listQuery = z.object({
  state: z.enum(states).optional(), severity: z.enum(severities).optional(), type: z.enum(types).optional(),
  device_id: z.string().uuid().optional(), organization_id: z.string().uuid().optional(),
  active: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25),
}).refine((value) => !(value.active && value.state), "active and state cannot be combined");

function publicAlert(alert: typeof alertsTable.$inferSelect, hostname: string, organizationName?: string | null) {
  return {
    id: alert.id, organization_id: alert.organizationId, organization_name: organizationName ?? null,
    device_id: alert.deviceId, device: { id: alert.deviceId, hostname },
    type: alert.type, severity: alert.severity, state: alert.state, resource: alert.resource, title: alert.title, summary: alert.summary,
    opened_at: alert.openedAt, last_triggered_at: alert.lastTriggeredAt, acknowledged_at: alert.acknowledgedAt,
    resolved_at: alert.resolvedAt, acknowledged_by: alert.acknowledgedBy, trigger_value: alert.triggerValue,
    threshold_value: alert.thresholdValue, occurrence_count: alert.occurrenceCount, created_at: alert.createdAt, updated_at: alert.updatedAt,
  };
}

router.get("/v1/alerts", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "alert:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const query = parsed.data;

  const scope = organizationScope(context, query.organization_id);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  // The tenant predicate is applied to the same WHERE clause used by both the
  // page and the total, so filtering happens before LIMIT/OFFSET (§AJ) and the
  // total cannot count another tenant's alerts (§AH).
  const filters: SQL[] = [];
  const tenant = tenantCondition(alertsTable.organizationId, scope.organizationIds);
  if (tenant) filters.push(tenant);
  if (query.active) filters.push(inArray(alertsTable.state, ["OPEN", "ACKNOWLEDGED"]));
  if (query.state) filters.push(eq(alertsTable.state, query.state));
  if (query.severity) filters.push(eq(alertsTable.severity, query.severity));
  if (query.type) filters.push(eq(alertsTable.type, query.type));
  if (query.device_id) filters.push(eq(alertsTable.deviceId, query.device_id));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, totalRows] = await Promise.all([
    db.select({ alert: alertsTable, hostname: devicesTable.hostname, organizationName: organizationsTable.name })
      .from(alertsTable)
      .innerJoin(devicesTable, eq(alertsTable.deviceId, devicesTable.id))
      .innerJoin(organizationsTable, eq(alertsTable.organizationId, organizationsTable.id))
      .where(where).orderBy(desc(alertsTable.lastTriggeredAt)).limit(query.page_size).offset((query.page - 1) * query.page_size),
    db.select({ total: count() }).from(alertsTable).where(where),
  ]);
  res.json({
    items: rows.map(({ alert, hostname, organizationName }) => publicAlert(alert, hostname, organizationName)),
    page: query.page, page_size: query.page_size, total: totalRows[0]?.total ?? 0,
  });
});

router.get("/v1/alerts/:alert_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "alert:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const id = z.string().uuid().safeParse(req.params.alert_id);
  if (!id.success) { res.status(400).json({ error: "Invalid alert ID" }); return; }
  const scope = organizationScope(context);
  if (!scope.ok) { res.status(404).json({ error: "Alert not found" }); return; }
  const tenant = tenantCondition(alertsTable.organizationId, scope.organizationIds);

  const [row] = await db.select({ alert: alertsTable, hostname: devicesTable.hostname, lastSeenAt: devicesTable.lastSeenAt, organizationName: organizationsTable.name })
    .from(alertsTable)
    .innerJoin(devicesTable, eq(alertsTable.deviceId, devicesTable.id))
    .innerJoin(organizationsTable, eq(alertsTable.organizationId, organizationsTable.id))
    .where(tenant ? and(eq(alertsTable.id, id.data), tenant) : eq(alertsTable.id, id.data));
  // 404 rather than 403: an alert belonging to another tenant must not be
  // distinguishable from one that does not exist (§M).
  if (!row) { res.status(404).json({ error: "Alert not found" }); return; }

  const events = await db.select().from(alertEventsTable).where(eq(alertEventsTable.alertId, id.data)).orderBy(asc(alertEventsTable.timestamp));
  res.json({
    ...publicAlert(row.alert, row.hostname, row.organizationName),
    device: { id: row.alert.deviceId, hostname: row.hostname, last_seen_at: row.lastSeenAt },
    events: events.map((event) => ({ id: event.id, event_type: event.eventType, previous_state: event.previousState, new_state: event.newState, previous_severity: event.previousSeverity, new_severity: event.newSeverity, actor: event.actor, timestamp: event.timestamp, metadata: event.metadata })),
  });
});

router.post("/v1/alerts/:alert_id/acknowledge", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = z.string().uuid().safeParse(req.params.alert_id);
  if (!id.success) { res.status(400).json({ error: "Invalid alert ID" }); return; }
  const scope = organizationScope(context);
  if (!scope.ok) { res.status(404).json({ error: "Alert not found" }); return; }
  const tenant = tenantCondition(alertsTable.organizationId, scope.organizationIds);

  const actor = actorName(context);
  const result = await db.transaction(async (tx) => {
    // The tenant predicate is inside the transaction's own lookup, so an alert
    // ID belonging to another organization can never be acknowledged (§O).
    const [row] = await tx.select({ alert: alertsTable, device: devicesTable })
      .from(alertsTable).innerJoin(devicesTable, eq(alertsTable.deviceId, devicesTable.id))
      .where(tenant ? and(eq(alertsTable.id, id.data), tenant) : eq(alertsTable.id, id.data));
    const alert = row?.alert;
    if (!alert) return { status: 404 as const };
    if (!can(context, "alert:acknowledge", alert.organizationId)) return { status: 403 as const };
    if (alert.state === "RESOLVED") return { status: 409 as const };
    if (alert.state === "ACKNOWLEDGED") return { status: 200 as const, alert };
    const now = new Date();
    const [updated] = await tx.update(alertsTable)
      .set({ state: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedBy: actor, updatedAt: now })
      .where(and(eq(alertsTable.id, alert.id), eq(alertsTable.state, "OPEN"))).returning();
    if (updated) await recordAlertEvent(tx, { alertId: updated.id, eventType: "ACKNOWLEDGED", previousState: "OPEN", newState: "ACKNOWLEDGED", actor }, updated, row!.device);
    return { status: 200 as const, alert: updated ?? alert };
  });
  if (result.status === 404) { res.status(404).json({ error: "Alert not found" }); return; }
  if (result.status === 403) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  if (result.status === 409) { res.status(409).json({ error: "Resolved alerts cannot be acknowledged" }); return; }
  const [device] = await db.select({ hostname: devicesTable.hostname }).from(devicesTable).where(eq(devicesTable.id, result.alert.deviceId));
  res.json(publicAlert(result.alert, device?.hostname ?? "Unknown device"));
});

router.get("/v1/dashboard/alerts", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "alert:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const requested = typeof req.query.organization_id === "string" ? req.query.organization_id : undefined;
  const scope = organizationScope(context, requested);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const filters: SQL[] = [inArray(alertsTable.state, ["OPEN", "ACKNOWLEDGED"])];
  const tenant = tenantCondition(alertsTable.organizationId, scope.organizationIds);
  if (tenant) filters.push(tenant);
  const activeWhere = and(...filters);

  const [rows, summary] = await Promise.all([
    db.select({ alert: alertsTable, hostname: devicesTable.hostname })
      .from(alertsTable).innerJoin(devicesTable, eq(alertsTable.deviceId, devicesTable.id))
      .where(activeWhere).orderBy(desc(alertsTable.lastTriggeredAt)).limit(5),
    db.select({
      active: count(),
      critical: sql<number>`count(*) filter (where ${alertsTable.severity} = 'critical')`,
      warning: sql<number>`count(*) filter (where ${alertsTable.severity} = 'warning')`,
    }).from(alertsTable).where(activeWhere),
  ]);
  res.json({
    active_alerts: summary[0]?.active ?? 0,
    critical_alerts: Number(summary[0]?.critical ?? 0),
    warning_alerts: Number(summary[0]?.warning ?? 0),
    recent: rows.map(({ alert, hostname }) => publicAlert(alert, hostname)),
  });
});

export default router;
