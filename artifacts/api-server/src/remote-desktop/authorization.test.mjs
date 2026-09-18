import assert from "node:assert/strict";
import test from "node:test";
import { hasPermission } from "../tenancy/policy.ts";

function context(role, platform = false) {
  return { platformAccess: platform, platformRole: platform ? role : null, memberships: new Map(platform ? [] : [["org-a", role]]) };
}
for (const role of ["PLATFORM_SUPER_ADMIN", "PLATFORM_ADMIN"]) {
  test(`${role} can connect within existing platform scope`, () => assert.equal(hasPermission(context(role, true), "remote_desktop.connect", "org-a"), true));
}
test("organization admin can connect only within assigned scope", () => {
  assert.equal(hasPermission(context("ORGANIZATION_ADMIN"), "remote_desktop.connect", "org-a"), true);
  assert.equal(hasPermission(context("ORGANIZATION_ADMIN"), "remote_desktop.connect", "org-b"), false);
});
for (const role of ["ORGANIZATION_TECHNICIAN", "ORGANIZATION_VIEWER", "PLATFORM_TECHNICIAN"]) {
  test(`${role} has no implicit Remote Desktop permission`, () => assert.equal(hasPermission(context(role, role.startsWith("PLATFORM")), "remote_desktop.connect", "org-a"), false));
}
