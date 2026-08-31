import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { activityTable, db, diskMetricAggregatesTable, diskMetricsTable, metricAggregatesTable, metricsTable, pool } from "@workspace/db";
import { configuredDeviceState } from "../lib/device-state";
import { classifyHealth, downtimeSummary } from "../telemetry/monitoring";
import { groupDiskPoints, historicalRange } from "../telemetry/history-query";
import { can, requireTenantContext } from "../tenancy/context.ts";
import { findDeviceInScope, organizationScope, tenantSqlClause } from "../tenancy/scope.ts";

const router: IRouter = Router();

router.use("/v1/devices/:device_id/metrics", requireTenantContext);
router.use("/v1/devices/:device_id/monitoring", requireTenantContext);
router.use("/v1/dashboard/health", requireTenantContext);

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  resolution: z.enum(["raw", "hour", "day", "auto"]).default("auto"),
});

function parseRange(query: unknown) {
  const parsed = rangeSchema.safeParse(query);
  if (!parsed.success) return { error: parsed.error.message } as const;
  try { return historicalRange(parsed.data); } catch (error) { return { error: error instanceof Error ? error.message : "Invalid historical range" } as const; }
}

router.get("/v1/devices/:device_id/metrics", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "telemetry:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const deviceId = z.string().uuid().safeParse(req.params.device_id);
  if (!deviceId.success) { res.status(400).json({ error: "Invalid device ID" }); return; }
  const range = parseRange(req.query);
  if ("error" in range) { res.status(400).json({ error: range.error }); return; }
  // Ownership is resolved through the device before any history is read, so no
  // metric row can be returned for a device outside the caller's tenant (§S).
  const device = await findDeviceInScope(context, deviceId.data);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }

  if (range.resolution === "raw") {
    const [metrics, disks] = await Promise.all([
      db.select().from(metricsTable).where(and(eq(metricsTable.deviceId, device.id), gte(metricsTable.receivedAt, range.from), lte(metricsTable.receivedAt, range.to))).orderBy(asc(metricsTable.receivedAt)).limit(20160),
      db.select().from(diskMetricsTable).where(and(eq(diskMetricsTable.deviceId, device.id), gte(diskMetricsTable.receivedAt, range.from), lte(diskMetricsTable.receivedAt, range.to))).orderBy(asc(diskMetricsTable.receivedAt)).limit(250000),
    ]);
    res.json({
      resolution: range.resolution, from: range.from, to: range.to,
      points: metrics.map((item) => ({ timestamp: item.receivedAt, captured_at: item.capturedAt, cpu_avg: item.cpuPercent, cpu_min: item.cpuPercent, cpu_max: item.cpuPercent, ram_avg: item.ramPercent, ram_min: item.ramPercent, ram_max: item.ramPercent, ram_used_avg_bytes: item.ramUsedBytes, ram_available_avg_bytes: item.ramAvailableBytes, uptime_seconds: item.uptimeSeconds, sample_count: 1 })),
      disks: groupDiskPoints(disks.map((item) => ({ volume: item.volume, timestamp: item.receivedAt, usage_avg: item.usedPercent, usage_min: item.usedPercent, usage_max: item.usedPercent, usage_latest: item.usedPercent, total_bytes: item.totalBytes, used_bytes: item.usedBytes, free_bytes: item.freeBytes, sample_count: 1 }))),
    });
    return;
  }

  const [metrics, disks] = await Promise.all([
    db.select().from(metricAggregatesTable).where(and(eq(metricAggregatesTable.deviceId, device.id), eq(metricAggregatesTable.resolution, range.resolution), gte(metricAggregatesTable.bucketAt, range.from), lte(metricAggregatesTable.bucketAt, range.to))).orderBy(asc(metricAggregatesTable.bucketAt)).limit(range.resolution === "hour" ? 2160 : 365),
    db.select().from(diskMetricAggregatesTable).where(and(eq(diskMetricAggregatesTable.deviceId, device.id), eq(diskMetricAggregatesTable.resolution, range.resolution), gte(diskMetricAggregatesTable.bucketAt, range.from), lte(diskMetricAggregatesTable.bucketAt, range.to))).orderBy(asc(diskMetricAggregatesTable.bucketAt)).limit(range.resolution === "hour" ? 8640 : 1460),
  ]);
  res.json({
    resolution: range.resolution, from: range.from, to: range.to,
    points: metrics.map((item) => ({ timestamp: item.bucketAt, cpu_avg: item.cpuAvg, cpu_min: item.cpuMin, cpu_max: item.cpuMax, ram_avg: item.ramAvg, ram_min: item.ramMin, ram_max: item.ramMax, ram_used_avg_bytes: item.ramUsedAvgBytes, ram_available_avg_bytes: item.ramAvailableAvgBytes, uptime_seconds: item.uptimeLatestSeconds, sample_count: item.sampleCount })),
    disks: groupDiskPoints(disks.map((item) => ({ volume: item.volume, timestamp: item.bucketAt, usage_avg: item.usageAvg, usage_min: item.usageMin, usage_max: item.usageMax, usage_latest: item.usageLatest, total_bytes: item.totalBytesLatest, used_bytes: item.usedBytesLatest, free_bytes: item.freeBytesLatest, sample_count: item.sampleCount }))),
  });
});

router.get("/v1/devices/:device_id/monitoring", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "telemetry:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const deviceId = z.string().uuid().safeParse(req.params.device_id);
  if (!deviceId.success) { res.status(400).json({ error: "Invalid device ID" }); return; }
  const device = await findDeviceInScope(context, deviceId.data);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }

  const [recent, events, activity] = await Promise.all([
    db.select().from(metricsTable).where(eq(metricsTable.deviceId, device.id)).orderBy(desc(metricsTable.receivedAt)).limit(5),
    db.select({ event: activityTable.event, timestamp: activityTable.timestamp }).from(activityTable).where(and(eq(activityTable.deviceId, device.id), inArray(activityTable.event, ["ONLINE_TO_OFFLINE", "OFFLINE_TO_ONLINE"]))).orderBy(asc(activityTable.timestamp)),
    db.select({ id: activityTable.id, event: activityTable.event, timestamp: activityTable.timestamp }).from(activityTable).where(eq(activityTable.deviceId, device.id)).orderBy(desc(activityTable.timestamp)).limit(50),
  ]);
  const status = configuredDeviceState(device.lastSeenAt);
  res.json({ status, health: classifyHealth(status, recent), downtime: downtimeSummary(events), activity });
});

router.get("/v1/dashboard/health", async (req, res): Promise<void> => {
  const context = req.tenant!;
  if (!can(context, "telemetry:read")) { res.status(403).json({ error: "Insufficient permissions" }); return; }
  const requested = typeof req.query.organization_id === "string" ? req.query.organization_id : undefined;
  const scope = organizationScope(context, requested);
  if (!scope.ok) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const values: unknown[] = [];
  const tenant = tenantSqlClause("d.organization_id", scope.organizationIds, values);
  const devices = await pool.query<{ id: string; hostname: string; last_seen_at: Date | null }>(
    `SELECT d.id, d.hostname, d.last_seen_at FROM nexora_devices d WHERE ${tenant}`, values);

  // The recent-metrics window is restricted to the scoped devices as well, so
  // the ranked "highest CPU/memory/disk" lists cannot surface another tenant.
  const metricValues: unknown[] = [];
  const metricTenant = tenantSqlClause("d.organization_id", scope.organizationIds, metricValues);
  const result = await pool.query<{ device_id: string; cpu_percent: number; ram_percent: number; disk_percent: number; received_at: Date }>(`
    SELECT device_id, cpu_percent, ram_percent, disk_percent, received_at
    FROM (
      SELECT m.device_id, m.cpu_percent, m.ram_percent, m.disk_percent, m.received_at,
        row_number() OVER (PARTITION BY m.device_id ORDER BY m.received_at DESC) AS sample_number
      FROM nexora_device_metrics m
      JOIN nexora_devices d ON d.id = m.device_id
      WHERE ${metricTenant}
    ) recent WHERE sample_number <= 5
    ORDER BY device_id, received_at DESC`, metricValues);

  const recentByDevice = new Map<string, typeof result.rows>();
  for (const metric of result.rows) recentByDevice.set(metric.device_id, [...(recentByDevice.get(metric.device_id) ?? []), metric]);
  const rows = devices.rows.map((device) => {
    const recent = recentByDevice.get(device.id) ?? [];
    const status = configuredDeviceState(device.last_seen_at);
    const health = classifyHealth(status, recent.map((metric) => ({ cpuPercent: metric.cpu_percent, ramPercent: metric.ram_percent, diskPercent: metric.disk_percent })));
    const latest = recent[0];
    const cpu = recent.length ? recent.reduce((sum, metric) => sum + metric.cpu_percent, 0) / recent.length : null;
    const memory = recent.length ? recent.reduce((sum, metric) => sum + metric.ram_percent, 0) / recent.length : null;
    return { id: device.id, hostname: device.hostname, status, health, cpu_percent: cpu, ram_percent: memory, disk_percent: latest?.disk_percent ?? null, last_seen_at: device.last_seen_at };
  });
  const ranked = (key: "cpu_percent" | "ram_percent" | "disk_percent") => rows.filter((row) => row[key] != null).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 5);
  res.json({
    warning_devices: rows.filter((row) => row.health === "WARNING").length,
    critical_devices: rows.filter((row) => row.health === "CRITICAL").length,
    devices: rows,
    highest_cpu: ranked("cpu_percent"), highest_memory: ranked("ram_percent"), highest_disk: ranked("disk_percent"),
  });
});

export default router;
