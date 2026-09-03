import assert from "node:assert/strict";
import test from "node:test";
import { channelStatuses, enabledRoutes } from "./config.ts";
import { DeliveryError, sanitizedError } from "./errors.ts";
import { renderEmail, renderTelegram } from "./render.ts";
import { MAX_ATTEMPTS, mapAlertEvent, retryAt, shouldNotify } from "./policy.ts";
import { sendTelegram } from "./adapters/telegram.ts";
import { sendEmail } from "./adapters/email.ts";
import { isBlockedAddress, sendWebhook, validateWebhookUrl } from "./adapters/webhook.ts";

const alertPayload = { event: "ALERT_CREATED", timestamp: "2026-08-21T10:00:00.000Z", alert: { id: "a", type: "CPU_HIGH", severity: "warning", state: "OPEN", title: "CPU sustained high", summary: "CPU <high>", resource: null, trigger_value: 87, threshold_value: 80, opened_at: "2026-08-21T10:00:00.000Z", resolved_at: null }, device: { id: "d", hostname: "PC<&>", status: "ONLINE" } };

test("channel routing requires explicit enablement and complete configuration", () => {
  const env = { TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "secret", TELEGRAM_CHAT_ID: "123456", EMAIL_ENABLED: "true", SMTP_HOST: "smtp", SMTP_PORT: "587", SMTP_FROM: "a@example.com", SMTP_TO: "b@example.com", WEBHOOK_ENABLED: "false", WEBHOOK_URL: "https://example.com/hook" };
  const statuses = channelStatuses(env); assert.deepEqual(statuses.map((item) => [item.channel, item.enabled]), [["telegram", true], ["email", true], ["webhook", false]]);
  const routes = enabledRoutes(env); assert.equal(routes.length, 2); assert.ok(routes.every((route) => route.destinationKey.length === 64)); assert.ok(!JSON.stringify(routes).includes("secret"));
});

test("event mapping excludes acknowledgement by default", () => { assert.equal(mapAlertEvent("CREATED"), "ALERT_CREATED"); assert.equal(mapAlertEvent("SEVERITY_CHANGED"), "ALERT_ESCALATED"); assert.equal(shouldNotify("ALERT_ACKNOWLEDGED"), false); assert.equal(shouldNotify("ALERT_ACKNOWLEDGED", true), true); });
test("retry schedule is deterministic and bounded", () => { const now = new Date(0); assert.equal(retryAt(1, now).getTime(), 60_000); assert.equal(retryAt(2, now).getTime(), 300_000); assert.equal(retryAt(3, now).getTime(), 900_000); assert.equal(retryAt(4, now).getTime(), 3_600_000); assert.equal(retryAt(MAX_ATTEMPTS, now).getTime(), 3_600_000); assert.equal(retryAt(1, now, 120).getTime(), 120_000); });
test("message rendering escapes Telegram markup and produces concise email", () => { const telegram = renderTelegram(alertPayload); assert.match(telegram, /PC&lt;&amp;&gt;/); assert.doesNotMatch(telegram, /PC<&>/); const email = renderEmail(alertPayload); assert.match(email.subject, /Warning.*CPU.*PC<&>/); assert.match(email.text, /87/); });

test("Telegram adapter handles success, 429 guidance, 500, 400, invalid response, and timeout", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "never-log-this", TELEGRAM_CHAT_ID: "1" };
  await sendTelegram(alertPayload, env, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await assert.rejects(() => sendTelegram(alertPayload, env, async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 17 } }), { status: 429 })), (error) => error.code === "TELEGRAM_HTTP_429" && error.retryable && error.retryAfterSeconds === 17);
  await assert.rejects(() => sendTelegram(alertPayload, env, async () => new Response("{}", { status: 500 })), (error) => error.retryable);
  await assert.rejects(() => sendTelegram(alertPayload, env, async () => new Response("{}", { status: 400 })), (error) => !error.retryable);
  await assert.rejects(() => sendTelegram(alertPayload, env, async () => new Response("{}", { status: 200 })), (error) => error.code === "TELEGRAM_HTTP_200" && !error.message.includes("never-log-this"));
  await assert.rejects(() => sendTelegram(alertPayload, env, async () => { throw new DOMException("timeout secret", "AbortError"); }), (error) => error.code === "TIMEOUT" && !error.message.includes("secret"));
});

test("email adapter classifies SMTP success, temporary, and permanent failures", async () => {
  const env = { SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_FROM: "a@example.com", SMTP_TO: "b@example.com" };
  await sendEmail(alertPayload, env, { sendMail: async () => ({ accepted: ["b@example.com"] }) });
  await assert.rejects(() => sendEmail(alertPayload, env, { sendMail: async () => { throw { responseCode: 451 }; } }), (error) => error.code === "SMTP_451" && error.retryable);
  await assert.rejects(() => sendEmail(alertPayload, env, { sendMail: async () => { throw { responseCode: 550 }; } }), (error) => error.code === "SMTP_550" && !error.retryable);
});

test("webhook requires HTTPS and blocks local, link-local, and private destinations", async () => {
  for (const value of ["http://example.com/hook", "https://localhost/hook"]) await assert.rejects(() => validateWebhookUrl(value, async () => [{ address: "93.184.216.34", family: 4 }]));
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fd00::1"]) assert.equal(isBlockedAddress(address), true);
  await assert.rejects(() => validateWebhookUrl("https://example.com/hook", async () => [{ address: "10.0.0.2", family: 4 }]), (error) => error.code === "WEBHOOK_DESTINATION_BLOCKED");
});

test("webhook signs safe payloads and classifies responses", async () => {
  const env = { WEBHOOK_URL: "https://example.com/hook", WEBHOOK_SIGNING_SECRET: "signing-secret" }; const resolve = async () => [{ address: "93.184.216.34", family: 4 }]; let signature;
  await sendWebhook("delivery", alertPayload, env, async (_url, init) => { signature = init.headers["X-Nexora-Signature"]; return new Response(null, { status: 204 }); }, resolve); assert.match(signature, /^sha256=[a-f0-9]{64}$/); assert.ok(!signature.includes("signing-secret"));
  await assert.rejects(() => sendWebhook("d", alertPayload, env, async () => new Response(null, { status: 503 }), resolve), (error) => error.retryable);
  await assert.rejects(() => sendWebhook("d", alertPayload, env, async () => new Response(null, { status: 400 }), resolve), (error) => !error.retryable);
});

test("unknown failures are sanitized without original secret text", () => { const error = sanitizedError(new Error("connect token=top-secret")); assert.equal(error.code, "NETWORK_ERROR"); assert.doesNotMatch(error.message, /top-secret/); assert.ok(error instanceof DeliveryError); });
