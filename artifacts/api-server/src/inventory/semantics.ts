export type PriorService = { status: string; startup_type: string; is_present: boolean } | undefined;
export type ServiceEvent = { type: "STATUS_CHANGED" | "STARTUP_TYPE_CHANGED" | "SERVICE_ADDED"; previous: string | null; current: string | null };

export function serviceEvents(prior: PriorService, current: { status: string; startup_type: string }, baseline: boolean, complete: boolean): ServiceEvent[] {
  if (baseline || !complete) return [];
  if (!prior || !prior.is_present) return [{ type: "SERVICE_ADDED", previous: null, current: current.status }];
  const events: ServiceEvent[] = [];
  if (prior.status !== current.status) events.push({ type: "STATUS_CHANGED", previous: prior.status, current: current.status });
  if (prior.startup_type !== current.startup_type) events.push({ type: "STARTUP_TYPE_CHANGED", previous: prior.startup_type, current: current.startup_type });
  return events;
}

export function processIdentity(pid: number, startedAt: string) { return `${pid}:${new Date(startedAt).toISOString()}`; }
export function canInferDisappearance(status: string) { return status === "COMPLETE"; }
