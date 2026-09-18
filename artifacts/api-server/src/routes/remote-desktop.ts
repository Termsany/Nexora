import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, devicesTable, remoteDesktopSessionsTable } from "@workspace/db";
import { requirePermission, requireTenantContext } from "../tenancy/context.ts";
import { hasPermission } from "../tenancy/policy.ts";
import { findDeviceInScope } from "../tenancy/scope.ts";
import { recordAudit } from "../tenancy/audit.ts";
import { signedAgent } from "./remote-commands.ts";
import { terminateBridge } from "../remote-desktop/gateway.ts";
import {
  claimForAgent, closeSession, createSession, getSession, isExpired, LIVE_STATUSES,
} from "../remote-desktop/sessions.ts";

/**
 * Remote Desktop REST surface.
 *
 * Direct support access is Remote Desktop-specific. A privileged action is
 * retained for audit; generic approval and Remote Command policy are unchanged.
 */

const router: IRouter = Router();
const uuid = z.string().uuid();

/** Capability + readiness for one device, so the UI can explain refusals precisely. */
router.get("/v1/devices/:id/remote-desktop", requireTenantContext, requirePermission("devices.read"), async (req, res): Promise<void> => {
  const parsed = uuid.safeParse(req.params.id);
  if (!parsed.success) { res.status(404).json({ error: "Not found" }); return; }
  const device = await findDeviceInScope(req.tenant!, parsed.data);
  if (!device) { res.status(404).json({ error: "Not found" }); return; }
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities as string[] : [];
  const [live] = await db.select().from(remoteDesktopSessionsTable)
    .where(and(eq(remoteDesktopSessionsTable.deviceId, device.id), inArray(remoteDesktopSessionsTable.status, [...LIVE_STATUSES])))
    .limit(1);
  res.json({
    device_id: device.id,
    remote_desktop_enabled: device.remoteDesktopEnabled,
    agent_supports_remote_desktop: capabilities.includes("remote_desktop_v1"),
    device_status: device.status,
    agent_version: device.agentVersion,
    active_session_id: live?.id ?? null,
  });
});

/** Device-level switch. Default is off and only an authorised user may change it. */
router.patch("/v1/devices/:id/remote-desktop", requireTenantContext, requirePermission("devices.manage"), async (req, res): Promise<void> => {
  const id = uuid.safeParse(req.params.id);
  const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!id.success) { res.status(404).json({ error: "Not found" }); return; }
  if (!body.success) { res.status(400).json({ error: "enabled must be a boolean" }); return; }
  const device = await findDeviceInScope(req.tenant!, id.data);
  if (!device) { res.status(404).json({ error: "Not found" }); return; }
  const previous = device.remoteDesktopEnabled;
  if (previous === body.data.enabled) { res.json({ device_id: device.id, remote_desktop_enabled: previous, changed: false }); return; }
  const [updated] = await db.update(devicesTable)
    .set({ remoteDesktopEnabled: body.data.enabled, updatedAt: new Date() })
    .where(eq(devicesTable.id, device.id)).returning();
  await recordAudit({
    action: body.data.enabled ? "REMOTE_DESKTOP_DEVICE_ENABLED" : "REMOTE_DESKTOP_DEVICE_DISABLED",
    context: req.tenant!, organizationId: device.organizationId,
    targetType: "device", targetId: device.id, req,
    metadata: { hostname: device.hostname, previous_value: previous, new_value: body.data.enabled },
  });
  res.json({ device_id: updated!.id, remote_desktop_enabled: updated!.remoteDesktopEnabled, changed: true });
});

/**
 * Request a session. Returns the viewer token exactly once; it is stored only
 * as a hash and cannot be retrieved again.
 */
router.post("/v1/remote-desktop/sessions", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!context.userId || !hasPermission(context, "remote_desktop.connect")) {
    await recordAudit({ action: "REMOTE_DESKTOP_REQUESTED", context, result: "DENIED", req, metadata: { reason: "permission_denied", authorization_mode: "DIRECT_SUPPORT" } });
    res.status(403).json({ error: "Remote Desktop permission required", code: "permission_denied" }); return;
  }
  const body = z.object({ device_id: uuid, reason: z.string().trim().min(1).max(512) }).strict().safeParse(req.body);
  if (!body.success || !context.userId) { res.status(400).json({ error: "Invalid remote desktop session request" }); return; }

  const device = await findDeviceInScope(context, body.data.device_id);
  if (!device || !hasPermission(context, "remote_desktop.connect", device.organizationId)) {
    await recordAudit({ action: "REMOTE_DESKTOP_REQUESTED", context, result: "DENIED", req, metadata: { reason: "not_found", authorization_mode: "DIRECT_SUPPORT" } });
    res.status(404).json({ error: "Not found" }); return;
  }

  // Refusals are specific so the console can tell the operator what to fix,
  // but each is still gated behind tenant scope above.
  if (!device.remoteDesktopEnabled) {
    await recordAudit({ action: "REMOTE_DESKTOP_REQUESTED", context, organizationId: device.organizationId, targetType: "device", targetId: device.id, result: "DENIED", req, metadata: { reason: "device_disabled" } });
    res.status(409).json({ error: "Remote Desktop is disabled for this device", code: "device_disabled" }); return;
  }
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities as string[] : [];
  if (!capabilities.includes("remote_desktop_v1")) {
    await recordAudit({ action: "REMOTE_DESKTOP_REQUESTED", context, organizationId: device.organizationId, targetType: "device", targetId: device.id, result: "DENIED", req, metadata: { reason: "agent_incapable", authorization_mode: "DIRECT_SUPPORT" } });
    res.status(409).json({ error: "Agent does not support Remote Desktop", code: "agent_incapable" }); return;
  }
  if (device.status !== "ONLINE") {
    await recordAudit({ action: "REMOTE_DESKTOP_REQUESTED", context, organizationId: device.organizationId, targetType: "device", targetId: device.id, result: "DENIED", req, metadata: { reason: "device_offline", authorization_mode: "DIRECT_SUPPORT" } });
    res.status(409).json({ error: "Device is offline", code: "device_offline" }); return;
  }

  const created = await createSession({
    organizationId: device.organizationId, siteId: device.siteId ?? null,
    deviceId: device.id, userId: context.userId, reason: body.data.reason,
  });
  if ("error" in created) {
    await recordAudit({ action: "REMOTE_DESKTOP_REQUESTED", context, organizationId: device.organizationId, targetType: "device", targetId: device.id, result: "DENIED", req, metadata: { reason: "device_busy" } });
    res.status(409).json({ error: "This device already has an active remote session", code: "device_busy" }); return;
  }

  await recordAudit({
    action: "REMOTE_DESKTOP_REQUESTED", context, organizationId: device.organizationId,
    targetType: "remote_desktop_session", targetId: created.session.id, req,
    metadata: { device_id: device.id, privileged_action_id: created.session.privilegedActionId, authorization_mode: "DIRECT_SUPPORT" },
  });
  res.status(201).json({
    session: publicSession(created.session),
    privileged_action_id: created.session.privilegedActionId,
    // Shown once. The console keeps it in memory only.
    viewer_token: created.viewerToken,
  });
});

router.get("/v1/remote-desktop/sessions/:id", requireTenantContext, requirePermission("remote_desktop.connect"), async (req, res): Promise<void> => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { res.status(404).json({ error: "Not found" }); return; }
  const session = await getSession(id.data);
  if (!session || !hasPermission(req.tenant!, "remote_desktop.connect", session.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ session: publicSession(session) });
});

router.post("/v1/remote-desktop/sessions/:id/terminate", requireTenantContext, requirePermission("remote_desktop.connect"), async (req, res): Promise<void> => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { res.status(404).json({ error: "Not found" }); return; }
  const session = await getSession(id.data);
  if (!session || !hasPermission(req.tenant!, "remote_desktop.connect", session.organizationId)) { res.status(404).json({ error: "Not found" }); return; }
  const closed = await closeSession(session.id, "CLOSED", "terminated_by_user");
  terminateBridge(session.id, "terminated_by_user");
  if (closed) {
    await recordAudit({
      action: "REMOTE_DESKTOP_TERMINATED", context: req.tenant!, organizationId: session.organizationId,
      targetType: "remote_desktop_session", targetId: session.id, req, metadata: { device_id: session.deviceId },
    });
  }
  res.json({ session: publicSession(closed ?? session) });
});

/**
 * Agent claim. Signed exactly like every other privileged agent endpoint, and
 * the only way an Agent learns a channel token.
 */
router.post("/v1/agent/remote-desktop/claim", async (req, res): Promise<void> => {
  const device = await signedAgent(req, res);
  if (!device) return;
  if (!device.remoteDesktopEnabled) { res.status(204).end(); return; }
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities as string[] : [];
  if (!capabilities.includes("remote_desktop_v1")) { res.status(204).end(); return; }

  const claimed = await claimForAgent(device.id);
  if (!claimed) { res.status(204).end(); return; }
  await recordAudit({
    action: "REMOTE_DESKTOP_AUTHORIZED", actorLabel: `agent:${device.agentId}`,
    organizationId: device.organizationId, targetType: "remote_desktop_session", targetId: claimed.session.id, req,
  });
  res.json({
    session_id: claimed.session.id,
    // Single use. Minting replaces any hash handed out before it.
    channel_token: claimed.agentToken,
    channel_path: `/api/v1/agent/remote-desktop/${claimed.session.id}/channel`,
    expires_at: claimed.session.expiresAt.toISOString(),
  });
});

/** Never exposes either token hash. */
function publicSession(session: Awaited<ReturnType<typeof getSession>> & object) {
  return {
    id: session.id,
    device_id: session.deviceId,
    organization_id: session.organizationId,
    site_id: session.siteId,
    status: session.status,
    expires_at: session.expiresAt.toISOString(),
    expired: isExpired(session),
    created_at: session.createdAt.toISOString(),
    started_at: session.startedAt?.toISOString() ?? null,
    closed_at: session.closedAt?.toISOString() ?? null,
    close_reason: session.closeReason,
    screen_width: session.screenWidth,
    screen_height: session.screenHeight,
    frames_sent: session.framesSent,
    clipboard_enabled: session.clipboardEnabled,
  };
}

export default router;
