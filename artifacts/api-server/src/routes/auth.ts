import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, organizationMembershipsTable, organizationsTable, sessionsTable, usersTable } from "@workspace/db";
import { fakeVerify, verifyPassword } from "../auth/password.ts";
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  createSession,
  csrfTokenForSession,
  revokeSession,
  sessionCookieOptions,
} from "../auth/sessions.ts";
import { requirePermission, requireTenantContext } from "../tenancy/context.ts";
import { recordAudit } from "../tenancy/audit.ts";
import { CSRF_COOKIE } from "../security/csrf.ts";
import { checkLoginRate } from "../security/rate-limit.ts";

const router: IRouter = Router();

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(400),
});

router.post("/v1/auth/login", async (req, res): Promise<void> => {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Email and password are required" }); return; }

  const retryAfter = checkLoginRate(req.ip ?? "unknown", parsed.data.email);
  if (retryAfter) {
    res.setHeader("Retry-After", String(retryAfter));
    await recordAudit({ action: "LOGIN_RATE_LIMITED", actorLabel: parsed.data.email, req, result: "DENIED" });
    res.status(429).json({ error: "Too many login attempts. Try again later." }); return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, parsed.data.email));

  // The same rejection for unknown email, wrong password and disabled account,
  // with comparable timing, so login cannot be used to enumerate accounts.
  if (!user || user.status !== "ACTIVE") {
    await fakeVerify();
    await recordAudit({ action: "LOGIN_FAILED", actorLabel: parsed.data.email, req, result: "DENIED", metadata: { reason: "invalid_credentials" } });
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  if (!await verifyPassword(parsed.data.password, user.passwordHash)) {
    await recordAudit({ action: "LOGIN_FAILED", actorLabel: parsed.data.email, targetType: "user", targetId: user.id, req, result: "DENIED", metadata: { reason: "invalid_credentials" } });
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const { token, expiresAt } = await createSession(user.id, {
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
  await recordAudit({ action: "LOGIN_SUCCESS", actorLabel: user.email, targetType: "user", targetId: user.id, req });

  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
  const csrfToken = csrfTokenForSession(token);
  res.cookie(CSRF_COOKIE, csrfToken, { secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", expires: expiresAt });
  res.status(200).json({
    id: user.id,
    email: user.email,
    name: user.name,
    scope: user.scope,
    platform_role: user.platformRole,
    csrf_token: csrfToken,
  });
});

router.post("/v1/auth/logout", async (req, res): Promise<void> => {
  const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies;
  await revokeSession(cookies?.[SESSION_COOKIE]);
  if (req.tenant?.userId) {
    await recordAudit({ action: "LOGOUT", context: req.tenant, targetType: "user", targetId: req.tenant.userId, req });
  }
  res.clearCookie(SESSION_COOKIE, clearedSessionCookieOptions);
  res.clearCookie(CSRF_COOKIE, { secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
  res.sendStatus(204);
});

/**
 * Identity and effective scope for the signed-in principal. The frontend uses
 * this to shape navigation; it is a convenience, never the security boundary —
 * every route enforces its own authorization independently (§AO).
 */
router.get("/v1/auth/me", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;

  const organizations = context.platformAccess
    ? await db.select({ id: organizationsTable.id, name: organizationsTable.name, slug: organizationsTable.slug, status: organizationsTable.status })
        .from(organizationsTable).where(eq(organizationsTable.status, "ACTIVE")).orderBy(organizationsTable.name)
    : await db.select({ id: organizationsTable.id, name: organizationsTable.name, slug: organizationsTable.slug, status: organizationsTable.status })
        .from(organizationMembershipsTable)
        .innerJoin(organizationsTable, eq(organizationMembershipsTable.organizationId, organizationsTable.id))
        .where(eq(organizationMembershipsTable.userId, context.userId!))
        .orderBy(organizationsTable.name);

  res.json({
    authenticated: true,
    principal_kind: context.principal.kind,
    user: context.principal.kind === "user"
      ? {
          id: context.principal.user.id,
          email: context.principal.user.email,
          name: context.principal.user.name,
          scope: context.principal.user.scope,
          platform_role: context.principal.user.platformRole,
        }
      : null,
    platform_access: context.platformAccess,
    organizations: organizations
      .filter((organization) => context.platformAccess || organization.status === "ACTIVE")
      .map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
        role: context.memberships.get(organization.id) ?? null,
      })),
  });
});

router.get("/v1/auth/sessions", requireTenantContext, requirePermission("security.sessions.read"), async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!context.userId) { res.status(403).json({ error: "User session required" }); return; }
  const rows = await db.select({ id: sessionsTable.id, createdAt: sessionsTable.createdAt, lastSeenAt: sessionsTable.lastUsedAt, expiresAt: sessionsTable.expiresAt, ipAddress: sessionsTable.ipAddress, userAgent: sessionsTable.userAgent })
    .from(sessionsTable).where(and(eq(sessionsTable.userId, context.userId), isNull(sessionsTable.revokedAt))).orderBy(sessionsTable.createdAt);
  res.json({ items: rows.map((row) => ({ id: row.id, created_at: row.createdAt, last_seen_at: row.lastSeenAt, expires_at: row.expiresAt, ip_address: row.ipAddress, user_agent: row.userAgent, current_session: row.id === context.sessionId })) });
});

router.delete("/v1/auth/sessions/:session_id", requireTenantContext, requirePermission("security.sessions.revoke"), async (req, res): Promise<void> => {
  const context = req.tenant!;
  const sessionId = z.string().uuid().safeParse(req.params.session_id);
  if (!sessionId.success || !context.userId) { res.status(404).json({ error: "Session not found" }); return; }
  const [revoked] = await db.update(sessionsTable).set({ revokedAt: new Date() }).where(and(eq(sessionsTable.id, sessionId.data), eq(sessionsTable.userId, context.userId), isNull(sessionsTable.revokedAt))).returning({ id: sessionsTable.id });
  if (!revoked) { res.status(404).json({ error: "Session not found" }); return; }
  await recordAudit({ action: "SESSION_REVOKED", context, targetType: "session", targetId: revoked.id, req });
  res.sendStatus(204);
});

export default router;
