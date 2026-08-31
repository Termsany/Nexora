import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  organizationMembershipsTable,
  organizationsTable,
  pool,
  sitesTable,
  usersTable,
} from "@workspace/db";
import { can, requireTenantContext, type TenantContext } from "../tenancy/context.ts";
import { organizationScope, reachesOrganization, tenantSqlClause } from "../tenancy/scope.ts";
import { recordAudit } from "../tenancy/audit.ts";

const router: IRouter = Router();

router.use("/v1/organizations", requireTenantContext);
router.use("/v1/sites", requireTenantContext);

const ONLINE_SECONDS = Number(process.env.ONLINE_THRESHOLD_SECONDS ?? 90);

const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().min(1).max(120).regex(slugPattern, "Slug must be lowercase alphanumeric words separated by single hyphens"),
  external_reference: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
  external_reference: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "No fields to update");

const createSiteBody = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(200).nullable().optional(),
  country: z.string().trim().max(200).nullable().optional(),
  timezone: z.string().trim().max(100).nullable().optional(),
});

const updateSiteBody = createSiteBody.partial().extend({
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "No fields to update");

const uuid = z.string().uuid();

function publicOrganization(row: typeof organizationsTable.$inferSelect) {
  return {
    id: row.id, name: row.name, slug: row.slug, status: row.status,
    external_reference: row.externalReference, notes: row.notes,
    created_at: row.createdAt, updated_at: row.updatedAt, archived_at: row.archivedAt,
  };
}

function publicSite(row: typeof sitesTable.$inferSelect) {
  return {
    id: row.id, organization_id: row.organizationId, name: row.name, code: row.code,
    description: row.description, address: row.address, city: row.city, country: row.country,
    timezone: row.timezone, status: row.status,
    created_at: row.createdAt, updated_at: row.updatedAt, archived_at: row.archivedAt,
  };
}

/**
 * Loads an organization only when the context may reach it. A tenant-invisible
 * organization is reported as not found rather than forbidden, so organization
 * IDs cannot be probed for existence (§M).
 */
async function findOrganizationInScope(context: TenantContext, organizationId: string) {
  if (!reachesOrganization(context, organizationId)) return null;
  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  return organization ?? null;
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

router.get("/v1/organizations", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!can(context, "organization:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const query = parsed.data;

  const scope = organizationScope(context);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const filters = [tenantSqlClause("o.id", scope.organizationIds, values)];
  if (query.status) { values.push(query.status); filters.push(`o.status = $${values.length}`); }
  else if (!context.platformAccess) filters.push("o.status = 'ACTIVE'");
  if (query.search) { values.push(`%${query.search}%`); filters.push(`(o.name ILIKE $${values.length} OR o.slug ILIKE $${values.length})`); }
  const where = filters.join(" AND ");

  // Counts come from grouped subqueries rather than per-row lookups so the list
  // stays a single round trip regardless of how many organizations exist (§AP).
  const total = await pool.query<{ total: number }>(`SELECT count(*)::int total FROM nexora_organizations o WHERE ${where}`, values);
  values.push(ONLINE_SECONDS, query.page_size, (query.page - 1) * query.page_size);
  const rows = await pool.query(`
    SELECT o.id, o.name, o.slug, o.status, o.external_reference, o.notes,
           o.created_at, o.updated_at, o.archived_at,
           COALESCE(s.site_count, 0) AS site_count,
           COALESCE(d.device_count, 0) AS device_count,
           COALESCE(d.online_count, 0) AS online_count,
           COALESCE(a.active_alert_count, 0) AS active_alert_count,
           d.last_activity_at
    FROM nexora_organizations o
    LEFT JOIN (SELECT organization_id, count(*)::int site_count FROM nexora_sites WHERE status = 'ACTIVE' GROUP BY organization_id) s ON s.organization_id = o.id
    LEFT JOIN (SELECT organization_id, count(*)::int device_count,
                      count(*) FILTER (WHERE last_seen_at > now() - make_interval(secs => $${values.length - 2}))::int online_count,
                      max(last_seen_at) last_activity_at
               FROM nexora_devices GROUP BY organization_id) d ON d.organization_id = o.id
    LEFT JOIN (SELECT organization_id, count(*)::int active_alert_count FROM nexora_alerts WHERE state IN ('OPEN','ACKNOWLEDGED') GROUP BY organization_id) a ON a.organization_id = o.id
    WHERE ${where}
    ORDER BY lower(o.name), o.id
    LIMIT $${values.length - 1} OFFSET $${values.length}`, values);

  res.json({
    items: rows.rows.map((row) => ({
      id: row.id, name: row.name, slug: row.slug, status: row.status,
      external_reference: row.external_reference, notes: row.notes,
      created_at: row.created_at, updated_at: row.updated_at, archived_at: row.archived_at,
      site_count: row.site_count, device_count: row.device_count,
      online_device_count: row.online_count, active_alert_count: row.active_alert_count,
      last_activity_at: row.last_activity_at,
      role: context.memberships.get(row.id) ?? null,
    })),
    page: query.page, page_size: query.page_size, total: total.rows[0]?.total ?? 0,
  });
});

router.post("/v1/organizations", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "organization:create")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const parsed = createOrganizationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const existing = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.slug, parsed.data.slug));
  if (existing.length) { res.status(409).json({ error: "An organization with this slug already exists" }); return; }

  const [created] = await db.insert(organizationsTable).values({
    name: parsed.data.name,
    slug: parsed.data.slug,
    externalReference: parsed.data.external_reference ?? null,
    notes: parsed.data.notes ?? null,
  }).returning();
  await recordAudit({
    action: "ORGANIZATION_CREATED", context, organizationId: created.id,
    targetType: "organization", targetId: created.id, req,
    metadata: { name: created.name, slug: created.slug },
  });
  res.status(201).json(publicOrganization(created));
});

router.get("/v1/organizations/:organization_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  if (!id.success) { res.status(400).json({ error: "Invalid organization ID" }); return; }
  if (!can(context, "organization:read", id.data)) { res.status(404).json({ error: "Organization not found" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }

  const [counts] = (await pool.query(`
    SELECT (SELECT count(*)::int FROM nexora_sites WHERE organization_id = $1 AND status = 'ACTIVE') site_count,
           (SELECT count(*)::int FROM nexora_devices WHERE organization_id = $1) device_count,
           (SELECT count(*)::int FROM nexora_devices WHERE organization_id = $1 AND last_seen_at > now() - make_interval(secs => $2)) online_count,
           (SELECT count(*)::int FROM nexora_alerts WHERE organization_id = $1 AND state IN ('OPEN','ACKNOWLEDGED')) active_alert_count,
           (SELECT count(*)::int FROM nexora_organization_memberships WHERE organization_id = $1) member_count,
           (SELECT max(last_seen_at) FROM nexora_devices WHERE organization_id = $1) last_activity_at`,
    [id.data, ONLINE_SECONDS])).rows;

  res.json({
    ...publicOrganization(organization),
    site_count: counts.site_count, device_count: counts.device_count,
    online_device_count: counts.online_count, active_alert_count: counts.active_alert_count,
    member_count: counts.member_count, last_activity_at: counts.last_activity_at,
    role: context.memberships.get(organization.id) ?? null,
  });
});

router.patch("/v1/organizations/:organization_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  if (!id.success) { res.status(400).json({ error: "Invalid organization ID" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "organization:update", id.data)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const parsed = updateOrganizationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Changing status is a platform decision: an organization administrator must
  // not be able to suspend or archive their own tenant.
  if (parsed.data.status && parsed.data.status !== organization.status && !context.platformAccess) {
    res.status(403).json({ error: "Only platform administrators can change organization status" });
    return;
  }

  const now = new Date();
  const [updated] = await db.update(organizationsTable).set({
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.external_reference !== undefined ? { externalReference: parsed.data.external_reference } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    ...(parsed.data.status === "ARCHIVED" ? { archivedAt: now } : {}),
    ...(parsed.data.status && parsed.data.status !== "ARCHIVED" ? { archivedAt: null } : {}),
    updatedAt: now,
  }).where(eq(organizationsTable.id, id.data)).returning();

  const action = parsed.data.status && parsed.data.status !== organization.status
    ? (parsed.data.status === "SUSPENDED" ? "ORGANIZATION_SUSPENDED" as const
      : parsed.data.status === "ARCHIVED" ? "ORGANIZATION_ARCHIVED" as const
      : "ORGANIZATION_REACTIVATED" as const)
    : "ORGANIZATION_UPDATED" as const;
  await recordAudit({
    action, context, organizationId: updated.id, targetType: "organization", targetId: updated.id, req,
    metadata: { fields: Object.keys(parsed.data), previous_status: organization.status, new_status: updated.status },
  });
  res.json(publicOrganization(updated));
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

router.get("/v1/organizations/:organization_id/sites", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  if (!id.success) { res.status(400).json({ error: "Invalid organization ID" }); return; }
  if (!can(context, "site:read", id.data)) { res.status(404).json({ error: "Organization not found" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }

  const includeArchived = req.query.include_archived === "true";
  const rows = await pool.query(`
    SELECT s.id, s.organization_id, s.name, s.code, s.description, s.address, s.city, s.country,
           s.timezone, s.status, s.created_at, s.updated_at, s.archived_at,
           COALESCE(d.device_count, 0) AS device_count
    FROM nexora_sites s
    LEFT JOIN (SELECT site_id, count(*)::int device_count FROM nexora_devices WHERE site_id IS NOT NULL GROUP BY site_id) d ON d.site_id = s.id
    WHERE s.organization_id = $1 ${includeArchived ? "" : "AND s.status = 'ACTIVE'"}
    ORDER BY lower(s.name), s.id`, [id.data]);
  res.json({ items: rows.rows });
});

router.post("/v1/organizations/:organization_id/sites", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  if (!id.success) { res.status(400).json({ error: "Invalid organization ID" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "site:manage", id.data)) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  if (organization.status !== "ACTIVE") { res.status(409).json({ error: "Sites can only be created in an active organization" }); return; }

  const parsed = createSiteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const duplicate = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.organizationId, id.data), eq(sitesTable.name, parsed.data.name)));
  if (duplicate.length) { res.status(409).json({ error: "A site with this name already exists in the organization" }); return; }

  // organizationId comes from the validated path, never from the request body,
  // so a site cannot be created inside another tenant (§U).
  const [created] = await db.insert(sitesTable).values({
    organizationId: id.data,
    name: parsed.data.name,
    code: parsed.data.code ?? null,
    description: parsed.data.description ?? null,
    address: parsed.data.address ?? null,
    city: parsed.data.city ?? null,
    country: parsed.data.country ?? null,
    timezone: parsed.data.timezone ?? null,
  }).returning();
  await recordAudit({
    action: "SITE_CREATED", context, organizationId: id.data, targetType: "site", targetId: created.id, req,
    metadata: { name: created.name, code: created.code },
  });
  res.status(201).json(publicSite(created));
});

router.get("/v1/sites/:site_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.site_id);
  if (!id.success) { res.status(400).json({ error: "Invalid site ID" }); return; }
  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, id.data));
  if (!site || !can(context, "site:read", site.organizationId)) { res.status(404).json({ error: "Site not found" }); return; }
  res.json(publicSite(site));
});

router.patch("/v1/sites/:site_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.site_id);
  if (!id.success) { res.status(400).json({ error: "Invalid site ID" }); return; }
  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, id.data));
  if (!site || !reachesOrganization(context, site.organizationId)) { res.status(404).json({ error: "Site not found" }); return; }
  if (!can(context, "site:manage", site.organizationId)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const parsed = updateSiteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  if (parsed.data.name && parsed.data.name !== site.name) {
    const duplicate = await db.select({ id: sitesTable.id }).from(sitesTable)
      .where(and(eq(sitesTable.organizationId, site.organizationId), eq(sitesTable.name, parsed.data.name)));
    if (duplicate.length) { res.status(409).json({ error: "A site with this name already exists in the organization" }); return; }
  }
  if (parsed.data.status === "ARCHIVED" && site.status !== "ARCHIVED") {
    const [{ count: attached }] = (await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM nexora_devices WHERE site_id = $1", [site.id])).rows;
    if (attached > 0) { res.status(409).json({ error: `Site still has ${attached} device(s) assigned` }); return; }
  }

  const now = new Date();
  const [updated] = await db.update(sitesTable).set({
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
    ...(parsed.data.city !== undefined ? { city: parsed.data.city } : {}),
    ...(parsed.data.country !== undefined ? { country: parsed.data.country } : {}),
    ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.status === "ARCHIVED" ? { archivedAt: now } : {}),
    ...(parsed.data.status === "ACTIVE" ? { archivedAt: null } : {}),
    updatedAt: now,
  }).where(eq(sitesTable.id, site.id)).returning();

  await recordAudit({
    action: parsed.data.status === "ARCHIVED" && site.status !== "ARCHIVED" ? "SITE_ARCHIVED" : "SITE_UPDATED",
    context, organizationId: site.organizationId, targetType: "site", targetId: site.id, req,
    metadata: { fields: Object.keys(parsed.data) },
  });
  res.json(publicSite(updated));
});

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

const membershipBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["ORGANIZATION_ADMIN", "ORGANIZATION_TECHNICIAN", "ORGANIZATION_VIEWER"]),
});

router.get("/v1/organizations/:organization_id/members", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  if (!id.success) { res.status(400).json({ error: "Invalid organization ID" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "membership:read", id.data)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const rows = await db.select({
    id: organizationMembershipsTable.id,
    role: organizationMembershipsTable.role,
    created_at: organizationMembershipsTable.createdAt,
    user_id: usersTable.id,
    email: usersTable.email,
    name: usersTable.name,
    status: usersTable.status,
  }).from(organizationMembershipsTable)
    .innerJoin(usersTable, eq(organizationMembershipsTable.userId, usersTable.id))
    .where(eq(organizationMembershipsTable.organizationId, id.data))
    .orderBy(usersTable.email);
  res.json({ items: rows });
});

router.post("/v1/organizations/:organization_id/members", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  if (!id.success) { res.status(400).json({ error: "Invalid organization ID" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "membership:manage", id.data)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const parsed = membershipBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, parsed.data.user_id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  // Platform staff draw their access from their platform role; giving them an
  // organization membership would imply a downgrade the model does not express.
  if (user.scope === "PLATFORM") { res.status(409).json({ error: "Platform users cannot hold organization memberships" }); return; }

  const existing = await db.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable)
    .where(and(eq(organizationMembershipsTable.userId, user.id), eq(organizationMembershipsTable.organizationId, id.data)));
  if (existing.length) { res.status(409).json({ error: "User is already a member of this organization" }); return; }

  const [created] = await db.insert(organizationMembershipsTable).values({
    userId: user.id, organizationId: id.data, role: parsed.data.role,
  }).returning();
  await recordAudit({
    action: "MEMBERSHIP_CREATED", context, organizationId: id.data,
    targetType: "membership", targetId: created.id, req,
    metadata: { user_id: user.id, email: user.email, role: created.role },
  });
  res.status(201).json({ id: created.id, user_id: user.id, email: user.email, name: user.name, role: created.role, created_at: created.createdAt });
});

router.patch("/v1/organizations/:organization_id/members/:user_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  const userId = uuid.safeParse(req.params.user_id);
  if (!id.success || !userId.success) { res.status(400).json({ error: "Invalid identifier" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "membership:manage", id.data)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const parsed = z.object({ role: membershipBody.shape.role }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // An organization administrator must not be able to alter their own role.
  if (context.userId === userId.data && !context.platformAccess) {
    res.status(403).json({ error: "You cannot change your own membership role" });
    return;
  }

  const [updated] = await db.update(organizationMembershipsTable)
    .set({ role: parsed.data.role, updatedAt: new Date() })
    .where(and(eq(organizationMembershipsTable.userId, userId.data), eq(organizationMembershipsTable.organizationId, id.data)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Membership not found" }); return; }
  await recordAudit({
    action: "MEMBERSHIP_UPDATED", context, organizationId: id.data,
    targetType: "membership", targetId: updated.id, req,
    metadata: { user_id: userId.data, role: updated.role },
  });
  res.json({ id: updated.id, user_id: updated.userId, role: updated.role });
});

router.delete("/v1/organizations/:organization_id/members/:user_id", async (req, res): Promise<void> => {
  const context = req.tenant!;
  const id = uuid.safeParse(req.params.organization_id);
  const userId = uuid.safeParse(req.params.user_id);
  if (!id.success || !userId.success) { res.status(400).json({ error: "Invalid identifier" }); return; }
  const organization = await findOrganizationInScope(context, id.data);
  if (!organization) { res.status(404).json({ error: "Organization not found" }); return; }
  if (!can(context, "membership:manage", id.data)) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  if (context.userId === userId.data && !context.platformAccess) {
    res.status(403).json({ error: "You cannot remove your own membership" });
    return;
  }

  const [removed] = await db.delete(organizationMembershipsTable)
    .where(and(eq(organizationMembershipsTable.userId, userId.data), eq(organizationMembershipsTable.organizationId, id.data)))
    .returning({ id: organizationMembershipsTable.id });
  if (!removed) { res.status(404).json({ error: "Membership not found" }); return; }
  await recordAudit({
    action: "MEMBERSHIP_REMOVED", context, organizationId: id.data,
    targetType: "membership", targetId: removed.id, req, metadata: { user_id: userId.data },
  });
  res.sendStatus(204);
});

export default router;
