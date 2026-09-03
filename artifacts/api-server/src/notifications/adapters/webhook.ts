import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { DeliveryError, sanitizedError } from "../errors.ts";
import type { NotificationPayload } from "../types.ts";

function blockedIpv4(address: string) {
  const parts = address.split(".").map(Number); const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224;
}
export function isBlockedAddress(address: string) {
  if (net.isIPv4(address)) return blockedIpv4(address);
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}
export async function validateWebhookUrl(value: string, resolve: typeof dns.lookup = dns.lookup) {
  let url: URL; try { url = new URL(value); } catch { throw new DeliveryError("WEBHOOK_INVALID_URL", "Webhook URL is invalid", false); }
  if (url.protocol !== "https:") throw new DeliveryError("WEBHOOK_HTTPS_REQUIRED", "Webhook URL must use HTTPS", false);
  if (url.username || url.password || ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new DeliveryError("WEBHOOK_DESTINATION_BLOCKED", "Webhook destination is blocked", false);
  const addresses = await resolve(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) throw new DeliveryError("WEBHOOK_DESTINATION_BLOCKED", "Webhook destination is blocked", false);
  return url;
}

type Fetch = typeof fetch;
export async function sendWebhook(id: string, payload: NotificationPayload, env: NodeJS.ProcessEnv = process.env, request: Fetch = fetch, resolve: typeof dns.lookup = dns.lookup) {
  if (!env.WEBHOOK_URL) throw new DeliveryError("WEBHOOK_NOT_CONFIGURED", "Webhook is not configured", false);
  const url = await validateWebhookUrl(env.WEBHOOK_URL, resolve); const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Nexora-Event": payload.event, "X-Nexora-Delivery": id };
  if (env.WEBHOOK_SIGNING_SECRET) headers["X-Nexora-Signature"] = `sha256=${crypto.createHmac("sha256", env.WEBHOOK_SIGNING_SECRET).update(body).digest("hex")}`;
  try {
    const response = await request(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (response.ok) return;
    if (response.status === 429 || response.status >= 500) throw new DeliveryError(`WEBHOOK_HTTP_${response.status}`, "Webhook destination temporarily unavailable", true, response.status === 429 ? Number(response.headers.get("retry-after")) || undefined : undefined);
    throw new DeliveryError(`WEBHOOK_HTTP_${response.status}`, "Webhook destination rejected the request", false);
  } catch (error) { if (error instanceof DeliveryError) throw error; throw sanitizedError(error); }
}

