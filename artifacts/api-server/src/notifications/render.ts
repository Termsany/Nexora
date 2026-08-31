import type { NotificationPayload } from "./types.ts";

const labels: Record<string, string> = { DEVICE_OFFLINE: "Device Offline", CPU_HIGH: "High CPU Usage", MEMORY_HIGH: "High Memory Usage", DISK_HIGH: "High Disk Usage" };
export function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function displayEvent(payload: NotificationPayload) { return payload.event === "ALERT_RESOLVED" ? "RESOLVED" : payload.event === "ALERT_ESCALATED" ? "ESCALATED" : payload.alert?.severity.toUpperCase() ?? "TEST"; }
function duration(payload: NotificationPayload) { if (payload.event !== "ALERT_RESOLVED" || !payload.alert?.resolved_at) return ""; const seconds = Math.max(0, Math.round((new Date(payload.alert.resolved_at).getTime() - new Date(payload.alert.opened_at).getTime()) / 1000)); return `\nDuration: ${Math.floor(seconds / 60)}m ${seconds % 60}s`; }

export function renderTelegram(payload: NotificationPayload) {
  if (payload.event === "TEST") return `<b>NEXORA - TEST</b>\n\nTelegram notifications are configured correctly.\n\nServer: ${escapeHtml(payload.test?.server ?? "Nexora")}\nTime: ${escapeHtml(payload.timestamp)}`;
  const alert = payload.alert!; const device = payload.device!;
  const value = alert.trigger_value == null ? "" : `\nValue: ${alert.trigger_value.toFixed(1)}%`;
  const threshold = alert.threshold_value == null ? "" : `\nThreshold: ${alert.threshold_value.toFixed(1)}%`;
  return `<b>NEXORA - ${displayEvent(payload)}</b>\n\n<b>${escapeHtml(labels[alert.type] ?? alert.title)}</b>\n\nDevice: ${escapeHtml(device.hostname)}\nSeverity: ${escapeHtml(alert.severity)}\nState: ${escapeHtml(alert.state)}${value}${threshold}${duration(payload)}\nTime: ${escapeHtml(payload.timestamp)}`;
}

export function renderEmail(payload: NotificationPayload) {
  if (payload.event === "TEST") return { subject: "[Nexora][Test] Notification delivery", text: `NEXORA - TEST\n\nNotification delivery is configured correctly.\nServer: ${payload.test?.server ?? "Nexora"}\nTime: ${payload.timestamp}` };
  const alert = payload.alert!; const device = payload.device!; const state = payload.event === "ALERT_RESOLVED" ? "Resolved" : alert.severity[0]!.toUpperCase() + alert.severity.slice(1);
  const value = alert.trigger_value == null ? "" : `\nValue: ${alert.trigger_value.toFixed(1)}%`; const threshold = alert.threshold_value == null ? "" : `\nThreshold: ${alert.threshold_value.toFixed(1)}%`;
  return { subject: `[Nexora][${state}] ${labels[alert.type] ?? alert.title} - ${device.hostname}`, text: `${labels[alert.type] ?? alert.title}\n\nDevice: ${device.hostname}\nSeverity: ${alert.severity}\nState: ${alert.state}\nAlert: ${alert.type}${value}${threshold}${duration(payload)}\nTime: ${payload.timestamp}\n\n${alert.summary}` };
}
