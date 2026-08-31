import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable, sitesTable, usersTable } from "./tenancy";

export const deviceStatusEnum = pgEnum("device_status", ["ONLINE", "OFFLINE", "UNKNOWN"]);
export const alertTypeEnum = pgEnum("alert_type", ["DEVICE_OFFLINE", "CPU_HIGH", "MEMORY_HIGH", "DISK_HIGH"]);
export const alertSeverityEnum = pgEnum("alert_severity", ["warning", "critical"]);
export const alertStateEnum = pgEnum("alert_state", ["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
export const alertEventTypeEnum = pgEnum("alert_event_type", ["CREATED", "SEVERITY_CHANGED", "ACKNOWLEDGED", "RESOLVED"]);
export const notificationChannelEnum = pgEnum("notification_channel", ["telegram", "email", "webhook"]);
export const notificationEventTypeEnum = pgEnum("notification_event_type", ["ALERT_CREATED", "ALERT_ESCALATED", "ALERT_ACKNOWLEDGED", "ALERT_RESOLVED", "TEST"]);
export const notificationStateEnum = pgEnum("notification_state", ["PENDING", "PROCESSING", "SENT", "RETRY", "FAILED", "CANCELLED"]);
export const softwareArchitectureEnum = pgEnum("software_architecture", ["x64", "x86", "unknown"]);
export const softwareChangeTypeEnum = pgEnum("software_change_type", ["INSTALLED", "REMOVED", "VERSION_CHANGED"]);
export const collectionStatusEnum = pgEnum("inventory_collection_status", ["COMPLETE", "PARTIAL", "FAILED"]);
export const serviceStatusEnum = pgEnum("service_status", ["RUNNING", "STOPPED", "PAUSED", "START_PENDING", "STOP_PENDING", "PAUSE_PENDING", "CONTINUE_PENDING", "UNKNOWN"]);
export const serviceStartupTypeEnum = pgEnum("service_startup_type", ["AUTOMATIC", "AUTOMATIC_DELAYED", "MANUAL", "DISABLED", "BOOT", "SYSTEM", "UNKNOWN"]);
export const serviceEventTypeEnum = pgEnum("service_event_type", ["STATUS_CHANGED", "STARTUP_TYPE_CHANGED", "SERVICE_ADDED", "SERVICE_REMOVED"]);
export const processArchitectureEnum = pgEnum("process_architecture", ["x64", "x86", "arm64", "unknown"]);
export const privilegedActionStatusEnum = pgEnum("privileged_action_status", ["PENDING_APPROVAL", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]);
export const privilegedActionTypeEnum = pgEnum("privileged_action_type", ["REMOTE_COMMAND", "REMOTE_POWERSHELL", "SERVICE_START", "SERVICE_STOP", "SERVICE_RESTART", "PROCESS_TERMINATE", "SOFTWARE_INSTALL", "SOFTWARE_UNINSTALL", "PATCH_INSTALL"]);

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
  /**
   * Authoritative tenant boundary. Every device belongs to exactly one
   * organization, assigned server-side from the enrollment token. It is
   * deliberately not mutable through the ordinary device APIs.
   */
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  /**
   * Optional physical location. Nullable because a device may enrol before an
   * administrator places it. A CHECK-equivalent is enforced in application code
   * and by `nexora_devices_site_organization_fkey`: the site must belong to the
   * same organization as the device.
   */
  siteId: uuid("site_id"),
  /**
   * Free-text organization label from before Task #008. Retained only so the
   * pre-migration grouping stays recoverable; nothing reads it for authorization.
   */
  legacyOrganization: text("organization").notNull().default("Default"),
  machineGuidHash: text("machine_guid_hash"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  hardware: jsonb("hardware"),
  disks: jsonb("disks"),
  network: jsonb("network"),
  softwareInventoryInitializedAt: timestamp("software_inventory_initialized_at", { withTimezone: true }),
  servicesInventoryInitializedAt: timestamp("services_inventory_initialized_at", { withTimezone: true }),
  servicesLastCollectedAt: timestamp("services_last_collected_at", { withTimezone: true }),
  processesLastCollectedAt: timestamp("processes_last_collected_at", { withTimezone: true }),
  remoteCommandsEnabled: boolean("remote_commands_enabled").notNull().default(false),
  capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
}, (table) => [
  index("nexora_devices_last_seen_idx").on(table.lastSeenAt),
  index("nexora_devices_organization_idx").on(table.organizationId),
  index("nexora_devices_organization_status_idx").on(table.organizationId, table.status),
  index("nexora_devices_organization_site_idx").on(table.organizationId, table.siteId),
  index("nexora_devices_organization_last_seen_idx").on(table.organizationId, table.lastSeenAt),
  /**
   * Composite FK, not a plain site_id reference: it forces the site to belong
   * to the device's own organization, so a cross-tenant site assignment cannot
   * be written even by a direct SQL statement. MATCH SIMPLE means the
   * constraint is inert while site_id is NULL, which keeps sites optional.
   */
  foreignKey({
    columns: [table.siteId, table.organizationId],
    foreignColumns: [sitesTable.id, sitesTable.organizationId],
    name: "nexora_devices_site_organization_fk",
  }).onDelete("restrict"),
]);

export const deviceSoftwareTable = pgTable("nexora_device_software", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  softwareIdentity: text("software_identity").notNull(),
  normalizedName: text("normalized_name").notNull(),
  name: text("name").notNull(),
  version: text("version"),
  publisher: text("publisher"),
  architecture: softwareArchitectureEnum("architecture").notNull().default("unknown"),
  installDate: timestamp("install_date", { withTimezone: true }),
  installLocation: text("install_location"),
  productCode: text("product_code"),
  source: text("source").notNull().default("windows_registry"),
  systemComponent: boolean("system_component").notNull().default(false),
  uninstallAvailable: boolean("uninstall_available").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  isPresent: boolean("is_present").notNull().default(true),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_device_software_identity_uidx").on(table.deviceId, table.softwareIdentity),
  index("nexora_device_software_present_idx").on(table.deviceId, table.isPresent, table.normalizedName),
  index("nexora_software_fleet_idx").on(table.softwareIdentity, table.isPresent, table.lastSeenAt),
  index("nexora_software_name_idx").on(table.normalizedName),
  index("nexora_software_publisher_idx").on(table.publisher),
]);

export const softwareChangesTable = pgTable("nexora_software_changes", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  softwareIdentity: text("software_identity").notNull(),
  changeType: softwareChangeTypeEnum("change_type").notNull(),
  name: text("name").notNull(),
  publisher: text("publisher"),
  previousVersion: text("previous_version"),
  currentVersion: text("current_version"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => [
  index("nexora_software_changes_device_time_idx").on(table.deviceId, table.observedAt),
  index("nexora_software_changes_identity_time_idx").on(table.softwareIdentity, table.observedAt),
  index("nexora_software_changes_retention_idx").on(table.observedAt),
]);

export const agentCredentialsTable = pgTable("nexora_agent_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const inventorySnapshotsTable = pgTable("nexora_inventory_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").notNull(),
  inventoryType: text("inventory_type").notNull(),
  collectionStatus: collectionStatusEnum("collection_status").notNull(),
  itemCount: integer("item_count").notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
  agentVersion: text("agent_version").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_inventory_snapshots_device_type_id_uidx").on(table.deviceId, table.inventoryType, table.snapshotId),
  index("nexora_inventory_snapshots_retention_idx").on(table.inventoryType, table.receivedAt),
]);

export const deviceServicesTable = pgTable("nexora_device_services", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(), displayName: text("display_name").notNull(),
  status: serviceStatusEnum("status").notNull(), startupType: serviceStartupTypeEnum("startup_type").notNull(),
  logonAs: text("logon_as"), serviceType: text("service_type"), processId: integer("process_id"), binaryPath: text("binary_path"),
  description: text("description"), delayedAutoStart: boolean("delayed_auto_start"), isPresent: boolean("is_present").notNull().default(true),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(), lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_device_services_identity_uidx").on(table.deviceId, table.serviceName),
  index("nexora_device_services_device_status_idx").on(table.deviceId, table.isPresent, table.status),
  index("nexora_device_services_startup_idx").on(table.startupType, table.isPresent),
  index("nexora_device_services_last_seen_idx").on(table.lastSeenAt),
]);

export const serviceEventsTable = pgTable("nexora_service_events", {
  id: uuid("id").defaultRandom().primaryKey(), deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(), eventType: serviceEventTypeEnum("event_type").notNull(),
  previousValue: text("previous_value"), newValue: text("new_value"), observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  snapshotId: uuid("snapshot_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_service_events_snapshot_event_uidx").on(table.deviceId, table.snapshotId, table.serviceName, table.eventType),
  index("nexora_service_events_device_time_idx").on(table.deviceId, table.observedAt),
]);

export const deviceProcessesCurrentTable = pgTable("nexora_device_processes_current", {
  id: uuid("id").defaultRandom().primaryKey(), deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  pid: integer("pid").notNull(), processName: text("process_name").notNull(), executablePath: text("executable_path"), username: text("username"),
  cpuTimeSeconds: doublePrecision("cpu_time_seconds").notNull(), cpuPercent: doublePrecision("cpu_percent"),
  workingSetBytes: bigint("working_set_bytes", { mode: "number" }).notNull(), privateMemoryBytes: bigint("private_memory_bytes", { mode: "number" }),
  threadCount: integer("thread_count"), handleCount: integer("handle_count"), startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  architecture: processArchitectureEnum("architecture").notNull(), sessionId: integer("session_id"), snapshotId: uuid("snapshot_id").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_device_processes_identity_uidx").on(table.deviceId, table.pid, table.startedAt),
  index("nexora_device_processes_name_idx").on(table.deviceId, table.processName),
  index("nexora_device_processes_cpu_idx").on(table.deviceId, table.cpuPercent),
  index("nexora_device_processes_memory_idx").on(table.deviceId, table.workingSetBytes),
]);

export const metricsTable = pgTable("nexora_device_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  cpuPercent: doublePrecision("cpu_percent").notNull(),
  ramPercent: doublePrecision("ram_percent").notNull(),
  ramUsedBytes: bigint("ram_used_bytes", { mode: "number" }).notNull(),
  ramAvailableBytes: bigint("ram_available_bytes", { mode: "number" }).notNull(),
  diskPercent: doublePrecision("disk_percent").notNull(),
  uptimeSeconds: integer("uptime_seconds").notNull(),
}, (table) => [
  index("nexora_metrics_device_received_idx").on(table.deviceId, table.receivedAt),
  index("nexora_metrics_received_idx").on(table.receivedAt),
]);

export const diskMetricsTable = pgTable("nexora_disk_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  metricId: uuid("metric_id").references(() => metricsTable.id, { onDelete: "cascade" }),
  volume: text("volume").notNull(),
  filesystem: text("filesystem"),
  totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull(),
  freeBytes: bigint("free_bytes", { mode: "number" }).notNull(),
  usedPercent: doublePrecision("used_percent").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("nexora_disk_metrics_device_received_idx").on(table.deviceId, table.receivedAt),
  index("nexora_disk_metrics_device_volume_received_idx").on(table.deviceId, table.volume, table.receivedAt),
  index("nexora_disk_metrics_received_idx").on(table.receivedAt),
  uniqueIndex("nexora_disk_metrics_metric_volume_uidx").on(table.metricId, table.volume),
]);

export const metricAggregatesTable = pgTable("nexora_metric_aggregates", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  resolution: text("resolution").notNull(),
  bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
  cpuAvg: doublePrecision("cpu_avg").notNull(),
  cpuMin: doublePrecision("cpu_min").notNull(),
  cpuMax: doublePrecision("cpu_max").notNull(),
  ramAvg: doublePrecision("ram_avg").notNull(),
  ramMin: doublePrecision("ram_min").notNull(),
  ramMax: doublePrecision("ram_max").notNull(),
  ramUsedAvgBytes: doublePrecision("ram_used_avg_bytes").notNull(),
  ramAvailableAvgBytes: doublePrecision("ram_available_avg_bytes").notNull(),
  uptimeLatestSeconds: integer("uptime_latest_seconds").notNull(),
  sampleCount: integer("sample_count").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_metric_aggregates_bucket_uidx").on(table.deviceId, table.resolution, table.bucketAt),
  index("nexora_metric_aggregates_query_idx").on(table.deviceId, table.resolution, table.bucketAt),
]);

export const diskMetricAggregatesTable = pgTable("nexora_disk_metric_aggregates", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  volume: text("volume").notNull(),
  resolution: text("resolution").notNull(),
  bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
  usageAvg: doublePrecision("usage_avg").notNull(),
  usageMin: doublePrecision("usage_min").notNull(),
  usageMax: doublePrecision("usage_max").notNull(),
  usageLatest: doublePrecision("usage_latest").notNull(),
  totalBytesLatest: bigint("total_bytes_latest", { mode: "number" }).notNull(),
  usedBytesLatest: bigint("used_bytes_latest", { mode: "number" }).notNull(),
  freeBytesLatest: bigint("free_bytes_latest", { mode: "number" }).notNull(),
  sampleCount: integer("sample_count").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_disk_metric_aggregates_bucket_uidx").on(table.deviceId, table.volume, table.resolution, table.bucketAt),
  index("nexora_disk_metric_aggregates_query_idx").on(table.deviceId, table.volume, table.resolution, table.bucketAt),
]);

export const activityTable = pgTable("nexora_activity", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const alertsTable = pgTable("nexora_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Legacy free-text label retained for history; never used for authorization. */
  legacyOrganization: text("organization").notNull().default("Default"),
  /**
   * Denormalized tenant owner, always derived server-side from the alert's
   * device. Alerts are independently addressable by ID and the alert list is a
   * hot path, so carrying the owner here keeps tenant filtering on an index
   * instead of a join.
   */
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }),
  type: alertTypeEnum("type").notNull(),
  severity: alertSeverityEnum("severity").notNull(),
  state: alertStateEnum("state").notNull().default("OPEN"),
  resource: text("resource"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
  triggerValue: doublePrecision("trigger_value"),
  thresholdValue: doublePrecision("threshold_value"),
  dedupKey: text("dedup_key").notNull(),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("nexora_alerts_active_dedup_uidx").on(table.dedupKey).where(sql`${table.state} IN ('OPEN', 'ACKNOWLEDGED')`),
  index("nexora_alerts_list_idx").on(table.state, table.severity, table.lastTriggeredAt),
  index("nexora_alerts_device_idx").on(table.deviceId, table.state, table.lastTriggeredAt),
  index("nexora_alerts_organization_idx").on(table.organizationId, table.state, table.lastTriggeredAt),
]);

export const alertEventsTable = pgTable("nexora_alert_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  alertId: uuid("alert_id").notNull().references(() => alertsTable.id, { onDelete: "cascade" }),
  eventType: alertEventTypeEnum("event_type").notNull(),
  previousState: alertStateEnum("previous_state"),
  newState: alertStateEnum("new_state"),
  previousSeverity: alertSeverityEnum("previous_severity"),
  newSeverity: alertSeverityEnum("new_severity"),
  actor: text("actor"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => [
  index("nexora_alert_events_alert_timestamp_idx").on(table.alertId, table.timestamp),
]);

export const notificationsTable = pgTable("nexora_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Legacy free-text label retained for history; never used for authorization. */
  legacyOrganization: text("organization").notNull().default("Default"),
  /**
   * Denormalized tenant owner derived server-side from the originating alert.
   * Null only for platform-level deliveries with no tenant subject, such as the
   * channel test notification, which tenant users must never see.
   */
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "restrict" }),
  alertId: uuid("alert_id").references(() => alertsTable.id, { onDelete: "cascade" }),
  alertEventId: uuid("alert_event_id").references(() => alertEventsTable.id, { onDelete: "cascade" }),
  channel: notificationChannelEnum("channel").notNull(),
  destination: text("destination").notNull(),
  eventType: notificationEventTypeEnum("event_type").notNull(),
  severity: alertSeverityEnum("severity"),
  state: notificationStateEnum("state").notNull().default("PENDING"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  dedupKey: text("dedup_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("nexora_notifications_claim_idx").on(table.state, table.nextAttemptAt, table.createdAt),
  index("nexora_notifications_alert_idx").on(table.alertId, table.createdAt),
  index("nexora_notifications_event_idx").on(table.alertEventId, table.channel),
  index("nexora_notifications_history_idx").on(table.createdAt, table.channel, table.state),
  index("nexora_notifications_lease_idx").on(table.state, table.leaseUntil),
]);

export const workerHeartbeatsTable = pgTable("nexora_worker_heartbeats", {
  worker: text("worker").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
});

/**
 * Enrollment tokens are tenant-scoped. The organization (and optional site) an
 * enrolling device lands in is read from the consumed token server-side; an
 * agent can neither supply nor influence it.
 */
export const enrollmentTokensTable = pgTable("nexora_enrollment_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** Legacy free-text label retained for history; never used for authorization. */
  legacyOrganization: text("organization").notNull().default("Default"),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  siteId: uuid("site_id"),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("nexora_enrollment_tokens_organization_idx").on(table.organizationId, table.createdAt),
  /** Same composite guard as devices: a token cannot point at another tenant's site. */
  foreignKey({
    columns: [table.siteId, table.organizationId],
    foreignColumns: [sitesTable.id, sitesTable.organizationId],
    name: "nexora_enrollment_tokens_site_organization_fk",
  }).onDelete("restrict"),
]);

/**
 * Security audit trail for sensitive tenant operations. `metadata` carries only
 * non-sensitive descriptive fields — never raw enrollment tokens, agent
 * credentials, session tokens, password hashes or the administrative API token.
 */
export const auditLogTable = pgTable("nexora_audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: text("action").notNull(),
  subjectId: text("subject_id"),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** Free-text actor label for non-user principals ("administrative-api", "alert-engine"). */
  actorLabel: text("actor_label"),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  targetType: text("target_type"),
  targetId: text("target_id"),
  ipAddress: text("ip_address"),
  actorType: text("actor_type").notNull().default("SYSTEM"),
  actorAgentId: uuid("actor_agent_id").references(() => devicesTable.id, { onDelete: "set null" }),
  result: text("result").notNull().default("SUCCESS"),
  userAgent: text("user_agent"),
  requestId: text("request_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("nexora_audit_log_organization_idx").on(table.organizationId, table.createdAt),
  index("nexora_audit_log_created_idx").on(table.createdAt),
  index("nexora_audit_log_action_idx").on(table.action, table.createdAt),
  index("nexora_audit_log_request_idx").on(table.requestId),
]);

/** Approval workflow only. No dispatch, execution, output, or command queue exists. */
export const privilegedActionsTable = pgTable("nexora_privileged_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  deviceId: uuid("device_id").references(() => devicesTable.id, { onDelete: "restrict" }),
  actionType: privilegedActionTypeEnum("action_type").notNull(),
  status: privilegedActionStatusEnum("status").notNull().default("PENDING_APPROVAL"),
  requestedBy: uuid("requested_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  approvedBy: uuid("approved_by").references(() => usersTable.id, { onDelete: "restrict" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectedBy: uuid("rejected_by").references(() => usersTable.id, { onDelete: "restrict" }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  requestReason: text("request_reason").notNull(),
  safeParameters: jsonb("safe_parameters").notNull().default(sql`'{}'::jsonb`),
  requiresTwoPerson: boolean("requires_two_person").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("nexora_privileged_actions_org_status_idx").on(table.organizationId, table.status, table.createdAt),
  index("nexora_privileged_actions_device_idx").on(table.deviceId, table.createdAt),
]);
