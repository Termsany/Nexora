import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { devicesTable, privilegedActionsTable } from "./nexora";
import { organizationsTable, sitesTable, usersTable } from "./tenancy";

/**
 * Remote Desktop V1.
 *
 * This replaces an earlier WebRTC signalling sketch (OFFER/ANSWER/ICE rows
 * polled out of the database). That design was dropped deliberately: it
 * required a WebRTC stack inside the .NET Agent, it let peers negotiate a
 * direct path that Nexora could neither authorise nor audit, and signalling
 * through table polling cannot carry a desktop stream. V1 is instead mediated
 * end to end - the browser and the Agent each hold an authenticated WebSocket
 * to Nexora and never address one another.
 *
 * A session is the authorisation record. It is created only behind a
 * privileged action, exactly like a remote command, so approval policy
 * (including two-person) is inherited rather than reimplemented.
 */
export const remoteDesktopSessionStatusEnum = pgEnum("remote_desktop_session_status", [
  "REQUESTED",
  "AUTHORIZED",
  "CONNECTING",
  "CONNECTED",
  "ACTIVE",
  "DISCONNECTING",
  "CLOSED",
  "EXPIRED",
  "FAILED",
]);

/** Statuses in which a session still owns the device. Concurrency is enforced against exactly this set. */
export const REMOTE_DESKTOP_LIVE_STATUSES = ["REQUESTED", "AUTHORIZED", "CONNECTING", "CONNECTED", "ACTIVE", "DISCONNECTING"] as const;

export const remoteDesktopSessionsTable = pgTable("nexora_remote_desktop_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "restrict" }),
  deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "restrict" }),
  // One session per approval, mirroring nexora_remote_command_jobs. A session
  // can never exist without the privileged action that authorised it.
  privilegedActionId: uuid("privileged_action_id").notNull().unique().references(() => privilegedActionsTable.id, { onDelete: "restrict" }),
  status: remoteDesktopSessionStatusEnum("status").notNull().default("REQUESTED"),

  // Only SHA-256 hashes are stored. The raw tokens are returned once, to the
  // viewer over the authenticated REST response and to the Agent over its
  // signed channel, and are never recoverable from the database.
  viewerTokenHash: text("viewer_token_hash").notNull(),
  // Null until the Agent claims the session over its signed channel: the raw
  // token is minted at hand-out so it need never be stored recoverably.
  agentTokenHash: text("agent_token_hash"),

  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  approvedByUserId: uuid("approved_by_user_id").references(() => usersTable.id, { onDelete: "restrict" }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }),
  viewerConnectedAt: timestamp("viewer_connected_at", { withTimezone: true }),
  agentConnectedAt: timestamp("agent_connected_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Hard server-side deadline. Enforced by the gateway on every message and by
  // the maintenance sweep, so a wedged gateway cannot extend a session.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  // Short, non-sensitive reason codes only (viewer_closed, expired, agent_lost...).
  closeReason: text("close_reason"),
  // Screen geometry the Agent reported, so the console can scale correctly.
  screenWidth: integer("screen_width"),
  screenHeight: integer("screen_height"),
  framesSent: integer("frames_sent").notNull().default(0),
  inputEventsSent: integer("input_events_sent").notNull().default(0),
  clipboardEnabled: boolean("clipboard_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("nexora_remote_desktop_sessions_org_idx").on(t.organizationId, t.createdAt),
  index("nexora_remote_desktop_sessions_device_idx").on(t.deviceId, t.createdAt),
  index("nexora_remote_desktop_sessions_status_idx").on(t.status),
  index("nexora_remote_desktop_sessions_expiry_idx").on(t.expiresAt),
  uniqueIndex("nexora_remote_desktop_sessions_action_unique").on(t.privilegedActionId),
  // V1 concurrency policy, enforced by the database rather than by a race in
  // application code: at most one live session per device.
  uniqueIndex("nexora_remote_desktop_sessions_one_live_per_device")
    .on(t.deviceId)
    .where(sql`status in ('REQUESTED','AUTHORIZED','CONNECTING','CONNECTED','ACTIVE','DISCONNECTING')`),
]);

export type RemoteDesktopSession = typeof remoteDesktopSessionsTable.$inferSelect;
