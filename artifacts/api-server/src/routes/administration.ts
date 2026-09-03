import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, enrollmentTokensTable, organizationsTable, sitesTable } from "@workspace/db";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { organizationScope, reachesOrganization, tenantCondition } from "../tenancy/scope.ts";
import { recordAudit } from "../tenancy/audit.ts";

const router: IRouter = Router();

router.use("/v1/admin/enrollment-tokens", requireTenantContext);

router.get("/v1/admin/enrollment-tokens", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "enrollment-token:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const requested = typeof req.query.organization_id === "string" ? req.query.organization_id : undefined;
  const scope = organizationScope(context, requested);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const tenant = tenantCondition(enrollmentTokensTable.organizationId, scope.organizationIds);

  // The token hash is never selected: a stored enrollment secret has no route
  // out of the database (§X).
  const tokens = await db.select({
    id: enrollmentTokensTable.id,
    name: enrollmentTokensTable.name,
    organization_id: enrollmentTokensTable.organizationId,
    organization_name: organizationsTable.name,
    site_id: enrollmentTokensTable.siteId,
    site_name: sitesTable.name,
    expires_at: enrollmentTokensTable.expiresAt,
    max_uses: enrollmentTokensTable.maxUses,
    current_uses: enrollmentTokensTable.uses,
    created_at: enrollmentTokensTable.createdAt,
    revoked_at: enrollmentTokensTable.revokedAt,
    active: enrollmentTokensTable.active,
  }).from(enrollmentTokensTable)
    .innerJoin(organizationsTable, eq(enrollmentTokensTable.organizationId, organizationsTable.id))
    .leftJoin(sitesTable, eq(enrollmentTokensTable.siteId, sitesTable.id))
    .where(tenant)
    .orderBy(desc(enrollmentTokensTable.createdAt));
  res.json(tokens);
});

router.post("/v1/admin/enrollment-tokens", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const parsed = z.object({
    name: z.string().trim().min(1).max(120),
    organization_id: z.string().uuid(),
    site_id: z.string().uuid().nullable().optional(),
    expires_at: z.coerce.date().refine((value) => value.getTime() > Date.now(), "Expiration must be in the future"),
    max_uses: z.number().int().min(1).max(10000).default(1),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // A token may only be minted for an organization the caller can reach, which
  // is what stops one tenant issuing enrolment credentials into another (§AG).
  if (!reachesOrganization(context, parsed.data.organization_id)) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "enrollment-token:manage", parsed.data.organization_id)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, parsed.data.organization_id));
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (organization.status !== "ACTIVE") { res.status(409).json({ error: "Enrollment tokens can only be issued for an active organization" }); return; }

  if (parsed.data.site_id) {
    const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, parsed.data.site_id));
    if (!site || site.organizationId !== parsed.data.organization_id) {
      res.status(422).json({ error: "Site does not belong to the selected organization" });
      return;
    }
    if (site.status !== "ACTIVE") { res.status(422).json({ error: "Site is archived" }); return; }
  }

  const rawToken = `nxen_${crypto.randomBytes(32).toString("base64url")}`;
  const [created] = await db.insert(enrollmentTokensTable).values({
    name: parsed.data.name,
    organizationId: parsed.data.organization_id,
    siteId: parsed.data.site_id ?? null,
    legacyOrganization: organization.name,
    expiresAt: parsed.data.expires_at,
    maxUses: parsed.data.max_uses,
    createdByUserId: context.userId,
    tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
  }).returning();
  await recordAudit({
    action: "ENROLLMENT_TOKEN_CREATED", context, organizationId: created.organizationId,
    targetType: "enrollment_token", targetId: created.id, req,
    // Name, scope and limits only — never the token or its hash.
    metadata: { name: created.name, site_id: created.siteId, max_uses: created.maxUses, expires_at: created.expiresAt },
  });
  res.status(201).json({
    id: created.id,
    name: created.name,
    organization_id: created.organizationId,
    organization_name: organization.name,
    site_id: created.siteId,
    expires_at: created.expiresAt,
    max_uses: created.maxUses,
    current_uses: created.uses,
    created_at: created.createdAt,
    revoked_at: created.revokedAt,
    active: created.active,
    // Shown once, at creation, and never retrievable afterwards.
    token: rawToken,
  });
});

router.post("/v1/admin/enrollment-tokens/:token_id/revoke", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const tokenId = z.string().uuid().safeParse(req.params.token_id);
  if (!tokenId.success) { res.status(400).json({ error: "Invalid token ID" }); return; }
  const scope = organizationScope(context);
  if (!scope.ok) { res.status(404).json({ error: "Enrollment token not found" }); return; }
  const tenant = tenantCondition(enrollmentTokensTable.organizationId, scope.organizationIds);

  const [token] = await db.select().from(enrollmentTokensTable)
    .where(tenant ? and(eq(enrollmentTokensTable.id, tokenId.data), tenant) : eq(enrollmentTokensTable.id, tokenId.data));
  if (!token) { res.status(404).json({ error: "Enrollment token not found" }); return; }
  if (!can(context, "enrollment-token:manage", token.organizationId)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const [revoked] = await db.update(enrollmentTokensTable)
    .set({ active: false, revokedAt: new Date() })
    .where(eq(enrollmentTokensTable.id, token.id))
    .returning({ id: enrollmentTokensTable.id });
  await recordAudit({
    action: "ENROLLMENT_TOKEN_REVOKED", context, organizationId: token.organizationId,
    targetType: "enrollment_token", targetId: revoked.id, req, metadata: { name: token.name },
  });
  res.sendStatus(204);
});

export default router;
