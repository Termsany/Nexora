import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, remoteCommandJobsTable } from "@workspace/db";
import { recordAudit } from "../tenancy/audit.ts";

/**
 * Background reconciliation for the signed remote-command protocol. Every
 * transition here is a plain conditional UPDATE (id + expected current
 * status), the same atomic pattern the claim/start/heartbeat routes use, so
 * running this concurrently from multiple maintenance workers is safe: a row
 * can only match one worker's WHERE clause before its status changes.
 */
export async function reconcileRemoteCommands() {
  const now = new Date();

  const expired = await db.update(remoteCommandJobsTable)
    .set({ status: "EXPIRED", completedAt: now, updatedAt: now })
    .where(and(eq(remoteCommandJobsTable.status, "READY"), lt(remoteCommandJobsTable.expiresAt, now)))
    .returning({ id: remoteCommandJobsTable.id, organizationId: remoteCommandJobsTable.organizationId });
  for (const row of expired) {
    await recordAudit({ action: "REMOTE_COMMAND_EXPIRED", actorLabel: "remote-command-maintenance", organizationId: row.organizationId, targetType: "remote_command", targetId: row.id });
  }

  // A RUNNING job that has outlived the timeout the request itself declared
  // is a definitive TIMED_OUT, independent of whether heartbeats are still
  // arriving — the command's own contract says it should have stopped by now.
  // CANCEL_REQUESTED is included too: a soft-cancelled job that started
  // running keeps its startedAt/timeoutSeconds, and a pending cancellation
  // must never leave a job stuck past its own declared timeout forever
  // waiting on an Agent acknowledgement that may never arrive.
  const timedOut = await db.update(remoteCommandJobsTable)
    .set({ status: "TIMED_OUT", completedAt: now, failureCode: "EXECUTION_TIMEOUT", updatedAt: now })
    .where(and(
      inArray(remoteCommandJobsTable.status, ["RUNNING", "CANCEL_REQUESTED"]),
      sql`${remoteCommandJobsTable.startedAt} is not null`,
      sql`${remoteCommandJobsTable.startedAt} + (${remoteCommandJobsTable.timeoutSeconds}::text || ' seconds')::interval < ${now}`,
    ))
    .returning({ id: remoteCommandJobsTable.id, organizationId: remoteCommandJobsTable.organizationId });
  for (const row of timedOut) {
    await recordAudit({ action: "REMOTE_COMMAND_TIMED_OUT", actorLabel: "remote-command-maintenance", organizationId: row.organizationId, targetType: "remote_command", targetId: row.id });
  }

  // Stale-lease reconciliation: a CLAIMED job whose lease has lapsed, or a
  // started job (its declared timeout has not yet elapsed, otherwise the
  // update above would already have caught it) — RUNNING or soft-cancelled
  // CANCEL_REQUESTED alike — that has gone silent for over two heartbeat
  // intervals, is ambiguous rather than known-failed: the Agent may or may
  // not still be executing it (or acting on the cancellation), so it becomes
  // UNKNOWN rather than any state that could be silently retried or
  // re-claimed. A CANCEL_REQUESTED job that never even started (soft-
  // cancelled straight from CLAIMED) follows the same lease rule CLAIMED does.
  const stale = await db.update(remoteCommandJobsTable)
    .set({ status: "UNKNOWN", completedAt: now, failureCode: "STALE_LEASE", updatedAt: now })
    .where(or(
      and(eq(remoteCommandJobsTable.status, "CLAIMED"), lt(remoteCommandJobsTable.leaseExpiresAt, now)),
      and(eq(remoteCommandJobsTable.status, "CANCEL_REQUESTED"), sql`${remoteCommandJobsTable.startedAt} is null`, lt(remoteCommandJobsTable.leaseExpiresAt, now)),
      and(inArray(remoteCommandJobsTable.status, ["RUNNING", "CANCEL_REQUESTED"]), sql`${remoteCommandJobsTable.startedAt} is not null`, lt(remoteCommandJobsTable.lastExecutionHeartbeatAt, new Date(now.getTime() - 120000))),
    ))
    .returning({ id: remoteCommandJobsTable.id, organizationId: remoteCommandJobsTable.organizationId });
  for (const row of stale) {
    await recordAudit({ action: "REMOTE_COMMAND_UNKNOWN", actorLabel: "remote-command-maintenance", organizationId: row.organizationId, targetType: "remote_command", targetId: row.id });
  }

  return { expired: expired.length, timedOut: timedOut.length, stale: stale.length };
}
