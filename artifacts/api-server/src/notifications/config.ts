import crypto from "node:crypto";
import type { ChannelRoute, NotificationChannel } from "./types.ts";

export type ChannelStatus = { channel: NotificationChannel; enabled: boolean; configured: boolean; destination: string | null };

function enabled(value: string | undefined) { return value?.toLowerCase() === "true"; }
function fingerprint(channel: NotificationChannel, value: string) { return crypto.createHash("sha256").update(`${channel}:${value}`).digest("hex"); }
function telegramLabel(value: string) { return `chat ending ${value.slice(-4)}`; }
function emailLabel(value: string) { return value; }
function webhookLabel(value: string) { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "Invalid destination"; } }

export function channelStatuses(env: NodeJS.ProcessEnv = process.env): ChannelStatus[] {
  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  const emailConfigured = Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM && env.SMTP_TO);
  const webhookConfigured = Boolean(env.WEBHOOK_URL);
  return [
    { channel: "telegram", configured: telegramConfigured, enabled: telegramConfigured && enabled(env.TELEGRAM_ENABLED), destination: env.TELEGRAM_CHAT_ID ? telegramLabel(env.TELEGRAM_CHAT_ID) : null },
    { channel: "email", configured: emailConfigured, enabled: emailConfigured && enabled(env.EMAIL_ENABLED), destination: env.SMTP_TO ? emailLabel(env.SMTP_TO) : null },
    { channel: "webhook", configured: webhookConfigured, enabled: webhookConfigured && enabled(env.WEBHOOK_ENABLED), destination: env.WEBHOOK_URL ? webhookLabel(env.WEBHOOK_URL) : null },
  ];
}

export function enabledRoutes(env: NodeJS.ProcessEnv = process.env): ChannelRoute[] {
  const statuses = channelStatuses(env);
  return statuses.filter((item) => item.enabled).map((item) => {
    const raw = item.channel === "telegram" ? env.TELEGRAM_CHAT_ID! : item.channel === "email" ? env.SMTP_TO! : env.WEBHOOK_URL!;
    return { channel: item.channel, destination: item.destination!, destinationKey: fingerprint(item.channel, raw) };
  });
}

export function acknowledgementNotificationsEnabled(env: NodeJS.ProcessEnv = process.env) { return enabled(env.NOTIFY_ACKNOWLEDGED); }

