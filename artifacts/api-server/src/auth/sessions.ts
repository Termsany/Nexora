import crypto from "node:crypto";
import { csrfTokenForSession } from "../security/csrf-token.ts";
export { csrfTokenForSession } from "../security/csrf-token.ts";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, sessionsTable, usersTable } from "@workspace/db";
import type { PrincipalUser } from "../tenancy/policy.ts";

export const SESSION_COOKIE = "nexora_session";

/** Absolute lifetime and independent inactivity bound. Neither is sliding. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** The signed-in user as the tenant layer sees it. */
export type SessionUser = PrincipalUser & { sessionId: string };

/**
 * Issues a session. Only the SHA-256 hash of the token is persisted, so a
 * database disclosure cannot be replayed as a login.
 */
export async function createSession(userId: string, meta: { ipAddress?: string | null; userAgent?: string | null }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessionsTable).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });
  return { token, expiresAt };
}

/**
 * Resolves a raw session token to its user. Returns null for an unknown,
 * expired, revoked or disabled-user session — the caller cannot tell which,
 * and in every case the request is treated as unauthenticated.
 */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      sessionId: sessionsTable.id,
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      scope: usersTable.scope,
      platformRole: usersTable.platformRole,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(and(
      eq(sessionsTable.tokenHash, hashToken(token)),
      isNull(sessionsTable.revokedAt),
      gt(sessionsTable.expiresAt, new Date()),
      gt(sessionsTable.lastUsedAt, new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS)),
      eq(usersTable.status, "ACTIVE"),
    ));
  if (!row) return null;
  // Best-effort activity stamp; never blocks or fails the request.
  void db.update(sessionsTable).set({ lastUsedAt: new Date() })
    .where(eq(sessionsTable.id, row.sessionId))
    .catch(() => undefined);
  return { id: row.id, email: row.email, name: row.name, scope: row.scope, platformRole: row.platformRole, sessionId: row.sessionId };
}

export async function revokeSession(token: string | undefined) {
  if (!token) return;
  await db.update(sessionsTable).set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.tokenHash, hashToken(token)), isNull(sessionsTable.revokedAt)));
}

export async function revokeAllSessionsForUser(userId: string) {
  await db.update(sessionsTable).set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.revokedAt)));
}

/** Drops sessions that expired or were revoked over a day ago. */
export async function pruneSessions() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await db.delete(sessionsTable)
    .where(or(lt(sessionsTable.expiresAt, cutoff), lt(sessionsTable.revokedAt, cutoff)))
    .returning({ id: sessionsTable.id });
  return deleted.length;
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // The pilot terminates TLS at nginx and the API is reached only through it.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export const clearedSessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export { hashToken as hashSessionToken, sql };
