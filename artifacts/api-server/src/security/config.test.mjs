import assert from "node:assert/strict";
import test from "node:test";
import { validateSecurityConfiguration } from "./config.ts";

const STRONG_TOKEN = "a".repeat(0) + "7f3c9e1b48a2d05f6c8e9a1b2d3f4c5e6a7b8c9d0e1f2a3b4"; // 48 hex-ish, random-looking
const STRONG_JWT = "3b9d4c1f8e2a6057c4b1a9e8d7f6c5b4a3928170e6d5c4b3a2f1908e7d6c5b4a3";
const STRONG_DB_PW = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b";

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const okBase = {
  NODE_ENV: "production",
  ADMIN_API_TOKEN: "admintoken-" + STRONG_JWT,
  ENROLLMENT_SECRET: "enrollsecret-" + STRONG_JWT,
  JWT_SECRET: STRONG_JWT,
  DATABASE_URL: `postgresql://nexora:${STRONG_DB_PW}@postgres:5432/nexora`,
};

test("production accepts strong independent secrets", () => {
  withEnv(okBase, () => assert.doesNotThrow(validateSecurityConfiguration));
});

test("production rejects missing JWT_SECRET", () => {
  withEnv({ ...okBase, JWT_SECRET: undefined }, () =>
    assert.throws(validateSecurityConfiguration, /JWT_SECRET is missing/));
});

test("production rejects known fallback JWT_SECRET", () => {
  withEnv({ ...okBase, JWT_SECRET: "change-this-local-jwt-secret" }, () =>
    assert.throws(validateSecurityConfiguration, /JWT_SECRET uses a known-unsafe/));
});

test("production rejects weak JWT_SECRET", () => {
  withEnv({ ...okBase, JWT_SECRET: "shortsecret" }, () =>
    assert.throws(validateSecurityConfiguration, /JWT_SECRET is too short/));
});

test("production rejects missing DB credential", () => {
  withEnv({ ...okBase, DATABASE_URL: undefined }, () =>
    assert.throws(validateSecurityConfiguration, /DATABASE_URL is missing/));
});

test("production rejects known fallback DB password", () => {
  withEnv({ ...okBase, DATABASE_URL: "postgresql://nexora:nexora-local-password@postgres:5432/nexora" }, () =>
    assert.throws(validateSecurityConfiguration, /DATABASE_URL password uses a known-unsafe/));
});

test("production rejects weak DB password", () => {
  withEnv({ ...okBase, DATABASE_URL: "postgresql://nexora:short@postgres:5432/nexora" }, () =>
    assert.throws(validateSecurityConfiguration, /DATABASE_URL password is too short/));
});

test("existing ADMIN_API_TOKEN / ENROLLMENT_SECRET checks are preserved", () => {
  withEnv({ ...okBase, ADMIN_API_TOKEN: "change-this-admin" }, () =>
    assert.throws(validateSecurityConfiguration, /ADMIN_API_TOKEN/));
  withEnv({ ...okBase, ENROLLMENT_SECRET: "short" }, () =>
    assert.throws(validateSecurityConfiguration, /ENROLLMENT_SECRET is too short/));
});

test("development is unaffected: disposable creds pass without NODE_ENV=production", () => {
  withEnv(
    {
      NODE_ENV: "development",
      JWT_SECRET: "change-this-local-jwt-secret",
      DATABASE_URL: "postgresql://nexora:nexora-local-password@postgres:5432/nexora",
      ADMIN_API_TOKEN: undefined,
      ENROLLMENT_SECRET: undefined,
    },
    () => assert.doesNotThrow(validateSecurityConfiguration),
  );
});
