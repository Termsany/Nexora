export const RAW_RETENTION_DAYS = 7;
export const HOURLY_RETENTION_DAYS = 90;
export const DAILY_RETENTION_DAYS = 365;
export const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export type HistoricalResolution = "raw" | "hour" | "day";
export type RequestedResolution = HistoricalResolution | "auto";

export function resolveResolution(requested: RequestedResolution, from: Date, to: Date): HistoricalResolution {
  if (requested !== "auto") return requested;
  const durationMs = to.getTime() - from.getTime();
  if (durationMs <= 6 * 60 * 60 * 1000) return "raw";
  if (durationMs <= 7 * 24 * 60 * 60 * 1000) return "hour";
  return "day";
}

export function retentionCutoffs(now = new Date()) {
  const day = 24 * 60 * 60 * 1000;
  return {
    raw: new Date(now.getTime() - RAW_RETENTION_DAYS * day),
    hour: new Date(now.getTime() - HOURLY_RETENTION_DAYS * day),
    day: new Date(now.getTime() - DAILY_RETENTION_DAYS * day),
  };
}
