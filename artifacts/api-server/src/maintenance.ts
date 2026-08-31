import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { MAINTENANCE_INTERVAL_MS } from "./telemetry/policy";
import { runTelemetryMaintenance } from "./telemetry/maintenance";
import { ALERT_EVALUATION_INTERVAL_MS } from "./alerts/policy";
import { evaluateAlerts } from "./alerts/engine";
import { cleanupSoftwareChanges } from "./software/reconcile.ts";
import { cleanupRuntimeInventory } from "./inventory/reconcile.ts";
import { reconcileRemoteCommands } from "./remote-commands/maintenance.ts";

let stop: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => { stop = resolve; });
process.on("SIGTERM", () => stop?.());
process.on("SIGINT", () => stop?.());

logger.info("TelemetryMaintenanceStarting");
let running = true;
let firstRun = true;
let nextTelemetryRun = 0;
while (running) {
  if (Date.now() >= nextTelemetryRun) {
    try {
      const result = await runTelemetryMaintenance(pool as unknown as Parameters<typeof runTelemetryMaintenance>[0], firstRun ? "full" : "incremental");
      logger.info(result, "TelemetryMaintenanceSucceeded");
      logger.info({ deleted: await cleanupSoftwareChanges() }, "SoftwareChangeRetentionSucceeded");
      logger.info(await cleanupRuntimeInventory(), "RuntimeInventoryRetentionSucceeded");
      await reconcileRemoteCommands();
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
  running = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ALERT_EVALUATION_INTERVAL_MS);
    void stopped.then(() => { clearTimeout(timer); resolve(false); });
  });
}
logger.info("TelemetryMaintenanceStopping");
