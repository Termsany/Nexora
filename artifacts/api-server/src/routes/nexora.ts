import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { deviceState } from "../lib/device-state";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, activityTable, agentCredentialsTable, auditLogTable, devicesTable, enrollmentTokensTable, metricsTable } from "@workspace/db";
import {
  EnrollAgentBody,
  EnrollAgentResponse,
  GetDashboardActivityResponse,
  GetDashboardSummaryResponse,
  GetDeviceParams,
  GetDeviceResponse,
  GetDeviceMetricsParams,
  GetDeviceMetricsResponse,
  ListDevicesQueryParams,
  ListDevicesResponse,
  PostHeartbeatBody,
  PostInventoryBody,
  PostMetricsBody,
} from "@workspace/api-zod";

const router: IRouter = Router();
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
});

function statusFor(lastSeenAt: Date | null): "ONLINE" | "OFFLINE" | "UNKNOWN" {
  return deviceState(lastSeenAt, Date.now(), ONLINE_SECONDS, OFFLINE_SECONDS);
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

function publicDevice(device: typeof devicesTable.$inferSelect, latest?: typeof metricsTable.$inferSelect) {
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

router.get("/v1/dashboard/summary", async (_req, res): Promise<void> => {
  await reconcileOfflineTransitions();
  const devices = await db.select().from(devicesTable);
  const metrics = await db.select().from(metricsTable).orderBy(desc(metricsTable.receivedAt)).limit(500);
  const latestByDevice = new Map<string, typeof metrics[number]>();
  for (const metric of metrics) if (!latestByDevice.has(metric.deviceId)) latestByDevice.set(metric.deviceId, metric);
  const statuses = devices.map((device) => statusFor(device.lastSeenAt));
  const cpu = [...latestByDevice.values()].map((metric) => metric.cpuPercent);
  const ram = [...latestByDevice.values()].map((metric) => metric.ramPercent);
  const result = {
    total_devices: devices.length,
    online_devices: statuses.filter((value) => value === "ONLINE").length,
    offline_devices: statuses.filter((value) => value === "OFFLINE").length,
    unknown_devices: statuses.filter((value) => value === "UNKNOWN").length,
    average_cpu: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0,
    average_ram: ram.length ? ram.reduce((a, b) => a + b, 0) / ram.length : 0,
    disks_over_threshold: [...latestByDevice.values()].filter((metric) => metric.diskPercent >= 85).length,
  };
  res.json(GetDashboardSummaryResponse.parse(result));
});

router.get("/v1/dashboard/activity", async (_req, res): Promise<void> => {
  await reconcileOfflineTransitions();
  const rows = await db.select({ activity: activityTable, hostname: devicesTable.hostname })
    .from(activityTable).innerJoin(devicesTable, eq(activityTable.deviceId, devicesTable.id))
    .orderBy(desc(activityTable.timestamp)).limit(12);
  res.json(GetDashboardActivityResponse.parse(rows.map(({ activity, hostname }) => ({
    id: activity.id, device_id: activity.deviceId, hostname, event: activity.event, timestamp: activity.timestamp,
  }))));
});

router.get("/v1/devices", async (req, res): Promise<void> => {
  await reconcileOfflineTransitions();
  const parsed = ListDevicesQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { search, status, page, page_size: pageSize } = parsed.data;
  const devices = await db.select().from(devicesTable).orderBy(desc(devicesTable.updatedAt));
  const filtered = devices.filter((device) => {
    const matchesSearch = !search || [device.hostname, device.agentId, device.ipAddress].some((value) => value?.toLowerCase().includes(search.toLowerCase()));
    return matchesSearch && (!status || statusFor(device.lastSeenAt) === status);
  });
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  const metrics = await db.select().from(metricsTable).orderBy(desc(metricsTable.receivedAt));
  const latest = new Map<string, typeof metrics[number]>();
  for (const metric of metrics) if (!latest.has(metric.deviceId)) latest.set(metric.deviceId, metric);
  res.json(ListDevicesResponse.parse({ items: pageItems.map((device) => publicDevice(device, latest.get(device.id))), page, page_size: pageSize, total: filtered.length }));
});

router.get("/v1/devices/:device_id", async (req, res): Promise<void> => {
  await reconcileOfflineTransitions();
  const params = GetDeviceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, params.data.device_id));
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }
  const [latest] = await db.select().from(metricsTable).where(eq(metricsTable.deviceId, device.id)).orderBy(desc(metricsTable.receivedAt)).limit(1);
  res.json(GetDeviceResponse.parse({ ...publicDevice(device, latest), hardware: device.hardware ?? {}, disks: device.disks ?? [], network: device.network ?? [] }));
});

router.get("/v1/devices/:device_id/metrics", async (req, res): Promise<void> => {
  const params = GetDeviceMetricsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const metrics = await db.select().from(metricsTable).where(eq(metricsTable.deviceId, params.data.device_id)).orderBy(desc(metricsTable.capturedAt)).limit(48);
  res.json(GetDeviceMetricsResponse.parse(metrics.reverse().map((metric) => ({
    captured_at: metric.capturedAt, received_at: metric.receivedAt, cpu_percent: metric.cpuPercent, ram_percent: metric.ramPercent,
    ram_used_bytes: metric.ramUsedBytes, ram_available_bytes: metric.ramAvailableBytes, disk_percent: metric.diskPercent, uptime_seconds: metric.uptimeSeconds,
  }))));
});

router.post("/v1/agents/enroll", async (req, res): Promise<void> => {
  const parsed = EnrollAgentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!/^[a-f0-9]{64}$/i.test(parsed.data.machine_guid_hash)) { res.status(400).json({ error: "machine_guid_hash must be a SHA-256 hexadecimal digest" }); return; }
  const enrollmentHash = crypto.createHash("sha256").update(parsed.data.enrollment_token).digest("hex");
  const now = new Date();
  const consumed = await db.update(enrollmentTokensTable)
    .set({ uses: sql`${enrollmentTokensTable.uses} + 1` })
    .where(and(
      eq(enrollmentTokensTable.tokenHash, enrollmentHash),
      eq(enrollmentTokensTable.active, true),
      sql`${enrollmentTokensTable.revokedAt} is null`,
      sql`${enrollmentTokensTable.expiresAt} > ${now}`,
      sql`${enrollmentTokensTable.uses} < ${enrollmentTokensTable.maxUses}`,
    ))
    .returning({ id: enrollmentTokensTable.id });
  if (!consumed.length) { res.status(401).json({ error: "Invalid, expired, revoked, or exhausted enrollment token" }); return; }
  const existing = await db.select().from(devicesTable).where(eq(devicesTable.deviceUuid, parsed.data.device_uuid));
  const device = existing[0] ?? (await db.insert(devicesTable).values({
    agentId: `NX-${String(Number((await db.select({ count: sql<number>`count(*)` }).from(devicesTable))[0]?.count ?? 0) + 1).padStart(6, "0")}`,
    deviceUuid: parsed.data.device_uuid, hostname: parsed.data.hostname, agentVersion: parsed.data.agent_version, machineGuidHash: parsed.data.machine_guid_hash,
  }).returning())[0];
  const token = crypto.randomBytes(32).toString("base64url");
  await db.update(agentCredentialsTable).set({ revokedAt: now }).where(and(eq(agentCredentialsTable.deviceId, device.id), sql`${agentCredentialsTable.revokedAt} is null`));
  await db.insert(agentCredentialsTable).values({ deviceId: device.id, tokenHash: crypto.createHash("sha256").update(token).digest("hex") });
  await db.insert(auditLogTable).values({ action: "AGENT_ENROLLED", subjectId: device.id, metadata: { agent_id: device.agentId } });
  res.status(201).json(EnrollAgentResponse.parse({ agent_id: device.agentId, device_id: device.id, agent_token: token, api_base_url: process.env.API_BASE_URL ?? "/api", heartbeat_interval_seconds: 30 }));
});

router.post("/v1/agents/heartbeat", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req);
  if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = PostHeartbeatBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  await db.update(devicesTable).set({ agentVersion: parsed.data.agent_version, currentUser: parsed.data.logged_in_user }).where(eq(devicesTable.id, device.id));
  await markOnline(device);
  res.sendStatus(204);
});

router.post("/v1/agents/inventory", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req);
  if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = InventoryPayload.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (parsed.data.device_uuid !== device.deviceUuid) { res.status(403).json({ error: "Device identity does not match agent credential" }); return; }
  const ipAddress = parsed.data.network[0]?.ipv4;
  const os = parsed.data.os;
  await db.update(devicesTable).set({ hostname: parsed.data.hostname, agentVersion: parsed.data.agent_version, currentUser: parsed.data.current_user, domain: parsed.data.domain, ipAddress, osName: os.name, osVersion: os.version, osBuild: os.build, architecture: os.architecture, hardware: parsed.data.hardware, disks: parsed.data.disks, network: parsed.data.network, updatedAt: new Date() }).where(eq(devicesTable.id, device.id));
  await db.insert(activityTable).values({ deviceId: device.id, event: "Inventory updated" });
  await markOnline(device);
  res.sendStatus(204);
});

router.post("/v1/agents/metrics", async (req, res): Promise<void> => {
  const device = await authenticatedDevice(req);
  if (!device) { res.status(401).json({ error: "Invalid agent credentials" }); return; }
  const parsed = PostMetricsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  await db.insert(metricsTable).values({ deviceId: device.id, capturedAt: new Date(parsed.data.captured_at), cpuPercent: parsed.data.cpu_percent, ramPercent: parsed.data.ram_percent, ramUsedBytes: parsed.data.ram_used_bytes, ramAvailableBytes: parsed.data.ram_available_bytes, diskPercent: parsed.data.disk_percent, uptimeSeconds: parsed.data.uptime_seconds });
  await markOnline(device);
  res.sendStatus(204);
});

export default router;
