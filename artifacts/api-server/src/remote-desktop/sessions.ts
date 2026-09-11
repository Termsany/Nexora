import crypto from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db, devicesTable, privilegedActionsTable, remoteDesktopSessionsTable } from "@workspace/db";

/**
 * Remote Desktop session lifecycle.
 *
 * Every transition that matters is a conditional UPDATE guarded by the status
 * it expects, so two racing callers cannot both win. Expiry is evaluated
 * server-side on every touch; nothing trusts a timer.
 */

export const SESSION_TTL_MS = 30 * 60 * 1000;
/** No traffic for this long and the session is reaped even if sockets linger. */
export const SESSION_IDLE_MS = 5 * 60 * 1000;

export const LIVE_STATUSES = ["REQUESTED", "AUTHORIZED", "CONNECTING", "CONNECTED", "ACTIVE", "DISCONNECTING"] as const;
export const TERMINAL_STATUSES = ["CLOSED", "EXPIRED", "FAILED"] as const;

export type SessionRow = typeof remoteDesktopSessionsTable.$inferSelect;

/** 256 bits from the CSPRNG. Compared only as a hash, in constant time. */
export function mintToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function tokenMatches(raw: string, expected: string | null): boolean {
  if (!expected) return false;
  const a = Buffer.from(hashToken(raw), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isExpired(session: Pick<SessionRow, "expiresAt">): boolean {
  return session.expiresAt.getTime() <= Date.now();
}

/**
 * Create the approval record and its session together. The unique partial
 * index on device_id rejects a second live session at the database level, so
 * the concurrency policy cannot be lost to a race between two requests.
 */
export async function createSession(input: {
  organizationId: string;
  siteId: string | null;
  deviceId: string;
  userId: string;
  reason: string;
}): Promise<{ session: SessionRow; viewerToken: string } | { error: "device_busy" }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const viewer = mintToken();
  try {
    return await db.transaction(async (tx) => {
      const [action] = await tx.insert(privilegedActionsTable).values({
        organizationId: input.organizationId,
        deviceId: input.deviceId,
        actionType: "REMOTE_DESKTOP",
        requestedBy: input.userId,
        expiresAt,
        requestReason: input.reason,
        safeParameters: { capability: "remote_desktop_v1" },
      }).returning();
      const [session] = await tx.insert(remoteDesktopSessionsTable).values({
        organizationId: input.organizationId,
        siteId: input.siteId,
        deviceId: input.deviceId,
        privilegedActionId: action!.id,
        requestedByUserId: input.userId,
        viewerTokenHash: viewer.hash,
        expiresAt,
      }).returning();
      return { session: session!, viewerToken: viewer.raw };
    });
  } catch (error) {
    // 23505 is the one-live-session-per-device index doing its job.
    if ((error as { code?: string }).code === "23505") return { error: "device_busy" };
    throw error;
  }
}

/** Promote a session once its privileged action is approved. */
export async function authorizeSession(sessionId: string, approvedByUserId: string): Promise<SessionRow | null> {
  const [row] = await db.update(remoteDesktopSessionsTable)
    .set({ status: "AUTHORIZED", authorizedAt: new Date(), approvedByUserId, updatedAt: new Date() })
    .where(and(
      eq(remoteDesktopSessionsTable.id, sessionId),
      eq(remoteDesktopSessionsTable.status, "REQUESTED"),
      sql`${remoteDesktopSessionsTable.expiresAt} > now()`,
    ))
    .returning();
  return row ?? null;
}

/**
 * Hand the Agent a single-use channel token. Only an AUTHORIZED session yields
 * one, and minting replaces any previous hash so a re-claim invalidates the
 * token handed out before it.
 */
export async function claimForAgent(deviceId: string): Promise<{ session: SessionRow; agentToken: string } | null> {
  const [pending] = await db.select().from(remoteDesktopSessionsTable)
    .where(and(
      eq(remoteDesktopSessionsTable.deviceId, deviceId),
      eq(remoteDesktopSessionsTable.status, "AUTHORIZED"),
      sql`${remoteDesktopSessionsTable.expiresAt} > now()`,
    ))
    .orderBy(remoteDesktopSessionsTable.createdAt)
    .limit(1);
  if (!pending) return null;
  const agent = mintToken();
  const [row] = await db.update(remoteDesktopSessionsTable)
    .set({ status: "CONNECTING", agentTokenHash: agent.hash, updatedAt: new Date() })
    .where(and(eq(remoteDesktopSessionsTable.id, pending.id), eq(remoteDesktopSessionsTable.status, "AUTHORIZED")))
    .returning();
  return row ? { session: row, agentToken: agent.raw } : null;
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(remoteDesktopSessionsTable).where(eq(remoteDesktopSessionsTable.id, sessionId));
  return row ?? null;
}

export async function markViewerConnected(sessionId: string): Promise<void> {
  await db.update(remoteDesktopSessionsTable)
    .set({ viewerConnectedAt: new Date(), lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(remoteDesktopSessionsTable.id, sessionId));
}

export async function markAgentConnected(sessionId: string): Promise<void> {
  await db.update(remoteDesktopSessionsTable)
    .set({ status: "CONNECTED", agentConnectedAt: new Date(), lastActivityAt: new Date(), updatedAt: new Date() })
    .where(and(eq(remoteDesktopSessionsTable.id, sessionId), inArray(remoteDesktopSessionsTable.status, ["CONNECTING", "AUTHORIZED"])));
}

/** Both ends present and frames flowing. */
export async function markActive(sessionId: string, screen: { width: number; height: number }): Promise<void> {
  await db.update(remoteDesktopSessionsTable)
    .set({ status: "ACTIVE", startedAt: sql`coalesce(${remoteDesktopSessionsTable.startedAt}, now())`, screenWidth: screen.width, screenHeight: screen.height, lastActivityAt: new Date(), updatedAt: new Date() })
    .where(and(eq(remoteDesktopSessionsTable.id, sessionId), inArray(remoteDesktopSessionsTable.status, ["CONNECTED", "CONNECTING", "ACTIVE"])));
}

export async function touch(sessionId: string, counters?: { frames?: number; inputs?: number }): Promise<void> {
  await db.update(remoteDesktopSessionsTable).set({
    lastActivityAt: new Date(),
    ...(counters?.frames ? { framesSent: sql`${remoteDesktopSessionsTable.framesSent} + ${counters.frames}` } : {}),
    ...(counters?.inputs ? { inputEventsSent: sql`${remoteDesktopSessionsTable.inputEventsSent} + ${counters.inputs}` } : {}),
  }).where(eq(remoteDesktopSessionsTable.id, sessionId));
}

/**
 * Terminal transition. Clears the agent token hash so a terminated session's
 * token can never be replayed, and is a no-op on an already-closed session.
 */
export async function closeSession(sessionId: string, status: "CLOSED" | "EXPIRED" | "FAILED", reason: string): Promise<SessionRow | null> {
  const [row] = await db.update(remoteDesktopSessionsTable)
    .set({ status, closedAt: new Date(), closeReason: reason.slice(0, 64), agentTokenHash: null, updatedAt: new Date() })
    .where(and(eq(remoteDesktopSessionsTable.id, sessionId), inArray(remoteDesktopSessionsTable.status, [...LIVE_STATUSES])))
    .returning();
  return row ?? null;
}

/**
 * Sweep sessions the gateway can no longer be trusted to close: past their
 * deadline, or silent past the idle budget. Also the reason a server restart
 * cannot leave a session live forever.
 */
export async function expireStaleSessions(): Promise<SessionRow[]> {
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_MS);
  return db.update(remoteDesktopSessionsTable)
    .set({ status: "EXPIRED", closedAt: new Date(), closeReason: "expired", agentTokenHash: null, updatedAt: new Date() })
    .where(and(
      inArray(remoteDesktopSessionsTable.status, [...LIVE_STATUSES]),
      sql`(${remoteDesktopSessionsTable.expiresAt} <= now() or coalesce(${remoteDesktopSessionsTable.lastActivityAt}, ${remoteDesktopSessionsTable.createdAt}) < ${idleCutoff})`,
    ))
    .returning();
}

/** Device must exist, be in scope, and have the capability switched on. */
export async function deviceRemoteDesktopState(deviceId: string): Promise<{ enabled: boolean; capable: boolean; online: boolean } | null> {
  const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId));
  if (!device) return null;
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities as string[] : [];
  return {
    enabled: device.remoteDesktopEnabled,
    capable: capabilities.includes("remote_desktop_v1"),
    online: device.status === "ONLINE",
  };
}

export async function countStale(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(remoteDesktopSessionsTable)
    .where(and(inArray(remoteDesktopSessionsTable.status, [...LIVE_STATUSES]), lt(remoteDesktopSessionsTable.expiresAt, new Date())));
  return row?.n ?? 0;
}
