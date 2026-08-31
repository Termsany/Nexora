import type { HistoricalResolution, RequestedResolution } from "./policy.ts";
import { resolveResolution } from "./policy.ts";

export type HistoricalRange = { from: Date; to: Date; resolution: HistoricalResolution };

export function historicalRange(input: { from?: string; to?: string; resolution?: RequestedResolution }, now = new Date()): HistoricalRange {
  if (input.resolution && !["raw", "hour", "day", "auto"].includes(input.resolution)) throw new Error("Unsupported resolution");
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("Invalid ISO 8601 timestamp");
  if (from >= to) throw new Error("from must be earlier than to");
  const duration = to.getTime() - from.getTime();
  if (duration > 365 * 24 * 60 * 60 * 1000) throw new Error("Historical range cannot exceed 365 days");
  const resolution = resolveResolution(input.resolution ?? "auto", from, to);
  if (resolution === "raw" && duration > 7 * 24 * 60 * 60 * 1000) throw new Error("Raw telemetry range cannot exceed 7 days");
  return { from, to, resolution };
}

export function groupDiskPoints<T extends { volume: string }>(points: T[]) {
  const groups = new Map<string, Omit<T, "volume">[]>();
  for (const { volume, ...point } of points) groups.set(volume, [...(groups.get(volume) ?? []), point]);
  return [...groups].map(([volume, volumePoints]) => ({ volume, points: volumePoints }));
}
