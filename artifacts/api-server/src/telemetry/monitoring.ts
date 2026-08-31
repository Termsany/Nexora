import type { DeviceState } from "../lib/device-state";

export type HealthState = "HEALTHY" | "WARNING" | "CRITICAL" | "OFFLINE" | "UNKNOWN";
export type HealthMetric = { cpuPercent: number; ramPercent: number; diskPercent: number };

export function classifyHealth(status: DeviceState, recent: HealthMetric[]): HealthState {
  if (status === "OFFLINE") return "OFFLINE";
  if (status === "UNKNOWN") return "UNKNOWN";
  if (!recent.length) return "UNKNOWN";
  const window = recent.slice(0, 5);
  const cpu = window.reduce((total, item) => total + item.cpuPercent, 0) / window.length;
  const ram = window.reduce((total, item) => total + item.ramPercent, 0) / window.length;
  const disk = recent[0]!.diskPercent;
  if (cpu >= 95 || ram >= 95 || disk >= 95) return "CRITICAL";
  if (cpu >= 80 || ram >= 80 || disk >= 85) return "WARNING";
  return "HEALTHY";
}

export type StatusEvent = { event: string; timestamp: Date };
export function downtimeSummary(events: StatusEvent[], now = new Date()) {
  const ordered = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let lastOffline: Date | null = null;
  let lastRecovery: Date | null = null;
  let lastCompletedDurationSeconds: number | null = null;
  let openOffline: Date | null = null;
  for (const event of ordered) {
    if (event.event === "ONLINE_TO_OFFLINE") {
      lastOffline = event.timestamp;
      openOffline = event.timestamp;
    } else if (event.event === "OFFLINE_TO_ONLINE") {
      lastRecovery = event.timestamp;
      if (openOffline) lastCompletedDurationSeconds = Math.max(0, (event.timestamp.getTime() - openOffline.getTime()) / 1000);
      openOffline = null;
    }
  }
  return {
    last_offline_at: lastOffline,
    last_recovery_at: lastRecovery,
    last_completed_outage_seconds: lastCompletedDurationSeconds,
    ongoing_outage_seconds: openOffline ? Math.max(0, (now.getTime() - openOffline.getTime()) / 1000) : null,
  };
}
