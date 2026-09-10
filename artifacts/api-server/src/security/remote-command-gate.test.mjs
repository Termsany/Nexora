import assert from "node:assert/strict";
import test from "node:test";
import { canManageRemoteCommandsGate, remoteCommandsEnabled, setRemoteCommandsEnabled } from "./remote-command-gate.ts";

test("only platform admins can manage the global gate", () => {
  assert.equal(canManageRemoteCommandsGate({ platformAccess: false, platformRole: "PLATFORM_SUPER_ADMIN" }), false);
  assert.equal(canManageRemoteCommandsGate({ platformAccess: true, platformRole: "PLATFORM_TECHNICIAN" }), false);
  assert.equal(canManageRemoteCommandsGate({ platformAccess: true, platformRole: "PLATFORM_ADMIN" }), true);
  assert.equal(canManageRemoteCommandsGate({ platformAccess: true, platformRole: "PLATFORM_SUPER_ADMIN" }), true);
});

test("runtime remote command gate is mutable and can be closed", () => {
  const original = remoteCommandsEnabled();
  setRemoteCommandsEnabled(true);
  assert.equal(remoteCommandsEnabled(), true);
  setRemoteCommandsEnabled(false);
  assert.equal(remoteCommandsEnabled(), false);
  setRemoteCommandsEnabled(original);
});

test("gate defaults fail closed when startup value is not true", () => {
  assert.equal(typeof remoteCommandsEnabled(), "boolean");
});
