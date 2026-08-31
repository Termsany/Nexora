import { DeliveryError, sanitizedError } from "../errors.ts";
import { renderTelegram } from "../render.ts";
import type { NotificationPayload } from "../types.ts";

type Fetch = typeof fetch;
export async function sendTelegram(payload: NotificationPayload, env: NodeJS.ProcessEnv = process.env, request: Fetch = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new DeliveryError("TELEGRAM_NOT_CONFIGURED", "Telegram is not configured", false);
  try {
    const response = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: renderTelegram(payload), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; parameters?: { retry_after?: number } } | null;
    if (response.ok && body?.ok === true) return;
    if (response.status === 429) throw new DeliveryError("TELEGRAM_HTTP_429", "Telegram rate limit exceeded", true, body?.parameters?.retry_after);
    if (response.status >= 500) throw new DeliveryError(`TELEGRAM_HTTP_${response.status}`, "Telegram service unavailable", true);
    throw new DeliveryError(`TELEGRAM_HTTP_${response.status}`, "Telegram rejected the request", false);
  } catch (error) { if (error instanceof DeliveryError) throw error; throw sanitizedError(error); }
}

