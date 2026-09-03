import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { configuredDeviceState } from "../lib/device-state";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, activityTable, agentCredentialsTable, devicesTable, diskMetricsTable, enrollmentTokensTable, metricsTable, organizationsTable, pool, sitesTable } from "@workspace/db";
import { reconcileSoftwareSnapshot } from "../software/reconcile.ts";
import { reconcileProcesses, reconcileServices } from "../inventory/reconcile.ts";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { findDeviceInScope, organizationScope, tenantSqlClause } from "../tenancy/scope.ts";
import { recordAudit } from "../tenancy/audit.ts";
import {
  EnrollAgentBody,
  EnrollAgentResponse,
  GetDashboardActivityResponse,
  GetDashboardSummaryResponse,
  GetDeviceParams,
  GetDeviceResponse,
  ListDevicesQueryParams,
  ListDevicesResponse,
  PostHeartbeatBody,
  PostInventoryBody,
  PostMetricsBody,
} from "@workspace/api-zod";

const router: IRouter = Router();
const AgentHeartbeatPayload = PostHeartbeatBody.extend({ capabilities: z.array(z.string().max(100)).max(100).optional() });
const ONLINE_SECONDS = Number(process.env.ONLINE_THRESHOLD_SECONDS ?? 90);
const OFFLINE_SECONDS = Number(process.env.OFFLINE_THRESHOLD_SECONDS ?? 120);
const InventoryPayload = PostInventoryBody.extend({
  os: z.object({ name: z.string().min(1), version: z.string(), build: z.string(), architecture: z.string() }),
  hardware: z.object({
    manufacturer: z.string().nullable().optional(), model: z.string().nullable().optional(), cpu_model: z.string().nullable().optional(),
    logical_processors: z.number().int().min(1), total_ram_bytes: z.number().int().nonnegative(), bios_version: z.string().nullable().optional(),
  }),
  disks: z.array(z.object({ drive: z.string(), filesystem: z.string(), total_bytes: z.number().int().nonnegative(), used_bytes: z.number().int().nonnegative(), free_bytes: z.number().int().nonnegative(), used_percent: z.number().min(0).max(100) })),
  network: z.array(z.object({ name: z.string(), interface_type: z.string(), ipv4: z.ipv4(), mac: z.string(), gateway: z.string(), dns_servers: z.array(z.string()) })),
  software: z.object({
    complete: z.boolean(), collected_at: z.iso.datetime({ offset: true }), error_code: z.string().max(100).nullable().optional(),
    entries: z.array(z.object({
      name: z.string().trim().min(1).max(300), version: z.string().max(200).nullable().optional(), publisher: z.string().max(300).nullable().optional(),
      install_date: z.iso.datetime({ offset: true }).nullable().optional(), install_location: z.string().max(1000).nullable().optional(), uninstall_available: z.boolean(),
      product_code: z.string().max(200).nullable().optional(), architecture: z.enum(["x64", "x86", "unknown"]), source: z.literal("windows_registry"),
      system_component: z.boolean(), identity: z.string().max(128).optional(),
    })).max(5000),
  }).optional(),
});
const MetricDiskPayload = z.object({
  drive: z.string().min(1), filesystem: z.string(), total_bytes: z.number().int().nonnegative(),
  used_bytes: z.number().int().nonnegative(), free_bytes: z.number().int().nonnegative(), used_percent: z.number().min(0).max(100),
}).refine((disk) => disk.used_bytes + disk.free_bytes <= disk.total_bytes + 1024 * 1024, "Disk byte values are inconsistent");
const MetricsPayload = PostMetricsBody.extend({ disks: z.array(MetricDiskPayload).max(64).optional() });
const CollectionStatus = z.enum(["complete", "partial", "failed", "COMPLETE", "PARTIAL", "FAILED"]).transform(value => value.toUpperCase() as "COMPLETE" | "PARTIAL" | "FAILED");
const SnapshotMeta = z.object({ snapshot_id: z.uuid(), collected_at: z.iso.datetime({ offset: true }), collection_status: CollectionStatus,
  item_count: z.number().int().min(0), agent_version: z.string().min(1).max(50) });
const ServiceSnapshot = SnapshotMeta.extend({ items: z.array(z.object({
  service_name: z.string().trim().min(1).max(256), display_name: z.string().trim().min(1).max(512),
  status: z.enum(["running","stopped","paused","start_pending","stop_pending","pause_pending","continue_pending","unknown"]).transform(v => v.toUpperCase()),
  startup_type: z.enum(["automatic","automatic_delayed","manual","disabled","boot","system","unknown"]).transform(v => v.toUpperCase()),
  logon_as: z.string().max(512).nullable().optional(), service_type: z.string().max(256).nullable().optional(), process_id: z.number().int().positive().nullable().optional(),
  binary_path: z.string().max(4096).nullable().optional(), description: z.string().max(4096).nullable().optional(), delayed_auto_start: z.boolean().nullable().optional(),
})).max(5000) }).superRefine((value, context) => { if (value.item_count !== value.items.length) context.addIssue({ code: "custom", message: "item_count must match items length", path: ["item_count"] }); });
const ProcessSnapshot = SnapshotMeta.extend({ items: z.array(z.object({
  pid: z.number().int().positive().max(4_194_304), process_name: z.string().trim().min(1).max(512), executable_path: z.string().max(4096).nullable().optional(),
  username: z.string().max(512).nullable().optional(), cpu_time_seconds: z.number().finite().nonnegative(), cpu_percent: z.number().finite().min(0).max(100).nullable().optional(),
  working_set_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), private_memory_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  thread_count: z.number().int().nonnegative().max(100000).nullable().optional(), handle_count: z.number().int().nonnegative().max(10000000).nullable().optional(),
  started_at: z.iso.datetime({ offset: true }), architecture: z.enum(["x64","x86","arm64","unknown"]), session_id: z.number().int().nonnegative().nullable().optional(),
})).max(10000) }).superRefine((value, context) => { if (value.item_count !== value.items.length) context.addIssue({ code: "custom", message: "item_count must match items length", path: ["item_count"] }); });

function statusFor(lastSeenAt: Date | null): "ONLINE" | "OFFLINE" | "UNKNOWN" {
  return configuredDeviceState(lastSeenAt);
}

/**
 * SQL predicate matching the JavaScript `deviceState` classification, so status
 * filtering happens in the database instead of after pagination (§AJ).
 */
function statusPredicate(status: "ONLINE" | "OFFLINE" | "UNKNOWN", values: unknown[]) {
  values.push(ONLINE_SECONDS, OFFLINE_SECONDS);
  const online = `$${values.length - 1}`;
  const offline = `$${values.length}`;
  if (status === "ONLINE") return `(d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - make_interval(secs => ${online}))`;
  if (status === "OFFLINE") return `(d.last_seen_at IS NOT NULL AND d.last_seen_at <= now() - make_interval(secs => ${offline}))`;
  return `(d.last_seen_at IS NULL OR (d.last_seen_at <= now() - make_interval(secs => ${online}) AND d.last_seen_at > now() - make_interval(secs => ${offline})))`;
}

async function markOnline(device: typeof devicesTable.$inferSelect) {
  const transitioned = await db.update(devicesTable)
    .set({ status: "ONLINE", lastSeenAt: new Date(), updatedAt: new Date() })
    .where(and(eq(devicesTable.id, device.id), sql`${devicesTable.status} <> 'ONLINE'`))
    .returning({ id: devicesTable.id });
  if (transitioned.length) {
    await db.insert(activityTable).values({
      deviceId: device.id,
      event: `${device.status}_TO_ONLINE`,
    });
  } else {
    await db.update(devicesTable).set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(devicesTable.id, device.id));
  }
}

async function reconcileOfflineTransitions() {
  const cutoff = new Date(Date.now() - OFFLINE_SECONDS * 1000);
  const transitioned = await db.update(devicesTable)
    .set({ status: "OFFLINE", updatedAt: new Date() })
    .where(and(eq(devicesTable.status, "ONLINE"), lt(devicesTable.lastSeenAt, cutoff)))
    .returning({ id: devicesTable.id });
  if (transitioned.length) {
    await db.insert(activityTable).values(transitioned.map(({ id }) => ({
      deviceId: id,
      event: "ONLINE_TO_OFFLINE",
    })));
  }
}

type DeviceOwnership = { organization_id: string; organization_name: string | null; organization_slug: string | null; site_id: string | null; site_name: string | null };

function publicDevice(
  device: typeof devicesTable.$inferSelect,
  latest?: { cpuPercent: number; ramPercent: number; diskPercent: number; uptimeSeconds: number } | null,
  ownership?: DeviceOwnership,
) {
  return {
    id: device.id,
    agent_id: device.agentId,
    device_uuid: device.deviceUuid,
    hostname: device.hostname,
    status: statusFor(device.lastSeenAt),
    current_user: device.currentUser,
    domain: device.domain,
    os_name: device.osName,
    os_version: device.osVersion,
    os_build: device.osBuild,
    architecture: device.architecture,
    ip_address: device.ipAddress,
    agent_version: device.agentVersion,
    organization_id: ownership?.organization_id ?? device.organizationId,
    organization_name: ownership?.organization_name ?? null,
    organization_slug: ownership?.organization_slug ?? null,
    site_id: ownership?.site_id ?? device.siteId,
    site_name: ownership?.site_name ?? null,
    cpu_percent: latest?.cpuPercent ?? null,
    ram_percent: latest?.ramPercent ?? null,
    disk_percent: latest?.diskPercent ?? null,
    uptime_seconds: latest?.uptimeSeconds ?? null,
    last_seen_at: device.lastSeenAt,
    first_seen_at: device.firstSeenAt,
    created_at: device.createdAt,
    updated_at: device.updatedAt,
  };
}

async function authenticatedDevice(req: { headers: { authorization?: string } }) {
  const raw = req.headers.authorization;
  if (!raw?.startsWith("Bearer ")) return null;
  const tokenHash = crypto.createHash("sha256").update(raw.slice(7)).digest("hex");
  const [credential] = await db
    .select({ device: devicesTable })
    .from(agentCredentialsTable)
    .innerJoin(devicesTable, eq(agentCredentialsTable.deviceId, devicesTable.id))
    .where(and(eq(agentCredentialsTable.tokenHash, tokenHash), sql`${agentCredentialsTable.revokedAt} is null`));
  return credential?.device ?? null;
}

router.get("/v1/dashboard/summary", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "device:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  await reconcileOfflineTransitions();
  const scope = organizationScope(context, typeof req.query.organization_id === "string" ? req.query.organization_id : undefined);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const tenant = tenantSqlClause("d.organization_id", scope.organizationIds, values);
  values.push(ONLINE_SECONDS, OFFLINE_SECONDS);
  const online = `$${values.length - 1}`;
  const offline = `$${values.length}`;
  // Every aggregate is computed inside the tenant predicate, so a count can
  // never include another organization's devices (§AH).
  const [row] = (await pool.query(`
    WITH scoped AS (SELECT d.id, d.last_seen_at FROM nexora_devices d WHERE ${tenant}),
    latest AS (
      SELECT m.cpu_percent, m.ram_percent, m.disk_percent
      FROM scoped s
      JOIN LATERAL (SELECT cpu_percent, ram_percent, disk_percent FROM nexora_device_metrics
                    WHERE device_id = s.id ORDER BY received_at DESC LIMIT 1) m ON true
    )
    SELECT (SELECT count(*)::int FROM scoped) total_devices,
           (SELECT count(*)::int FROM scoped WHERE last_seen_at IS NOT NULL AND last_seen_at > now() - make_interval(secs => ${online})) online_devices,
           (SELECT count(*)::int FROM scoped WHERE last_seen_at IS NOT NULL AND last_seen_at <= now() - make_interval(secs => ${offline})) offline_devices,
           (SELECT count(*)::int FROM scoped WHERE last_seen_at IS NULL OR (last_seen_at <= now() - make_interval(secs => ${online}) AND last_seen_at > now() - make_interval(secs => ${offline}))) unknown_devices,
           (SELECT COALESCE(avg(cpu_percent), 0) FROM latest) average_cpu,
           (SELECT COALESCE(avg(ram_percent), 0) FROM latest) average_ram,
           (SELECT count(*)::int FROM latest WHERE disk_percent >= 85) disks_over_threshold`, values)).rows;

  res.json(GetDashboardSummaryResponse.parse({
    total_devices: row.total_devices,
    online_devices: row.online_devices,
    offline_devices: row.offline_devices,
    unknown_devices: row.unknown_devices,
    average_cpu: Number(row.average_cpu),
    average_ram: Number(row.average_ram),
    disks_over_threshold: row.disks_over_threshold,
}));
});

router.get("/v1/dashboard/activity", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "device:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  await reconcileOfflineTransitions();
  const scope = organizationScope(context, typeof req.query.organization_id === "string" ? req.query.organization_id : undefined);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const tenant = tenantSqlClause("d.organization_id", scope.organizationIds, values);
  const rows = await pool.query(`
    SELECT a.id, a.device_id, d.hostname, a.event, a.timestamp
    FROM nexora_activity a JOIN nexora_devices d ON d.id = a.device_id
    WHERE ${tenant} ORDER BY a.timestamp DESC LIMIT 12`, values);
  res.json(GetDashboardActivityResponse.parse(rows.rows.map((row) => ({
    id: row.id, device_id: row.device_id, hostname: row.hostname, event: row.event, timestamp: row.timestamp,
  }))));
});

router.get("/v1/devices", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "device:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  await reconcileOfflineTransitions();
  const parsed = ListDevicesQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { search, status, page, page_size: pageSize } = parsed.data;

  const requestedOrganization = typeof req.query.organization_id === "string" ? req.query.organization_id : undefined;
  const scope = organizationScope(context, requestedOrganization);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const filters = [tenantSqlClause("d.organization_id", scope.organizationIds, values)];
  if (typeof req.query.site_id === "string") {
    const siteId = z.string().uuid().safeParse(req.query.site_id);
    if (!siteId.success) { res.status(400).json({ error: "Invalid site ID" }); return; }
    values.push(siteId.data); filters.push(`d.site_id = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(d.hostname ILIKE $${values.length} OR d.agent_id ILIKE $${values.length} OR COALESCE(d.ip_address, '') ILIKE $${values.length})`);
  }
  if (status) filters.push(statusPredicate(status, values));
  const where = filters.join(" AND ");

  // The tenant predicate is part of both the page query and the total, so the
  // reported total cannot disclose the existence of other tenants' devices.
  const total = await pool.query<{ total: number }>(`SELECT count(*)::int total FROM nexora_devices d WHERE ${where}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await pool.query(`
    SELECT d.*, o.name AS organization_name, o.slug AS organization_slug, st.name AS site_name,
           m.cpu_percent, m.ram_percent, m.disk_percent, m.uptime_seconds
    FROM nexora_devices d
    JOIN nexora_organizations o ON o.id = d.organization_id
    LEFT JOIN nexora_sites st ON st.id = d.site_id
    LEFT JOIN LATERAL (SELECT cpu_percent, ram_percent, disk_percent, uptime_seconds
                       FROM nexora_device_metrics WHERE device_id = d.id
                       ORDER BY received_at DESC LIMIT 1) m ON true
    WHERE ${where}
    ORDER BY d.updated_at DESC, d.id
    LIMIT $${values.length - 1} OFFSET $${values.length}`, values);

  res.json(ListDevicesResponse.parse({
    items: rows.rows.map((row) => publicDevice(
      {
        ...row,
        agentId: row.agent_id, deviceUuid: row.device_uuid, currentUser: row.current_user,
        osName: row.os_name, osVersion: row.os_version, osBuild: row.os_build,
        ipAddress: row.ip_address, agentVersion: row.agent_version,
        organizationId: row.organization_id, siteId: row.site_id,
        lastSeenAt: row.last_seen_at, firstSeenAt: row.first_seen_at,
        createdAt: row.created_at, updatedAt: row.updated_at,
      } as typeof devicesTable.$inferSelect,
      row.cpu_percent == null ? null : {
        cpuPercent: row.cpu_percent, ramPercent: row.ram_percent,
        diskPercent: row.disk_percent, uptimeSeconds: row.uptime_seconds,
      },
      {
        organization_id: row.organization_id, organization_name: row.organization_name,
        organization_slug: row.organization_slug, site_id: row.site_id, site_name: row.site_name,
      },
    )),
    page, page_size: pageSize, total: total.rows[0]?.total ?? 0,
  }));
});

router.get("/v1/devices/:device_id", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "device:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  await reconcileOfflineTransitions();
  const params = GetDeviceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  // A device outside the caller's tenant is indistinguishable from one that
  // does not exist, which is what stops cross-tenant ID enumeration (§M).
  const device = await findDeviceInScope(context, params.data.device_id);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }

  const [latest] = await db.select().from(metricsTable).where(eq(metricsTable.deviceId, device.id)).orderBy(desc(metricsTable.receivedAt)).limit(1);
  const [organization] = await db.select({ name: organizationsTable.name, slug: organizationsTable.slug }).from(organizationsTable).where(eq(organizationsTable.id, device.organizationId));
  const site = device.siteId
    ? (await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, device.siteId)))[0]
    : undefined;

  res.json(GetDeviceResponse.parse({
    ...publicDevice(device, latest, {
      organization_id: device.organizationId,
      organization_name: organization?.name ?? null,
      organization_slug: organization?.slug ?? null,
      site_id: device.siteId,
      site_name: site?.name ?? null,
    }),
    hardware: device.hardware ?? {}, disks: device.disks ?? [], network: device.network ?? [],
  }));
});

/**
 * Site assignment. The organization is deliberately not settable here: device
 * tenancy is immutable through the ordinary device APIs (§W), and the site must
 * belong to the device's own organization (§D, §V).
 */
router.patch("/v1/devices/:device_id/site", requireTenantContext, async (req, res): Promise<void> => {
  const context = req.tenant!;
  const params = GetDeviceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const device = await findDeviceInScope(context, params.data.device_id);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }
  if (!can(context, "device:assign-site", device.organizationId)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const parsed = z.object({ site_id: z.string().uuid().nullable() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "site_id must be a UUID or null" }); return; }

  if (parsed.data.site_id) {
    const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, parsed.data.site_id));
    // Checked against the device's organization rather than the caller's scope:
    // even a platform administrator cannot place a device in another tenant's site.
    if (!site || site.organizationId !== device.organizationId) {
      res.status(422).json({ error: "Site does not belong to the device's organization" });
      return;
    }
    if (site.status !== "ACTIVE") { res.status(422).json({ error: "Site is archived" }); return; }
  }

  const [updated] = await db.update(devicesTable)
    .set({ siteId: parsed.data.site_id, updatedAt: new Date() })
    .where(eq(devicesTable.id, device.id))
    .returning();
  await recordAudit({
    action: "DEVICE_SITE_CHANGED", context, organizationId: device.organizationId,
    targetType: "device", targetId: device.id, req,
    metadata: { hostname: device.hostname, previous_site_id: device.siteId, new_site_id: parsed.data.site_id },
  });
  res.json({ id: updated.id, organization_id: updated.organizationId, site_id: updated.siteId });
});

router.post("/v1/agents/enroll", async (req, res): Promise<void> => {
  const parsed = EnrollAgentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!/^[a-f0-9]{64}$/i.test(parsed.data.machine_guid_hash)) { res.status(400).json({ error: "machine_guid_hash must be a SHA-256 hexadecimal digest" }); return; }
  const enrollmentHash = crypto.createHash("sha256").update(parsed.data.enrollment_token).digest("hex");
  const now = new Date();
  // Consuming the token also reads back the tenant it belongs to. Nothing from
  // the request body participates in this decision: an agent cannot choose or
  // influence its organization or site (§G, §AU).
  const consumed = await db.update(enrollmentTokensTable)
    .set({ uses: sql`${enrollmentTokensTable.uses} + 1` })
    .where(and(
      eq(enrollmentTokensTable.tokenHash, enrollmentHash),
      eq(enrollmentTokensTable.active, true),
      sql`${enrollmentTokensTable.revokedAt} is null`,
      sql`${enrollmentTokensTable.expiresAt} > ${now}`,
      sql`${enrollmentTokensTable.uses} < ${enrollmentTokensTable.maxUses}`,
    ))
    .returning({
      id: enrollmentTokensTable.id,
      organizationId: enrollmentTokensTable.organizationId,
      siteId: enrollmentTokensTable.siteId,
      legacyOrganization: enrollmentTokensTable.legacyOrganization,
    });
  if (!consumed.length) { res.status(401).json({ error: "Invalid, expired, revoked, or exhausted enrollment token" }); return; }
  const token = consumed[0]!;

  // A suspended or archived organization accepts no new endpoints (§AL).
  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, token.organizationId));
  if (!organization || organization.status !== "ACTIVE") {
    res.status(403).json({ error: "Enrollment is not permitted for this organization" });
    return;
  }

  const existing = await db.select().from(devicesTable).where(eq(devicesTable.deviceUuid, parsed.data.device_uuid));
  const device = existing[0] ?? (await db.insert(devicesTable).values({
    agentId: `NX-${String(Number((await db.select({ count: sql<number>`count(*)` }).from(devicesTable))[0]?.count ?? 0) + 1).padStart(6, "0")}`,
    deviceUuid: parsed.data.device_uuid, hostname: parsed.data.hostname, agentVersion: parsed.data.agent_version, machineGuidHash: parsed.data.machine_guid_hash,
    organizationId: token.organizationId,
    siteId: token.siteId,
    legacyOrganization: token.legacyOrganization,
  }).returning())[0];

  // Re-enrolment of a known device never moves it between tenants; that would
  // be a tenant transfer, which the ordinary APIs do not permit (§W).
  if (existing.length && device.organizationId !== token.organizationId) {
    res.status(409).json({ error: "Device is already enrolled in a different organization" });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString("base64url");
  await db.update(agentCredentialsTable).set({ revokedAt: now }).where(and(eq(agentCredentialsTable.deviceId, device.id), sql`${agentCredentialsTable.revokedAt} is null`));
  await db.insert(agentCredentialsTable).values({ deviceId: device.id, tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex") });
  await recordAudit({
    action: "AGENT_ENROLLED", actorLabel: "agent-enrollment", organizationId: device.organizationId,
    targetType: "device", targetId: device.id, subjectId: device.id, req,
    metadata: { agent_id: device.agentId, hostname: device.hostname, enrollment_token_id: token.id, site_id: device.siteId },
  });
  if (!existing.length) await db.insert(activityTable).values({ deviceId: device.id, event: "AGENT_ENROLLED" });
  res.status(201).json(EnrollAgentResponse.parse({ agent_id: device.agentId, device_id: device.id, agent_token: rawToken, api_base_url: process.env.API_BASE_URL ?? "/api", heartbeat_interval_seconds: 30 }));
});

router.post("/v1/agents/heartbeat", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req);
  if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = AgentHeartbeatPayload.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  await db.update(devicesTable).set({ agentVersion: parsed.data.agent_version, currentUser: parsed.data.logged_in_user, capabilities: parsed.data.capabilities ?? device.capabilities }).where(eq(devicesTable.id, device.id));
  await markOnline(device);
  res.sendStatus(204);
});

router.post("/v1/agents/inventory", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req);
  if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = InventoryPayload.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    req.log.warn({ validation: issues, issue_count: parsed.error.issues.length }, "AgentInventoryRejected");
    res.status(400).json({ error: "Inventory payload validation failed", issues, issue_count: parsed.error.issues.length });
    return;
  }
  if (parsed.data.device_uuid !== device.deviceUuid) { res.status(403).json({ error: "Device identity does not match agent credential" }); return; }
  const ipAddress = parsed.data.network[0]?.ipv4;
  const os = parsed.data.os;
  await db.update(devicesTable).set({ hostname: parsed.data.hostname, agentVersion: parsed.data.agent_version, currentUser: parsed.data.current_user, domain: parsed.data.domain, ipAddress, osName: os.name, osVersion: os.version, osBuild: os.build, architecture: os.architecture, hardware: parsed.data.hardware, disks: parsed.data.disks, network: parsed.data.network, updatedAt: new Date() }).where(eq(devicesTable.id, device.id));
  if (parsed.data.disks.length) {
    const receivedAt = new Date();
    await db.insert(diskMetricsTable).values(parsed.data.disks.map((disk) => ({
      deviceId: device.id, volume: disk.drive, filesystem: disk.filesystem,
      totalBytes: disk.total_bytes, usedBytes: disk.used_bytes, freeBytes: disk.free_bytes,
      usedPercent: disk.used_percent, receivedAt,
    })));
  }
  await db.insert(activityTable).values({ deviceId: device.id, event: "Inventory updated" });
  if (parsed.data.software) {
    const result = await reconcileSoftwareSnapshot(device.id, parsed.data.software);
    req.log.info({ device: device.id, present: result.present, installed: result.installed, removed: result.removed, version_changed: result.versionChanged, baseline: result.baseline, skipped: result.skipped }, "SoftwareInventoryReconciled");
  }
  await markOnline(device);
  res.sendStatus(204);
});

router.post("/v1/agents/metrics", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req);
  if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = MetricsPayload.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const receivedAt = new Date();
  const [metric] = await db.insert(metricsTable).values({ deviceId: device.id, capturedAt: new Date(parsed.data.captured_at), receivedAt, cpuPercent: parsed.data.cpu_percent, ramPercent: parsed.data.ram_percent, ramUsedBytes: parsed.data.ram_used_bytes, ramAvailableBytes: parsed.data.ram_available_bytes, diskPercent: parsed.data.disk_percent, uptimeSeconds: parsed.data.uptime_seconds }).returning({ id: metricsTable.id });
  if (parsed.data.disks?.length) {
    await db.insert(diskMetricsTable).values(parsed.data.disks.map((disk) => ({
      deviceId: device.id, metricId: metric.id, volume: disk.drive, filesystem: disk.filesystem,
      totalBytes: disk.total_bytes, usedBytes: disk.used_bytes, freeBytes: disk.free_bytes,
      usedPercent: disk.used_percent, capturedAt: new Date(parsed.data.captured_at), receivedAt,
    })));
  }
  await markOnline(device);
  res.sendStatus(204);
});

router.post("/v1/agents/services/snapshot", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req); if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = ServiceSnapshot.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: "Invalid services snapshot" }); return; }
  const result = await reconcileServices(device.id, parsed.data); await markOnline(device);
  req.log.info({ device: device.id, snapshot_id: parsed.data.snapshot_id, ...result }, "ServicesSnapshotReconciled"); res.sendStatus(204);
});

router.post("/v1/agents/processes/snapshot", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req); if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = ProcessSnapshot.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: "Invalid processes snapshot" }); return; }
  const result = await reconcileProcesses(device.id, parsed.data); await markOnline(device);
  req.log.info({ device: device.id, snapshot_id: parsed.data.snapshot_id, ...result }, "ProcessesSnapshotReconciled"); res.sendStatus(204);
});

export default router;
