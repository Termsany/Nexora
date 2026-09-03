import { ALERT_THRESHOLDS, METRIC_FRESHNESS_SECONDS, SUSTAINED_SAMPLE_COUNT, SUSTAINED_WINDOW_MAX_AGE_SECONDS, type AlertSeverity, type AlertSignal } from "./policy.ts";

export type RecentMetric = { cpuPercent: number; ramPercent: number; receivedAt: Date };
export type RecentDiskMetric = { volume: string; usedPercent: number; receivedAt: Date };

function resourceDecision(value: number, thresholds: { warning: number; critical: number; recovery: number }) {
  if (value >= thresholds.critical) return { decision: "trigger" as const, severity: "critical" as AlertSeverity, threshold: thresholds.critical };
  if (value >= thresholds.warning) return { decision: "trigger" as const, severity: "warning" as AlertSeverity, threshold: thresholds.warning };
  if (value < thresholds.recovery) return { decision: "recover" as const, threshold: thresholds.recovery };
  return { decision: "hold" as const, threshold: thresholds.warning };
}

export function evaluateOffline(deviceId: string, offline: boolean): AlertSignal {
  return {
    type: "DEVICE_OFFLINE", resource: null, dedupKey: `DEVICE_OFFLINE:${deviceId}`,
    decision: offline ? "trigger" : "recover", severity: offline ? "critical" : undefined,
    title: "Device offline", summary: offline ? "The endpoint is no longer reporting." : "The endpoint resumed reporting.",
  };
}

export function evaluateSustained(deviceId: string, metrics: RecentMetric[], now = new Date()): AlertSignal[] {
  const ordered = [...metrics].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()).slice(0, SUSTAINED_SAMPLE_COUNT);
  const fresh = ordered.length === SUSTAINED_SAMPLE_COUNT
    && now.getTime() - ordered[0]!.receivedAt.getTime() <= METRIC_FRESHNESS_SECONDS * 1000
    && now.getTime() - ordered.at(-1)!.receivedAt.getTime() <= SUSTAINED_WINDOW_MAX_AGE_SECONDS * 1000;
  const create = (kind: "cpu" | "memory", type: "CPU_HIGH" | "MEMORY_HIGH", label: string): AlertSignal => {
    const dedupKey = `${type}:${deviceId}`;
    if (!fresh) return { type, resource: null, dedupKey, decision: "unavailable", title: `${label} sustained high`, summary: "Recent telemetry is unavailable." };
    const value = ordered.reduce((sum, metric) => sum + (kind === "cpu" ? metric.cpuPercent : metric.ramPercent), 0) / ordered.length;
    const result = resourceDecision(value, ALERT_THRESHOLDS[kind]);
    return { type, resource: null, dedupKey, ...result, value, title: `${label} sustained high`, summary: `Latest five-sample ${label.toLowerCase()} average is ${value.toFixed(1)}%.` };
  };
  return [create("cpu", "CPU_HIGH", "CPU"), create("memory", "MEMORY_HIGH", "Memory")];
}

export function evaluateDisks(deviceId: string, disks: RecentDiskMetric[], now = new Date()): AlertSignal[] {
  const latest = new Map<string, RecentDiskMetric>();
  for (const disk of [...disks].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())) if (!latest.has(disk.volume)) latest.set(disk.volume, disk);
  return [...latest.values()].map((disk) => {
    const dedupKey = `DISK_HIGH:${deviceId}:${disk.volume}`;
    if (now.getTime() - disk.receivedAt.getTime() > METRIC_FRESHNESS_SECONDS * 1000) return { type: "DISK_HIGH", resource: disk.volume, dedupKey, decision: "unavailable", title: `Disk ${disk.volume} usage high`, summary: "Recent volume telemetry is unavailable." };
    const result = resourceDecision(disk.usedPercent, ALERT_THRESHOLDS.disk);
    return { type: "DISK_HIGH", resource: disk.volume, dedupKey, ...result, value: disk.usedPercent, title: `Disk ${disk.volume} usage high`, summary: `Disk ${disk.volume} usage is ${disk.usedPercent.toFixed(1)}%.` };
  });
}
