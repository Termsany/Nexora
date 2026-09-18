import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { MAINTENANCE_INTERVAL_MS } from "./telemetry/policy";
import { runTelemetryMaintenance } from "./telemetry/maintenance";
import { ALERT_EVALUATION_INTERVAL_MS } from "./alerts/policy";
import { expireStaleSessions as expireRemoteDesktopSessions } from "./remote-desktop/sessions.ts";
import { evaluateAlerts } from "./alerts/engine";
import { cleanupSoftwareChanges } from "./software/reconcile.ts";
import { cleanupRuntimeInventory } from "./inventory/reconcile.ts";
import { reconcileRemoteCommands } from "./remote-commands/maintenance.ts";

let stop: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => { stop = resolve; });
process.on("SIGTERM", () => stop?.());
process.on("SIGINT", () => stop?.());

// Bounded liveness signal for platform self-monitoring (PR-06). One row,
// upserted every loop; a stale last_seen_at means this worker has stopped or
// is wedged even though its container still shows "running".
async function maintenanceHeartbeat(metadata: Record<string, unknown>): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO nexora_worker_heartbeats(worker,last_seen_at,metadata) VALUES ('maintenance',now(),$1)
       ON CONFLICT (worker) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at, metadata=EXCLUDED.metadata`,
      [metadata],
    );
  } catch (error) {
    logger.error({ err: error }, "MaintenanceHeartbeatFailed");
  }
}

logger.info("TelemetryMaintenanceStarting");
let running = true;
let firstRun = true;
let nextTelemetryRun = 0;
let cycles = 0;
await maintenanceHeartbeat({ event: "starting" });
while (running) {
  if (Date.now() >= nextTelemetryRun) {
    try {
      const result = await runTelemetryMaintenance(pool as unknown as Parameters<typeof runTelemetryMaintenance>[0], firstRun ? "full" : "incremental");
      logger.info(result, "TelemetryMaintenanceSucceeded");
      logger.info({ deleted: await cleanupSoftwareChanges() }, "SoftwareChangeRetentionSucceeded");
      logger.info(await cleanupRuntimeInventory(), "RuntimeInventoryRetentionSucceeded");
      await reconcileRemoteCommands();
      // Remote Desktop sessions whose gateway died, whose deadline passed, or
      // that went silent. Without this an API restart would leave rows stuck
      // in a live status and the one-session-per-device index would keep
      // refusing new sessions forever.
      const reaped = await expireRemoteDesktopSessions();
      if (reaped.length) logger.info({ sessions: reaped.length }, "RemoteDesktopSessionsExpired");
      firstRun = false;
      nextTelemetryRun = Date.now() + MAINTENANCE_INTERVAL_MS;
    } catch (error) {
      logger.error({ err: error }, "TelemetryMaintenanceFailed");
    }
  }
  try {
    const result = await evaluateAlerts(new Date(), (deviceId, error) => logger.error({ deviceId, err: error }, "AlertDeviceEvaluationFailed"));
    logger.info(result, "AlertEvaluationSucceeded");
  } catch (error) {
    logger.error({ err: error }, "AlertEvaluationFailed");
  }
  await maintenanceHeartbeat({ event: "loop", cycles: ++cycles });
  running = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ALERT_EVALUATION_INTERVAL_MS);
    void stopped.then(() => { clearTimeout(timer); resolve(false); });
  });
}
logger.info("TelemetryMaintenanceStopping");
