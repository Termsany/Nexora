/**
 * Pure tenant-authorization decisions.
 *
 * Deliberately free of database and Express imports so the rules can be tested
 * directly, the way alerts/policy.ts and notifications/policy.ts already are.
 * context.ts adds credential resolution and membership loading on top; scope.ts
 * adds the query helpers.
 */

export type PlatformRole = "PLATFORM_SUPER_ADMIN" | "PLATFORM_ADMIN" | "PLATFORM_TECHNICIAN";
export type OrganizationRole = "ORGANIZATION_ADMIN" | "ORGANIZATION_TECHNICIAN" | "ORGANIZATION_VIEWER";

export type PrincipalUser = {
  id: string;
  email: string;
  name: string;
  scope: "PLATFORM" | "ORGANIZATION";
  platformRole: PlatformRole | null;
};

/**
 * Who is making the request.
 *
 * `platform-api` is the pre-existing static administrative API token. It stays
 * platform-level and entirely separate from interactive user authentication
 * (§AS): it is never issued to a tenant, never returned to a browser, and it
 * carries no user identity.
 */
export type Principal =
  | { kind: "user"; user: PrincipalUser }
  | { kind: "platform-api" };

/**
 * The single source of truth for what a request may reach.
 *
 * `organizationIds === null` means "every organization" and is only ever
 * produced for a principal with platform access. For everyone else it is the
 * explicit membership list, which may legitimately be empty — an empty list
 * denies everything rather than widening to all, which is the default-deny rule
 * in §L.
 */
export type TenantContext = {
  principal: Principal;
  platformAccess: boolean;
  organizationIds: string[] | null;
  platformRole: PlatformRole | null;
  memberships: ReadonlyMap<string, OrganizationRole>;
  userId: string | null;
  sessionId: string | null;
};

export const PERMISSIONS = [
  "organizations.read", "organizations.manage", "sites.read", "sites.manage",
  "devices.read", "devices.manage", "telemetry.read", "alerts.read", "alerts.acknowledge",
  "software.read", "services.read", "processes.read", "members.read", "members.manage",
  "enrollment_tokens.read", "enrollment_tokens.create", "enrollment_tokens.revoke",
  "notifications.read", "notifications.manage", "audit.read", "security.sessions.read",
  "security.sessions.revoke", "privileged_actions.request", "privileged_actions.approve",
  "privileged_actions.execute",
  "remote_commands.read", "remote_commands.request", "remote_commands.cancel",
] as const;
export type Permission = typeof PERMISSIONS[number];

export type Capability =
  | "organization:read"
  | "organization:create"
  | "organization:update"
  | "site:read"
  | "site:manage"
  | "device:read"
  | "device:assign-site"
  | "alert:read"
  | "alert:acknowledge"
  | "telemetry:read"
  | "software:read"
  | "inventory:read"
  | "notification:read"
  | "notification:manage"
  | "enrollment-token:read"
  | "enrollment-token:manage"
  | "membership:read"
  | "membership:manage"
  | "user:manage"
  | "audit:read";

const LEGACY_PERMISSION_MAP: Record<Capability, Permission> = {
  "organization:read": "organizations.read", "organization:create": "organizations.manage",
  "organization:update": "organizations.manage", "site:read": "sites.read", "site:manage": "sites.manage",
  "device:read": "devices.read", "device:assign-site": "devices.manage", "alert:read": "alerts.read",
  "alert:acknowledge": "alerts.acknowledge", "telemetry:read": "telemetry.read", "software:read": "software.read",
  "inventory:read": "services.read", "notification:read": "notifications.read", "notification:manage": "notifications.manage",
  "enrollment-token:read": "enrollment_tokens.read", "enrollment-token:manage": "enrollment_tokens.create",
  "membership:read": "members.read", "membership:manage": "members.manage", "user:manage": "organizations.manage",
  "audit:read": "audit.read",
};

const READ_PERMISSIONS: Permission[] = [
  "organizations.read", "sites.read", "devices.read", "telemetry.read", "alerts.read",
  "software.read", "services.read", "processes.read",
];

export const ORGANIZATION_ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  ORGANIZATION_VIEWER: [...READ_PERMISSIONS, "security.sessions.read", "security.sessions.revoke"],
  ORGANIZATION_TECHNICIAN: [...READ_PERMISSIONS, "devices.manage", "alerts.acknowledge", "enrollment_tokens.read", "notifications.read", "audit.read", "security.sessions.read", "security.sessions.revoke", "privileged_actions.request", "remote_commands.read", "remote_commands.request", "remote_commands.cancel"],
  ORGANIZATION_ADMIN: [...READ_PERMISSIONS, "organizations.manage", "sites.manage", "devices.manage", "alerts.acknowledge", "members.read", "members.manage", "enrollment_tokens.read", "enrollment_tokens.create", "enrollment_tokens.revoke", "notifications.read", "audit.read", "security.sessions.read", "security.sessions.revoke", "privileged_actions.request", "privileged_actions.approve", "privileged_actions.execute", "remote_commands.read", "remote_commands.request", "remote_commands.cancel"],
};

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly Permission[]> = {
  PLATFORM_TECHNICIAN: [...READ_PERMISSIONS, "devices.manage", "alerts.acknowledge", "notifications.read", "audit.read", "security.sessions.read", "security.sessions.revoke", "privileged_actions.request"],
  PLATFORM_ADMIN: [...READ_PERMISSIONS, "organizations.manage", "sites.manage", "devices.manage", "alerts.acknowledge", "members.read", "members.manage", "enrollment_tokens.read", "enrollment_tokens.create", "enrollment_tokens.revoke", "notifications.read", "notifications.manage", "audit.read", "security.sessions.read", "security.sessions.revoke", "privileged_actions.request", "privileged_actions.approve"],
  PLATFORM_SUPER_ADMIN: PERMISSIONS,
};

const READ_CAPABILITIES: Capability[] = [
  "organization:read", "site:read", "device:read", "alert:read",
  "telemetry:read", "software:read", "inventory:read",
];

const ORGANIZATION_ROLE_CAPABILITIES: Record<OrganizationRole, Capability[]> = {
  ORGANIZATION_VIEWER: [...READ_CAPABILITIES],
  ORGANIZATION_TECHNICIAN: [
    ...READ_CAPABILITIES,
    "alert:acknowledge", "device:assign-site", "enrollment-token:read",
  ],
  ORGANIZATION_ADMIN: [
    ...READ_CAPABILITIES,
    "alert:acknowledge", "device:assign-site",
    "site:manage", "organization:update",
    "enrollment-token:read", "enrollment-token:manage",
    "membership:read", "membership:manage",
    "notification:read", "audit:read",
  ],
};

const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, Capability[]> = {
  PLATFORM_TECHNICIAN: [
    ...READ_CAPABILITIES,
    "alert:acknowledge", "device:assign-site", "notification:read",
  ],
  PLATFORM_ADMIN: [
    ...READ_CAPABILITIES,
    "alert:acknowledge", "device:assign-site",
    "organization:create", "organization:update", "site:manage",
    "enrollment-token:read", "enrollment-token:manage",
    "membership:read", "membership:manage",
    "notification:read", "notification:manage", "audit:read",
  ],
  PLATFORM_SUPER_ADMIN: [
    ...READ_CAPABILITIES,
    "alert:acknowledge", "device:assign-site",
    "organization:create", "organization:update", "site:manage",
    "enrollment-token:read", "enrollment-token:manage",
    "membership:read", "membership:manage",
    "notification:read", "notification:manage",
    "user:manage", "audit:read",
  ],
};

/**
 * Whether the context may perform `capability`.
 *
 * When `organizationId` is supplied the answer is scoped to that organization:
 * an organization user needs a membership whose role grants the capability, and
 * a platform user needs the capability from their platform role. Omitting
 * `organizationId` asks whether the capability is held anywhere at all, which
 * is only appropriate for listing endpoints that scope their own results.
 */
export function can(context: TenantContext, capability: Capability, organizationId?: string): boolean {
  // These legacy capability names are intentionally narrower than their
  // broad permission aliases. Organization creation and user administration
  // remain platform-security operations, never tenant operations.
  if (capability === "organization:create") {
    return context.platformAccess && context.platformRole !== "PLATFORM_TECHNICIAN" && hasPermission(context, "organizations.manage", organizationId);
  }
  if (capability === "user:manage") return context.platformAccess && context.platformRole === "PLATFORM_SUPER_ADMIN";
  return hasPermission(context, LEGACY_PERMISSION_MAP[capability], organizationId);
}

/** Canonical default-deny permission decision. Permission never implies tenant reach. */
export function hasPermission(context: TenantContext, permission: Permission | string, organizationId?: string): boolean {
  if (!(PERMISSIONS as readonly string[]).includes(permission)) return false;
  if (context.platformAccess) {
    if (!context.platformRole) return false;
    return PLATFORM_ROLE_PERMISSIONS[context.platformRole]?.includes(permission as Permission) ?? false;
  }
  if (organizationId !== undefined) {
    const role = context.memberships.get(organizationId);
    if (!role) return false;
    return ORGANIZATION_ROLE_PERMISSIONS[role]?.includes(permission as Permission) ?? false;
  }
  for (const role of context.memberships.values()) {
    if (ORGANIZATION_ROLE_PERMISSIONS[role]?.includes(permission as Permission)) return true;
  }
  return false;
}

/**
 * The set of organizations a query may read.
 *
 * `null` means "no tenant predicate needed" and is produced only for a platform
 * context that did not ask to be narrowed. Anything else is an explicit list;
 * an empty list is a valid, fully-denying scope.
 */
export type OrganizationScope = string[] | null;

export type ScopeResult =
  | { ok: true; organizationIds: OrganizationScope }
  | { ok: false };

/**
 * Resolves the organization scope for a request, honouring an optional
 * caller-supplied `organization_id` filter.
 *
 * The filter is a convenience for narrowing a platform view (§Z), never a way
 * to widen one: a requested organization the context cannot reach is refused
 * outright rather than silently ignored, which would otherwise return the
 * caller's own data under another tenant's label.
 */
export function organizationScope(context: TenantContext, requested?: string | null): ScopeResult {
  if (requested) {
    if (context.platformAccess) return { ok: true, organizationIds: [requested] };
    if (!context.memberships.has(requested)) return { ok: false };
    return { ok: true, organizationIds: [requested] };
  }
  if (context.platformAccess) return { ok: true, organizationIds: null };
  return { ok: true, organizationIds: context.organizationIds ?? [] };
}

/** True when the context may reach this specific organization at all. */
export function reachesOrganization(context: TenantContext, organizationId: string): boolean {
  return context.platformAccess || context.memberships.has(organizationId);
}

/**
 * Tenant restriction for the hand-written pool queries in the device, software
 * and inventory routes. Pushes any parameter onto `values` and returns a
 * fragment safe to AND into a WHERE clause. An empty scope yields FALSE so the
 * query returns nothing rather than everything.
 */
export function tenantSqlClause(columnExpression: string, scope: OrganizationScope, values: unknown[]): string {
  if (scope === null) return "TRUE";
  if (scope.length === 0) return "FALSE";
  values.push(scope);
  return `${columnExpression} = ANY($${values.length}::uuid[])`;
}
