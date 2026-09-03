import { Router, type IRouter } from "express";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogTable, db, devicesTable, organizationsTable, privilegedActionsTable, remoteCommandJobsTable } from "@workspace/db";
import { requirePermission, requireTenantContext } from "../tenancy/context.ts";
import { hasPermission, organizationScope } from "../tenancy/policy.ts";
import { recordAudit } from "../tenancy/audit.ts";

const router: IRouter = Router();

const paging = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) });

router.get("/v1/audit", requireTenantContext, requirePermission("audit.read"), async (req, res): Promise<void> => {
  const context = req.tenant!;
  const parsed = paging.extend({ organization: z.string().uuid().optional(), actor: z.string().optional(), action: z.string().optional(), target_type: z.string().optional(), result: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), search: z.string().max(200).optional() }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid audit query" }); return; }
  const q = parsed.data;
  const scope = organizationScope(context, q.organization);
  if (!scope.ok) { res.status(404).json({ error: "Not found" }); return; }
  const filters = [];
  if (scope.organizationIds) filters.push(scope.organizationIds.length ? inArray(auditLogTable.organizationId, scope.organizationIds) : sql`false`);
  if (q.actor) filters.push(or(ilike(auditLogTable.actorLabel, `%${q.actor}%`), ilike(auditLogTable.actorUserId, `%${q.actor}%`)));
  if (q.action) filters.push(eq(auditLogTable.action, q.action));
  if (q.target_type) filters.push(eq(auditLogTable.targetType, q.target_type));
  if (q.result) filters.push(eq(auditLogTable.result, q.result));
  if (q.from) filters.push(gte(auditLogTable.createdAt, q.from));
  if (q.to) filters.push(lte(auditLogTable.createdAt, q.to));
  if (q.search) filters.push(or(ilike(auditLogTable.action, `%${q.search}%`), ilike(auditLogTable.targetType, `%${q.search}%`), ilike(auditLogTable.targetId, `%${q.search}%`)));
  const where = filters.length ? and(...filters) : undefined;
  const [rows, total] = await Promise.all([
    db.select({ id: auditLogTable.id, occurredAt: auditLogTable.createdAt, actorType: auditLogTable.actorType, actorUserId: auditLogTable.actorUserId, actorLabel: auditLogTable.actorLabel, organizationId: auditLogTable.organizationId, action: auditLogTable.action, targetType: auditLogTable.targetType, targetId: auditLogTable.targetId, result: auditLogTable.result, sourceIp: auditLogTable.ipAddress, userAgent: auditLogTable.userAgent, requestId: auditLogTable.requestId, metadata: auditLogTable.metadata }).from(auditLogTable).where(where).orderBy(desc(auditLogTable.createdAt)).limit(q.page_size).offset((q.page - 1) * q.page_size),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLogTable).where(where),
  ]);
  res.json({ items: rows, page: q.page, page_size: q.page_size, total: total[0]?.count ?? 0 });
});

const actionTypes = ["REMOTE_COMMAND", "REMOTE_POWERSHELL", "SERVICE_START", "SERVICE_STOP", "SERVICE_RESTART", "PROCESS_TERMINATE", "SOFTWARE_INSTALL", "SOFTWARE_UNINSTALL", "PATCH_INSTALL"] as const;
const id = z.string().uuid();

router.post("/v1/privileged-actions", requireTenantContext, requirePermission("privileged_actions.request"), async (req, res): Promise<void> => {
  const context = req.tenant!;
  const parsed = z.object({ device_id: id.optional(), action_type: z.enum(actionTypes), request_reason: z.string().trim().min(1).max(1000), safe_parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}), expires_at: z.coerce.date().optional() }).safeParse(req.body);
  if (!parsed.success || !context.userId) { res.status(400).json({ error: "Invalid privileged action request" }); return; }
  const body = parsed.data;
  let organizationId: string | null = null;
  if (body.device_id) {
    const [device] = await db.select({ id: devicesTable.id, organizationId: devicesTable.organizationId }).from(devicesTable).where(eq(devicesTable.id, body.device_id));
    if (!device || !hasPermission(context, "privileged_actions.request", device.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
    organizationId = device.organizationId;
  } else if (context.platformAccess) {
    res.status(400).json({ error: "device_id is required" }); return;
  } else {
    const organizations = context.organizationIds ?? [];
    if (organizations.length !== 1) { res.status(400).json({ error: "device_id is required for multi-organization users" }); return; }
    organizationId = organizations[0]!;
  }
  const expiresAt = body.expires_at ?? new Date(Date.now() + 15 * 60 * 1000);
  if (expiresAt <= new Date()) { res.status(400).json({ error: "expires_at must be in the future" }); return; }
  const [created] = await db.insert(privilegedActionsTable).values({ organizationId, deviceId: body.device_id ?? null, actionType: body.action_type, requestedBy: context.userId, expiresAt, requestReason: body.request_reason, safeParameters: body.safe_parameters }).returning();
  await recordAudit({ action: "PRIVILEGED_ACTION_REQUESTED", context, organizationId, targetType: "privileged_action", targetId: created!.id, req });
  res.status(201).json(created);
});

router.get("/v1/privileged-actions", requireTenantContext, requirePermission("privileged_actions.request"), async (req, res): Promise<void> => {
  const context = req.tenant!; const parsed = paging.extend({ organization: id.optional() }).safeParse(req.query); if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const scope = organizationScope(context, parsed.data.organization); if (!scope.ok) { res.status(404).json({ error: "Not found" }); return; }
  const where = scope.organizationIds ? (scope.organizationIds.length ? inArray(privilegedActionsTable.organizationId, scope.organizationIds) : sql`false`) : undefined;
  const rows = await db.select().from(privilegedActionsTable).where(where).orderBy(desc(privilegedActionsTable.createdAt)).limit(parsed.data.page_size).offset((parsed.data.page - 1) * parsed.data.page_size);
  res.json({ items: rows, page: parsed.data.page, page_size: parsed.data.page_size });
});

router.get("/v1/privileged-actions/:id", requireTenantContext, requirePermission("privileged_actions.request"), async (req, res): Promise<void> => {
  const parsed = id.safeParse(req.params.id); if (!parsed.success) { res.status(404).json({ error: "Not found" }); return; }
  const context = req.tenant!; const [row] = await db.select().from(privilegedActionsTable).where(eq(privilegedActionsTable.id, parsed.data));
  if (!row || !hasPermission(context, "privileged_actions.request", row.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

async function transition(req: any, res: any, nextStatus: "APPROVED" | "REJECTED" | "CANCELLED") {
  const context = req.tenant!; const parsed = id.safeParse(req.params.id); if (!parsed.success || !context.userId) { res.status(404).json({ error: "Not found" }); return; }
  const [row] = await db.select().from(privilegedActionsTable).where(eq(privilegedActionsTable.id, parsed.data));
  if (!row || !hasPermission(context, nextStatus === "CANCELLED" ? "privileged_actions.request" : "privileged_actions.approve", row.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
  if (row.status !== "PENDING_APPROVAL" || row.expiresAt <= new Date()) { res.status(409).json({ error: "Action is no longer pending" }); return; }
  if (nextStatus === "APPROVED" && row.requiresTwoPerson && row.requestedBy === context.userId) { res.status(403).json({ error: "Requester cannot approve this action" }); return; }
  const values = nextStatus === "APPROVED" ? { status: nextStatus, approvedBy: context.userId, approvedAt: new Date(), updatedAt: new Date() } : nextStatus === "REJECTED" ? { status: nextStatus, rejectedBy: context.userId, rejectedAt: new Date(), updatedAt: new Date() } : { status: nextStatus, updatedAt: new Date() };
  const [updated] = await db.update(privilegedActionsTable).set(values).where(and(eq(privilegedActionsTable.id, row.id), eq(privilegedActionsTable.status, "PENDING_APPROVAL"))).returning();
  if (nextStatus === "APPROVED" && row.actionType === "REMOTE_COMMAND" && updated) {
    const [job] = await db.select().from(remoteCommandJobsTable).where(eq(remoteCommandJobsTable.privilegedActionId, row.id));
    const device = row.deviceId ? (await db.select().from(devicesTable).where(eq(devicesTable.id, row.deviceId)))[0] : null;
    if (job && device && process.env.REMOTE_COMMANDS_ENABLED === "true" && device.remoteCommandsEnabled && Array.isArray(device.capabilities) && device.capabilities.includes("remote_command_v1")) {
      await db.update(remoteCommandJobsTable).set({ status: "READY", readyAt: new Date(), approvedByUserId: context.userId, updatedAt: new Date() }).where(and(eq(remoteCommandJobsTable.id, job.id), eq(remoteCommandJobsTable.status, "PENDING")));
      await recordAudit({ action: "REMOTE_COMMAND_READY", context, organizationId: row.organizationId, targetType: "remote_command", targetId: job.id, req });
    }
  }
  await recordAudit({ action: nextStatus === "APPROVED" ? "PRIVILEGED_ACTION_APPROVED" : nextStatus === "REJECTED" ? "PRIVILEGED_ACTION_REJECTED" : "PRIVILEGED_ACTION_CANCELLED", context, organizationId: row.organizationId, targetType: "privileged_action", targetId: row.id, req });
  res.json(updated);
}

router.post("/v1/privileged-actions/:id/approve", requireTenantContext, requirePermission("privileged_actions.approve"), (req, res) => transition(req, res, "APPROVED"));
router.post("/v1/privileged-actions/:id/reject", requireTenantContext, requirePermission("privileged_actions.approve"), (req, res) => transition(req, res, "REJECTED"));
router.post("/v1/privileged-actions/:id/cancel", requireTenantContext, requirePermission("privileged_actions.request"), (req, res) => transition(req, res, "CANCELLED"));

export default router;
