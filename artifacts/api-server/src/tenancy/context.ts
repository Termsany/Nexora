import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, organizationMembershipsTable, organizationsTable } from "@workspace/db";
import { SESSION_COOKIE, resolveSession } from "../auth/sessions.ts";
import { can, hasPermission, type Capability, type Permission, type Principal, type TenantContext } from "./policy.ts";

export { can } from "./policy.ts";
export type {
  Capability,
  OrganizationRole,
  PlatformRole,
  Principal,
  PrincipalUser,
  TenantContext,
} from "./policy.ts";

function administrativeTokenMatches(req: Request) {
  const configured = process.env.ADMIN_API_TOKEN;
  if (!configured) return false;
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied) return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(configured);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function loadMemberships(userId: string) {
  const rows = await db
    .select({ organizationId: organizationMembershipsTable.organizationId, role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable)
    .innerJoin(organizationsTable, eq(organizationMembershipsTable.organizationId, organizationsTable.id))
    // A membership in a suspended or archived organization grants nothing to an
    // organization user (§AL); platform staff keep visibility through their own
    // platform access rather than through membership.
    .where(and(eq(organizationMembershipsTable.userId, userId), eq(organizationsTable.status, "ACTIVE")));
  return new Map(rows.map((row) => [row.organizationId, row.role]));
}

export async function buildTenantContext(principal: Principal): Promise<TenantContext> {
  if (principal.kind === "platform-api") {
    return {
      principal,
      platformAccess: true,
      organizationIds: null,
      platformRole: "PLATFORM_SUPER_ADMIN",
      memberships: new Map(),
      userId: null,
      sessionId: null,
    };
  }
  const { user } = principal;
  if (user.scope === "PLATFORM") {
    return {
      principal,
      platformAccess: true,
      organizationIds: null,
      platformRole: user.platformRole,
      memberships: new Map(),
      userId: user.id,
      sessionId: "sessionId" in user && typeof user.sessionId === "string" ? user.sessionId : null,
    };
  }
  const memberships = await loadMemberships(user.id);
  return {
    principal,
    platformAccess: false,
    organizationIds: [...memberships.keys()],
    platformRole: null,
    memberships,
    userId: user.id,
    sessionId: "sessionId" in user && typeof user.sessionId === "string" ? user.sessionId : null,
  };
}

/**
 * Attaches a tenant context when the request carries a valid credential.
 * Requests without one are left anonymous; `requireTenantContext` is what
 * actually refuses them, so that unauthenticated and unauthorized share a
 * single, consistent rejection path.
 */
export async function attachTenantContext(req: Request, _res: Response, next: NextFunction) {
  try {
    if (administrativeTokenMatches(req)) {
      req.tenant = await buildTenantContext({ kind: "platform-api" });
      return next();
    }
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const user = await resolveSession(cookies?.[SESSION_COOKIE]);
    if (user) req.tenant = await buildTenantContext({ kind: "user", user });
    next();
  } catch (error) {
    next(error);
  }
}

export function requireTenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) { res.status(401).json({ error: "Authentication required" }); return; }
  next();
}

export function requireCapability(capability: Capability) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.tenant) { res.status(401).json({ error: "Authentication required" }); return; }
    if (!can(req.tenant, capability)) { res.status(403).json({ error: "Insufficient permissions" }); return; }
    next();
  };
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.tenant) { res.status(401).json({ error: "Authentication required" }); return; }
    if (!hasPermission(req.tenant, permission)) { res.status(403).json({ error: "Insufficient permissions" }); return; }
    next();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}
