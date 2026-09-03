export const ALERT_EVALUATION_INTERVAL_MS = 30_000;
export const SUSTAINED_SAMPLE_COUNT = 5;
export const METRIC_FRESHNESS_SECONDS = 90;
export const SUSTAINED_WINDOW_MAX_AGE_SECONDS = 180;

export const ALERT_THRESHOLDS = {
  cpu: { warning: 80, critical: 95, recovery: 70 },
  memory: { warning: 80, critical: 95, recovery: 70 },
  disk: { warning: 85, critical: 95, recovery: 80 },
} as const;

export type AlertType = "DEVICE_OFFLINE" | "CPU_HIGH" | "MEMORY_HIGH" | "DISK_HIGH";
export type AlertSeverity = "warning" | "critical";
export type AlertDecision = "trigger" | "recover" | "hold" | "unavailable";

export type AlertSignal = {
  type: AlertType;
  resource: string | null;
  dedupKey: string;
  decision: AlertDecision;
  severity?: AlertSeverity;
  value?: number;
  threshold?: number;
  title: string;
  summary: string;
};

