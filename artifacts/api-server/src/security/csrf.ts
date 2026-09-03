import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { csrfTokenForSession } from "./csrf-token.ts";

export const CSRF_COOKIE = "nexora_csrf";
const SESSION_COOKIE = "nexora_session";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function equal(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function trustedOrigins() {
  return new Set((process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method) || req.tenant?.principal.kind !== "user") return next();
  const origin = req.headers.origin;
  if (!origin || !trustedOrigins().has(origin)) {
    res.status(403).json({ error: "Untrusted request origin" }); return;
  }
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const rawSession = cookies[SESSION_COOKIE] ?? "";
  const cookieToken = cookies[CSRF_COOKIE] ?? "";
  const headerToken = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : "";
  const expected = rawSession ? csrfTokenForSession(rawSession) : "";
  if (!expected || !cookieToken || !headerToken || !equal(cookieToken, expected) || !equal(headerToken, expected)) {
    res.status(403).json({ error: "CSRF validation failed" }); return;
  }
  next();
}
