import { sendEmail } from "./email.ts";
import { sendTelegram } from "./telegram.ts";
import { sendWebhook } from "./webhook.ts";
import type { NotificationChannel, NotificationPayload } from "../types.ts";

export async function deliver(channel: NotificationChannel, id: string, payload: NotificationPayload) {
  if (channel === "telegram") return sendTelegram(payload);
  if (channel === "email") return sendEmail(payload);
  return sendWebhook(id, payload);
}
