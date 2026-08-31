import nodemailer from "nodemailer";
import { DeliveryError, sanitizedError } from "../errors.ts";
import { renderEmail } from "../render.ts";
import type { NotificationPayload } from "../types.ts";

type Mailer = { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
export async function sendEmail(payload: NotificationPayload, env: NodeJS.ProcessEnv = process.env, mailer?: Mailer) {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM || !env.SMTP_TO) throw new DeliveryError("SMTP_NOT_CONFIGURED", "Email is not configured", false);
  const port = Number(env.SMTP_PORT); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeliveryError("SMTP_INVALID_PORT", "SMTP port is invalid", false);
  const transport = mailer ?? nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure: env.SMTP_SECURE?.toLowerCase() === "true",
    auth: env.SMTP_USERNAME ? { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD ?? "" } : undefined,
    tls: { rejectUnauthorized: true }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  });
  try { const content = renderEmail(payload); await transport.sendMail({ from: env.SMTP_FROM, to: env.SMTP_TO, ...content }); }
  catch (error) {
    const responseCode = typeof error === "object" && error && "responseCode" in error ? Number(error.responseCode) : undefined;
    if (responseCode) throw new DeliveryError(`SMTP_${responseCode}`, responseCode >= 500 ? "SMTP rejected the message" : "SMTP temporarily unavailable", responseCode < 500);
    throw sanitizedError(error);
  }
}

