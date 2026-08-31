export type NotificationChannel = "telegram" | "email" | "webhook";
export type NotificationEventType = "ALERT_CREATED" | "ALERT_ESCALATED" | "ALERT_ACKNOWLEDGED" | "ALERT_RESOLVED" | "TEST";
export type AlertSeverity = "warning" | "critical";

export type NotificationPayload = {
  event: NotificationEventType;
  timestamp: string;
  alert?: {
    id: string;
    type: string;
    severity: AlertSeverity;
    state: string;
    title: string;
    summary: string;
    resource: string | null;
    trigger_value: number | null;
    threshold_value: number | null;
    opened_at: string;
    resolved_at: string | null;
  };
  device?: { id: string; hostname: string; status: string };
  test?: { server: string };
};

export type ChannelRoute = { channel: NotificationChannel; destination: string; destinationKey: string };

