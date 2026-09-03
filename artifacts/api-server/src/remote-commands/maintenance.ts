import { and, eq, lt, or } from "drizzle-orm";
import { db, remoteCommandJobsTable } from "@workspace/db";

export async function reconcileRemoteCommands() {
  const now = new Date();
  await db.update(remoteCommandJobsTable).set({ status: "EXPIRED", completedAt: now, updatedAt: now }).where(and(eq(remoteCommandJobsTable.status, "READY"), lt(remoteCommandJobsTable.expiresAt, now)));
  await db.update(remoteCommandJobsTable).set({ status: "UNKNOWN", completedAt: now, failureCode: "STALE_LEASE", updatedAt: now }).where(or(and(eq(remoteCommandJobsTable.status, "CLAIMED"), lt(remoteCommandJobsTable.leaseExpiresAt, now)), and(eq(remoteCommandJobsTable.status, "RUNNING"), lt(remoteCommandJobsTable.lastExecutionHeartbeatAt, new Date(now.getTime() - 120000)))));
}
