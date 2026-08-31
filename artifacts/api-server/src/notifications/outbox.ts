import crypto from "node:crypto";
import { alertEventsTable, db, notificationsTable } from "@workspace/db";
import { acknowledgementNotificationsEnabled, enabledRoutes } from "./config.ts";
import { mapAlertEvent, MAX_ATTEMPTS, shouldNotify } from "./policy.ts";
import type { NotificationChannel, NotificationPayload } from "./types.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Alert = { id: string; organizationId: string; legacyOrganization: string; deviceId: string; type: string; severity: "warning" | "critical"; state: string; resource: string | null; title: string; summary: string; triggerValue: number | null; thresholdValue: number | null; openedAt: Date; resolvedAt: Date | null };
type Device = { id: string; hostname: string; status: string };
type EventValues = typeof alertEventsTable.$inferInsert;

function snapshot(event: NotificationPayload["event"], alert: Alert, device: Device, timestamp: Date): NotificationPayload {
  return { event, timestamp: timestamp.toISOString(), alert: { id: alert.id, type: alert.type, severity: alert.severity, state: alert.state, title: alert.title, summary: alert.summary, resource: alert.resource, trigger_value: alert.triggerValue, threshold_value: alert.thresholdValue, opened_at: alert.openedAt.toISOString(), resolved_at: alert.resolvedAt?.toISOString() ?? null }, device: { id: device.id, hostname: device.hostname, status: device.status } };
}

export async function recordAlertEvent(tx: Tx, values: EventValues, alert: Alert, device: Device, timestamp = new Date()) {
  const [event] = await tx.insert(alertEventsTable).values({ ...values, timestamp }).returning();
  const eventType = mapAlertEvent(event.eventType);
  if (!shouldNotify(eventType, acknowledgementNotificationsEnabled())) return event;
  const payload = snapshot(eventType, alert, device, timestamp);
  for (const route of enabledRoutes()) {
    // The notification inherits the alert's tenant so delivery history stays
    // tenant-isolated even though the channels themselves are platform-global.
    await tx.insert(notificationsTable).values({ organizationId: alert.organizationId, legacyOrganization: alert.legacyOrganization, alertId: alert.id, alertEventId: event.id, channel: route.channel, destination: route.destination, eventType, severity: alert.severity, maxAttempts: MAX_ATTEMPTS, dedupKey: `${event.id}:${route.channel}:${route.destinationKey}`, payload }).onConflictDoNothing();
  }
  return event;
}

export async function enqueueTestNotification(channel: NotificationChannel, now = new Date()) {
  const route = enabledRoutes().find((item) => item.channel === channel);
  if (!route) return null;
  const id = crypto.randomUUID();
  const payload: NotificationPayload = { event: "TEST", timestamp: now.toISOString(), test: { server: process.env.NOTIFICATION_SERVER_NAME ?? "nexora.design.local" } };
  // A channel test belongs to no tenant: organizationId stays null so the
  // delivery is visible to platform principals only, never in a tenant's history.
  const [created] = await db.insert(notificationsTable).values({ id, organizationId: null, legacyOrganization: "Default", channel, destination: route.destination, eventType: "TEST", maxAttempts: MAX_ATTEMPTS, dedupKey: `test:${id}:${channel}:${route.destinationKey}`, payload }).returning();
  return created;
}
