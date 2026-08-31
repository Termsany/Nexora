import assert from "node:assert/strict";
import test from "node:test";
import { csrfProtection } from "./csrf.ts";
import { csrfTokenForSession } from "./csrf-token.ts";

const session = "test-session-token";
const csrf = csrfTokenForSession(session);
const user = { tenant: { principal: { kind: "user" } } };

function request(method, headers = {}, cookies = {}) {
  return { method, headers, cookies, ...user };
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
}

test("valid browser mutation passes CSRF validation", () => {
  process.env.CORS_ALLOWED_ORIGINS = "https://nexora.design.local";
  const res = response(); let called = false;
  csrfProtection(request("POST", { origin: "https://nexora.design.local", "x-csrf-token": csrf }, { nexora_session: session, nexora_csrf: csrf }), res, () => { called = true; });
  assert.equal(called, true); assert.equal(res.statusCode, 200);
});

test("missing or invalid CSRF is rejected", () => {
  process.env.CORS_ALLOWED_ORIGINS = "https://nexora.design.local";
  for (const headers of [{ origin: "https://nexora.design.local" }, { origin: "https://nexora.design.local", "x-csrf-token": "wrong" }]) {
    const res = response(); let called = false;
    csrfProtection(request("PATCH", headers, { nexora_session: session, nexora_csrf: csrf }), res, () => { called = true; });
    assert.equal(called, false); assert.equal(res.statusCode, 403);
  }
});

test("untrusted Origin is rejected before token validation", () => {
  process.env.CORS_ALLOWED_ORIGINS = "https://nexora.design.local";
  const res = response();
  csrfProtection(request("DELETE", { origin: "https://evil.example", "x-csrf-token": csrf }, { nexora_session: session, nexora_csrf: csrf }), res, () => {});
  assert.equal(res.statusCode, 403); assert.equal(res.body.error, "Untrusted request origin");
});

test("read-only requests are exempt", () => {
  const res = response(); let called = false;
  csrfProtection(request("GET"), res, () => { called = true; });
  assert.equal(called, true);
});

test("agent authentication is not blocked by browser CSRF", () => {
  const res = response(); let called = false;
  const req = { method: "POST", headers: {}, tenant: { principal: { kind: "agent" } } };
  csrfProtection(req, res, () => { called = true; });
  assert.equal(called, true);
});
