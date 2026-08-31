import { and, eq, inArray, sql } from "drizzle-orm";
import { activityTable, alertsTable, db, devicesTable, pool } from "@workspace/db";
import { configuredDeviceState } from "../lib/device-state";
import type { DeviceState } from "../lib/device-state";
import { evaluateDisks, evaluateOffline, evaluateSustained, type RecentDiskMetric, type RecentMetric } from "./evaluation.ts";
import type { AlertSignal } from "./policy.ts";
import { recordAlertEvent } from "../notifications/outbox.ts";

const ACTIVE_STATES = ["OPEN", "ACKNOWLEDGED"] as const;

type MetricRow = { device_id: string; cpu_percent: number; ram_percent: number; received_at: Date };
type DiskRow = { device_id: string; volume: string; used_percent: number; received_at: Date };

async function persistDeviceSignals(device: typeof devicesTable.$inferSelect, status: DeviceState, signals: AlertSignal[], active: Map<string, typeof alertsTable.$inferSelect>, now: Date) {
  return db.transaction(async (tx) => {
    const eventDevice = { id: device.id, hostname: device.hostname, status };
    let createdCount = 0;
    let updatedCount = 0;
    let resolvedCount = 0;
    if (status !== "UNKNOWN" && status !== device.status) {
      const [transitioned] = await tx.update(devicesTable).set({ status, updatedAt: now }).where(and(eq(devicesTable.id, device.id), eq(devicesTable.status, device.status))).returning({ id: devicesTable.id });
      if (transitioned) await tx.insert(activityTable).values({ deviceId: device.id, event: `${device.status}_TO_${status}`, timestamp: now });
    }
    for (const signal of signals) {
      const current = active.get(signal.dedupKey);
      if (signal.decision === "trigger" && signal.severity) {
        if (!current) {
          const [created] = await tx.insert(alertsTable).values({
            // Tenant ownership is copied from the device, which is the
            // authoritative boundary; the engine never derives it any other way.
            organizationId: device.organizationId, legacyOrganization: device.legacyOrganization,
            deviceId: device.id, type: signal.type, severity: signal.severity,
            resource: signal.resource, title: signal.title, summary: signal.summary, dedupKey: signal.dedupKey,
            triggerValue: signal.value, thresholdValue: signal.threshold, openedAt: now, lastTriggeredAt: now,
          }).onConflictDoNothing().returning();
          if (created) {
            await recordAlertEvent(tx, { alertId: created.id, eventType: "CREATED", newState: "OPEN", newSeverity: created.severity }, created, eventDevice, now);
            active.set(created.dedupKey, created);
            createdCount += 1;
          }
          continue;
        }
        const severity = current.severity === "critical" || signal.severity === "critical" ? "critical" : "warning";
        const [updated] = await tx.update(alertsTable).set({
          severity, summary: signal.summary, triggerValue: signal.value, thresholdValue: signal.threshold,
          lastTriggeredAt: now, occurrenceCount: sql`${alertsTable.occurrenceCount} + 1`, updatedAt: now,
        }).where(eq(alertsTable.id, current.id)).returning();
        if (updated) active.set(updated.dedupKey, updated);
        if (severity !== current.severity) await recordAlertEvent(tx, { alertId: current.id, eventType: "SEVERITY_CHANGED", previousSeverity: current.severity, newSeverity: severity }, updated, eventDevice, now);
        updatedCount += 1;
      } else if ((signal.decision === "recover" || signal.decision === "unavailable") && current) {
        const [resolved] = await tx.update(alertsTable).set({ state: "RESOLVED", resolvedAt: now, updatedAt: now }).where(and(eq(alertsTable.id, current.id), inArray(alertsTable.state, ACTIVE_STATES))).returning();
        if (resolved) {
          await recordAlertEvent(tx, { alertId: resolved.id, eventType: "RESOLVED", previousState: current.state, newState: "RESOLVED", metadata: { reason: signal.decision === "unavailable" ? "TELEMETRY_STALE" : "CONDITION_RECOVERED" } }, resolved, eventDevice, now);
          active.delete(signal.dedupKey);
          resolvedCount += 1;
        }
      }
    }
    return { createdCount, updatedCount, resolvedCount };
  });
}

export async function evaluateAlerts(now = new Date(), onDeviceError?: (deviceId: string, error: unknown) => void) {
  const [devices, activeAlerts, metricResult, diskResult] = await Promise.all([
    db.select().from(devicesTable),
    db.select().from(alertsTable).where(inArray(alertsTable.state, ACTIVE_STATES)),
    pool.query<MetricRow>(`SELECT device_id, cpu_percent, ram_percent, received_at FROM (
      SELECT device_id, cpu_percent, ram_percent, received_at,
        row_number() OVER (PARTITION BY device_id ORDER BY received_at DESC) sample_number
      FROM nexora_device_metrics WHERE received_at >= $1
    ) recent WHERE sample_number <= 5 ORDER BY device_id, received_at DESC`, [new Date(now.getTime() - 180_000)]),
    pool.query<DiskRow>(`SELECT DISTINCT ON (device_id, volume) device_id, volume, used_percent, received_at
      FROM nexora_disk_metrics WHERE received_at >= $1 ORDER BY device_id, volume, received_at DESC`, [new Date(now.getTime() - 90_000)]),
  ]);
  const metrics = new Map<string, RecentMetric[]>();
  for (const row of metricResult.rows) metrics.set(row.device_id, [...(metrics.get(row.device_id) ?? []), { cpuPercent: row.cpu_percent, ramPercent: row.ram_percent, receivedAt: row.received_at }]);
  const disks = new Map<string, RecentDiskMetric[]>();
  for (const row of diskResult.rows) disks.set(row.device_id, [...(disks.get(row.device_id) ?? []), { volume: row.volume, usedPercent: row.used_percent, receivedAt: row.received_at }]);
  const active = new Map(activeAlerts.map((alert) => [alert.dedupKey, alert]));
  const totals = { devicesEvaluated: 0, devicesFailed: 0, alertsCreated: 0, alertsUpdated: 0, alertsResolved: 0 };
  for (const device of devices) {
    const status = configuredDeviceState(device.lastSeenAt, now.getTime());
    const signals = [evaluateOffline(device.id, status === "OFFLINE"), ...evaluateSustained(device.id, metrics.get(device.id) ?? [], now), ...evaluateDisks(device.id, disks.get(device.id) ?? [], now)];
    const represented = new Set(signals.map((signal) => signal.dedupKey));
    for (const alert of activeAlerts.filter((item) => item.deviceId === device.id && item.type === "DISK_HIGH" && !represented.has(item.dedupKey))) {
      signals.push({ type: "DISK_HIGH", resource: alert.resource, dedupKey: alert.dedupKey, decision: "unavailable", title: alert.title, summary: "Recent volume telemetry is unavailable." });
    }
    try {
      const result = await persistDeviceSignals(device, status, signals, active, now);
      totals.devicesEvaluated += 1;
      totals.alertsCreated += result.createdCount;
      totals.alertsUpdated += result.updatedCount;
      totals.alertsResolved += result.resolvedCount;
    } catch (error) {
      totals.devicesFailed += 1;
      onDeviceError?.(device.id, error);
    }
  }
  return totals;
}
