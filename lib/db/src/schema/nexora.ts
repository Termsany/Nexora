import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const deviceStatusEnum = pgEnum("device_status", ["ONLINE", "OFFLINE", "UNKNOWN"]);

export const devicesTable = pgTable("nexora_devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: text("agent_id").notNull().unique(),
  deviceUuid: uuid("device_uuid").notNull().unique(),
  hostname: text("hostname").notNull(),
  status: deviceStatusEnum("status").notNull().default("UNKNOWN"),
  currentUser: text("current_user"),
  domain: text("domain"),
  osName: text("os_name"),
  osVersion: text("os_version"),
  osBuild: text("os_build"),
  architecture: text("architecture"),
  ipAddress: text("ip_address"),
  agentVersion: text("agent_version"),
  machineGuidHash: text("machine_guid_hash"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  hardware: jsonb("hardware"),
  disks: jsonb("disks"),
  network: jsonb("network"),
});

export const agentCredentialsTable = pgTable("nexora_agent_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const metricsTable = pgTable("nexora_device_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  cpuPercent: doublePrecision("cpu_percent").notNull(),
  ramPercent: doublePrecision("ram_percent").notNull(),
  ramUsedBytes: integer("ram_used_bytes").notNull(),
  ramAvailableBytes: integer("ram_available_bytes").notNull(),
  diskPercent: doublePrecision("disk_percent").notNull(),
  uptimeSeconds: integer("uptime_seconds").notNull(),
});

export const activityTable = pgTable("nexora_activity", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const enrollmentTokensTable = pgTable("nexora_enrollment_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});