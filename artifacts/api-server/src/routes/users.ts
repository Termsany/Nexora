import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, organizationMembershipsTable, organizationsTable, usersTable } from "@workspace/db";
import { hashPassword } from "../auth/password.ts";
import { revokeAllSessionsForUser } from "../auth/sessions.ts";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { recordAudit } from "../tenancy/audit.ts";

const router: IRouter = Router();

router.use("/v1/admin/users", requireTenantContext);

/**
 * User administration is platform-only.
 *
 * Organization administrators manage *membership* of existing users through
 * /v1/organizations/:id/members; they cannot create accounts, which is what
 * keeps them from minting a platform-scoped user and escalating out of their
 * tenant (§AD).
 */
router.use("/v1/admin/users", (req, res, next) => {
  if (!can(req.tenant!, "user:manage")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  next();
});

const password = z.string().min(12).max(400);

const createUserBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(200),
  password,
  scope: z.enum(["PLATFORM", "ORGANIZATION"]),
  platform_role: z.enum(["PLATFORM_SUPER_ADMIN", "PLATFORM_ADMIN", "PLATFORM_TECHNICIAN"]).nullable().optional(),
  memberships: z.array(z.object({
    organization_id: z.string().uuid(),
    role: z.enum(["ORGANIZATION_ADMIN", "ORGANIZATION_TECHNICIAN", "ORGANIZATION_VIEWER"]),
  })).max(100).optional(),
}).superRefine((value, context) => {
  // Mirrors the nexora_users_scope_role_ck database constraint so the API
  // rejects the combination with a clear message rather than a constraint error.
  if (value.scope === "PLATFORM" && !value.platform_role) {
    context.addIssue({ code: "custom", message: "A platform user requires a platform_role", path: ["platform_role"] });
  }
  if (value.scope === "ORGANIZATION" && value.platform_role) {
    context.addIssue({ code: "custom", message: "An organization user cannot hold a platform_role", path: ["platform_role"] });
  }
  if (value.scope === "PLATFORM" && value.memberships?.length) {
    context.addIssue({ code: "custom", message: "Platform users cannot hold organization memberships", path: ["memberships"] });
  }
});

function publicUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id, email: user.email, name: user.name, scope: user.scope,
    platform_role: user.platformRole, status: user.status,
    last_login_at: user.lastLoginAt, created_at: user.createdAt, updated_at: user.updatedAt,
  };
}

router.get("/v1/admin/users", async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.email);
  const memberships = await db.select({
    userId: organizationMembershipsTable.userId,
    organizationId: organizationMembershipsTable.organizationId,
    organizationName: organizationsTable.name,
    role: organizationMembershipsTable.role,
  }).from(organizationMembershipsTable)
    .innerJoin(organizationsTable, eq(organizationMembershipsTable.organizationId, organizationsTable.id));
  const byUser = new Map<string, typeof memberships>();
  for (const membership of memberships) byUser.set(membership.userId, [...(byUser.get(membership.userId) ?? []), membership]);
  res.json({
    items: users.map((user) => ({
      ...publicUser(user),
      memberships: (byUser.get(user.id) ?? []).map((membership) => ({
        organization_id: membership.organizationId, organization_name: membership.organizationName, role: membership.role,
      })),
    })),
  });
});

router.post("/v1/admin/users", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const parsed = createUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, parsed.data.email));
  if (existing.length) { res.status(409).json({ error: "A user with this email already exists" }); return; }

  for (const membership of parsed.data.memberships ?? []) {
    const [organization] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, membership.organization_id));
    if (!organization) { res.status(422).json({ error: "Membership references an organization that does not exist" }); return; }
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const created = await db.transaction(async (tx) => {
    const [user] = await tx.insert(usersTable).values({
      email: parsed.data.email,
      name: parsed.data.name,
      passwordHash,
      scope: parsed.data.scope,
      platformRole: parsed.data.scope === "PLATFORM" ? parsed.data.platform_role! : null,
    }).returning();
    if (parsed.data.memberships?.length) {
      await tx.insert(organizationMembershipsTable).values(parsed.data.memberships.map((membership) => ({
        userId: user.id, organizationId: membership.organization_id, role: membership.role,
      })));
    }
    return user;
  });

  await recordAudit({
    action: "USER_CREATED", context, targetType: "user", targetId: created.id, req,
    metadata: { email: created.email, scope: created.scope, platform_role: created.platformRole },
  });
  res.status(201).json(publicUser(created));
});

const updateUserBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  password: password.optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "No fields to update");

router.patch("/v1/admin/users/:user_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const userId = z.string().uuid().safeParse(req.params.user_id);
  if (!userId.success) { res.status(400).json({ error: "Invalid user ID" }); return; }
  const parsed = updateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId.data));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  // Scope and platform_role are deliberately not updatable: changing them is a
  // privilege change that should go through deliberate account creation rather
  // than an edit, and it keeps this endpoint from becoming an escalation path.
  if (parsed.data.status === "DISABLED" && context.userId === user.id) {
    res.status(403).json({ error: "You cannot disable your own account" });
    return;
  }

  const [updated] = await db.update(usersTable).set({
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.password !== undefined ? { passwordHash: await hashPassword(parsed.data.password) } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id)).returning();

  // A password change or a disable must not leave live sessions behind.
  if (parsed.data.password !== undefined || parsed.data.status === "DISABLED") {
    await revokeAllSessionsForUser(user.id);
  }
  await recordAudit({
    action: "USER_UPDATED", context, targetType: "user", targetId: user.id, req,
    metadata: { fields: Object.keys(parsed.data), status: updated.status },
  });
  res.json(publicUser(updated));
});

export default router;
