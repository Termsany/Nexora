import assert from "node:assert/strict";
import test from "node:test";
import { deviceState } from "./device-state.ts";

const now = new Date("2026-01-01T00:10:00Z").getTime();
test("device state derives online, unknown, and offline boundaries", () => {
  assert.equal(deviceState(null, now), "UNKNOWN");
  assert.equal(deviceState(new Date(now - 89_000), now), "ONLINE");
  assert.equal(deviceState(new Date(now - 90_000), now), "UNKNOWN");
  assert.equal(deviceState(new Date(now - 120_000), now), "OFFLINE");
});
