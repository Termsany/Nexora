import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organizationStatusEnum = pgEnum("organization_status", ["ACTIVE", "SUSPENDED", "ARCHIVED"]);
export const siteStatusEnum = pgEnum("site_status", ["ACTIVE", "ARCHIVED"]);
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "DISABLED"]);
export const userScopeEnum = pgEnum("user_scope", ["PLATFORM", "ORGANIZATION"]);
export const platformRoleEnum = pgEnum("platform_role", ["PLATFORM_SUPER_ADMIN", "PLATFORM_ADMIN", "PLATFORM_TECHNICIAN"]);
export const organizationRoleEnum = pgEnum("organization_role", ["ORGANIZATION_ADMIN", "ORGANIZATION_TECHNICIAN", "ORGANIZATION_VIEWER"]);

/**
 * A tenant. Organizations are identified internally by their immutable UUID
 * only: `name` is a display label and `slug` a stable human-facing handle, and
 * neither is ever used as a foreign key. Organizations are archived, never
 * hard-deleted, so device history and telemetry survive.
 */
export const organizationsTable = pgTable("nexora_organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: organizationStatusEnum("status").notNull().default("ACTIVE"),
  externalReference: text("external_reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  index("nexora_organizations_status_idx").on(table.status, table.name),
]);

/** A physical location belonging to exactly one organization. */
export const sitesTable = pgTable("nexora_sites", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  code: text("code"),
  description: text("description"),
  address: text("address"),
  city: text("city"),
  country: text("country"),
  timezone: text("timezone"),
  status: siteStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("nexora_sites_organization_name_uidx").on(table.organizationId, table.name),
  index("nexora_sites_organization_idx").on(table.organizationId),
  index("nexora_sites_organization_status_idx").on(table.organizationId, table.status),
  /**
   * Redundant against the primary key, but required as the target of the
   * composite foreign keys that make a cross-organization site reference
   * unrepresentable in the database rather than merely rejected in code.
   */
  unique("nexora_sites_id_organization_uk").on(table.id, table.organizationId),
]);

/**
 * An interactive console user. `scope` separates platform staff (who may reach
 * every organization, subject to `platformRole`) from organization users (who
 * reach only the organizations they hold a membership in). `platformRole` is
 * set if and only if scope is PLATFORM; a database CHECK constraint added in
 * migration 0008 enforces that pairing so an organization user can never carry
 * a platform role.
 */
export const usersTable = pgTable("nexora_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  scope: userScopeEnum("scope").notNull(),
  platformRole: platformRoleEnum("platform_role"),
  status: userStatusEnum("status").notNull().default("ACTIVE"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("nexora_users_scope_idx").on(table.scope, table.status),
]);

/**
 * Server-side session. Only the SHA-256 hash of the session token is stored;
 * the raw value lives exclusively in the client's httpOnly cookie.
 */
export const sessionsTable = pgTable("nexora_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
}, (table) => [
  index("nexora_sessions_user_idx").on(table.userId),
  index("nexora_sessions_expiry_idx").on(table.expiresAt),
]);

/**
 * Assignment of a user to an organization. Modelled as a membership rather than
 * a single column on the user so one technician can serve several customers
 * without duplicate accounts.
 */
export const organizationMembershipsTable = pgTable("nexora_organization_memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  role: organizationRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_organization_memberships_user_org_uidx").on(table.userId, table.organizationId),
  index("nexora_organization_memberships_organization_idx").on(table.organizationId),
]);
