import { logger } from "./lib/logger.ts";
import { pool } from "@workspace/db";
import { claimNotification, cleanupNotifications, heartbeat, processNotification } from "./notifications/worker.ts";
import { DELIVERY_SPACING_MS, WORKER_POLL_MS } from "./notifications/policy.ts";

let stopping = false;
process.on("SIGTERM", () => { stopping = true; }); process.on("SIGINT", () => { stopping = true; });
const nextDelivery = new Map<string, number>(); let nextCleanup = 0;
logger.info("NotificationWorkerStarting");
while (!stopping) {
  try {
    const now = new Date();
    if (Date.now() >= nextCleanup) { const deleted = await cleanupNotifications(now); nextCleanup = Date.now() + 86_400_000; logger.info({ deleted }, "NotificationRetentionSucceeded"); }
    const item = await claimNotification(now);
    if (item) {
      const wait = Math.max(0, (nextDelivery.get(item.channel) ?? 0) - Date.now()); if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await processNotification(item, new Date()); nextDelivery.set(item.channel, Date.now() + DELIVERY_SPACING_MS[item.channel]);
      logger.info({ notificationId: item.id, channel: item.channel, attempt: item.attempt_count, ...result }, result.state === "SENT" ? "NotificationDeliverySucceeded" : "NotificationDeliveryFailed");
      await heartbeat(new Date(), { last_delivery_state: result.state });
      continue;
    }
    await heartbeat(now, { state: "idle" });
  } catch (error) { logger.error({ err: error }, "NotificationWorkerCycleFailed"); }
  await new Promise((resolve) => setTimeout(resolve, WORKER_POLL_MS));
}
logger.info("NotificationWorkerStopping"); await pool.end();
