import type { NotificationChannel, NotificationEventType } from "./types.ts";

export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
export const PROCESSING_LEASE_MS = 300_000;
export const WORKER_POLL_MS = 1_000;
export const DELIVERY_SPACING_MS: Record<NotificationChannel, number> = { telegram: 100, email: 250, webhook: 100 };
export const TERMINAL_RETENTION_DAYS = 90;

export function retryAt(attemptCount: number, now = new Date(), retryAfterSeconds?: number) {
  const configured = RETRY_DELAYS_MS[Math.max(0, Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1))];
  const delay = retryAfterSeconds == null ? configured : Math.max(configured, retryAfterSeconds * 1000);
  return new Date(now.getTime() + delay);
}

export function mapAlertEvent(eventType: "CREATED" | "SEVERITY_CHANGED" | "ACKNOWLEDGED" | "RESOLVED"): NotificationEventType {
  return ({ CREATED: "ALERT_CREATED", SEVERITY_CHANGED: "ALERT_ESCALATED", ACKNOWLEDGED: "ALERT_ACKNOWLEDGED", RESOLVED: "ALERT_RESOLVED" } as const)[eventType];
}

export function shouldNotify(eventType: NotificationEventType, notifyAcknowledged = false) {
  return eventType !== "ALERT_ACKNOWLEDGED" || notifyAcknowledged;
}

