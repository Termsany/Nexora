export type DeviceState = "ONLINE" | "OFFLINE" | "UNKNOWN";

export function deviceState(lastSeenAt: Date | null, now = Date.now(), onlineSeconds = 90, offlineSeconds = 120): DeviceState {
  if (!lastSeenAt) return "UNKNOWN";
  const ageSeconds = Math.max(0, now - lastSeenAt.getTime()) / 1000;
  if (ageSeconds < onlineSeconds) return "ONLINE";
  if (ageSeconds >= offlineSeconds) return "OFFLINE";
  return "UNKNOWN";
}

export function configuredDeviceState(lastSeenAt: Date | null, now = Date.now()): DeviceState {
  return deviceState(
    lastSeenAt,
    now,
    Number(process.env.ONLINE_THRESHOLD_SECONDS ?? 90),
    Number(process.env.OFFLINE_THRESHOLD_SECONDS ?? 120),
  );
}
