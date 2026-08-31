import assert from "node:assert/strict";
import test from "node:test";
import { can, organizationScope, reachesOrganization, tenantSqlClause } from "./policy.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function organizationContext(role, organizationId = ORG_A) {
  const memberships = new Map([[organizationId, role]]);
  return {
    principal: { kind: "user", user: { id: "user-1", email: "a@example.test", name: "A", scope: "ORGANIZATION", platformRole: null } },
    platformAccess: false,
    organizationIds: [...memberships.keys()],
    platformRole: null,
    memberships,
    userId: "user-1",
  };
}

function platformContext(platformRole) {
  return {
    principal: { kind: "user", user: { id: "user-p", email: "p@example.test", name: "P", scope: "PLATFORM", platformRole } },
    platformAccess: true,
    organizationIds: null,
    platformRole,
    memberships: new Map(),
    userId: "user-p",
  };
}

/** A user with a session but no memberships at all — the default-deny case. */
function orphanContext() {
  return {
    principal: { kind: "user", user: { id: "user-0", email: "0@example.test", name: "0", scope: "ORGANIZATION", platformRole: null } },
    platformAccess: false,
    organizationIds: [],
    platformRole: null,
    memberships: new Map(),
    userId: "user-0",
  };
}

test("organization scope defaults to the caller's memberships", () => {
  const scope = organizationScope(organizationContext("ORGANIZATION_ADMIN"));
  assert.deepEqual(scope, { ok: true, organizationIds: [ORG_A] });
});

test("platform scope applies no tenant predicate until narrowed", () => {
  assert.deepEqual(organizationScope(platformContext("PLATFORM_ADMIN")), { ok: true, organizationIds: null });
  assert.deepEqual(organizationScope(platformContext("PLATFORM_ADMIN"), ORG_B), { ok: true, organizationIds: [ORG_B] });
});

test("a requested organization outside the caller's memberships is refused, not ignored", () => {
  // Silently ignoring it would return the caller's own rows labelled as another
  // tenant's, which reads as a successful cross-tenant query.
  assert.deepEqual(organizationScope(organizationContext("ORGANIZATION_ADMIN"), ORG_B), { ok: false });
  assert.deepEqual(organizationScope(organizationContext("ORGANIZATION_ADMIN"), ORG_A), { ok: true, organizationIds: [ORG_A] });
});

test("a context with no memberships denies everything rather than widening", () => {
  const scope = organizationScope(orphanContext());
  assert.deepEqual(scope, { ok: true, organizationIds: [] });
  assert.equal(tenantSqlClause("d.organization_id", scope.organizationIds, []), "FALSE");
});

test("tenant SQL clause parameterizes the scope and never inlines identifiers", () => {
  const values = [];
  const clause = tenantSqlClause("d.organization_id", [ORG_A, ORG_B], values);
  assert.equal(clause, "d.organization_id = ANY($1::uuid[])");
  assert.deepEqual(values, [[ORG_A, ORG_B]]);
  assert.equal(tenantSqlClause("d.organization_id", null, []), "TRUE");
});

test("reachesOrganization is false for an unrelated tenant", () => {
  assert.equal(reachesOrganization(organizationContext("ORGANIZATION_ADMIN"), ORG_A), true);
  assert.equal(reachesOrganization(organizationContext("ORGANIZATION_ADMIN"), ORG_B), false);
  assert.equal(reachesOrganization(platformContext("PLATFORM_TECHNICIAN"), ORG_B), true);
});

test("organization roles grant only their own capabilities", () => {
  const viewer = organizationContext("ORGANIZATION_VIEWER");
  assert.equal(can(viewer, "device:read", ORG_A), true);
  assert.equal(can(viewer, "alert:acknowledge", ORG_A), false);
  assert.equal(can(viewer, "site:manage", ORG_A), false);
  assert.equal(can(viewer, "enrollment-token:manage", ORG_A), false);

  const technician = organizationContext("ORGANIZATION_TECHNICIAN");
  assert.equal(can(technician, "alert:acknowledge", ORG_A), true);
  assert.equal(can(technician, "device:assign-site", ORG_A), true);
  assert.equal(can(technician, "site:manage", ORG_A), false);
  assert.equal(can(technician, "membership:manage", ORG_A), false);

  const admin = organizationContext("ORGANIZATION_ADMIN");
  assert.equal(can(admin, "site:manage", ORG_A), true);
  assert.equal(can(admin, "membership:manage", ORG_A), true);
  assert.equal(can(admin, "enrollment-token:manage", ORG_A), true);
});

test("no organization role can create organizations or manage users", () => {
  for (const role of ["ORGANIZATION_VIEWER", "ORGANIZATION_TECHNICIAN", "ORGANIZATION_ADMIN"]) {
    const context = organizationContext(role);
    assert.equal(can(context, "organization:create", ORG_A), false, `${role} must not create organizations`);
    assert.equal(can(context, "user:manage", ORG_A), false, `${role} must not manage users`);
    assert.equal(can(context, "notification:manage", ORG_A), false, `${role} must not manage platform channels`);
  }
});

test("an organization admin holds no capability in another tenant", () => {
  const admin = organizationContext("ORGANIZATION_ADMIN");
  for (const capability of ["device:read", "alert:read", "alert:acknowledge", "site:manage", "membership:manage", "enrollment-token:manage"]) {
    assert.equal(can(admin, capability, ORG_B), false, `${capability} must not be granted in an unrelated organization`);
  }
});

test("platform roles are separated from each other", () => {
  const technician = platformContext("PLATFORM_TECHNICIAN");
  assert.equal(can(technician, "device:read"), true);
  assert.equal(can(technician, "alert:acknowledge"), true);
  assert.equal(can(technician, "organization:create"), false);
  assert.equal(can(technician, "membership:manage"), false);
  assert.equal(can(technician, "user:manage"), false);

  const admin = platformContext("PLATFORM_ADMIN");
  assert.equal(admin && can(admin, "organization:create"), true);
  assert.equal(can(admin, "membership:manage"), true);
  assert.equal(can(admin, "user:manage"), false);

  const superAdmin = platformContext("PLATFORM_SUPER_ADMIN");
  assert.equal(can(superAdmin, "user:manage"), true);
});

test("a membership-less context is denied every capability", () => {
  const orphan = orphanContext();
  for (const capability of ["device:read", "organization:read", "alert:read", "site:read", "software:read", "inventory:read"]) {
    assert.equal(can(orphan, capability), false, `${capability} must be denied without any membership`);
    assert.equal(can(orphan, capability, ORG_A), false, `${capability} must be denied for a specific organization too`);
  }
});
