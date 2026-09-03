import { index, pgEnum, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { devicesTable } from "./nexora";

export const agentSigningKeyStatusEnum = pgEnum("agent_signing_key_status", ["ACTIVE", "REVOKED", "REPLACED"]);
export const agentSigningKeysTable = pgTable("nexora_agent_signing_keys", {
  id: uuid("id").defaultRandom().primaryKey(), deviceId: uuid("device_id").notNull().references(() => devicesTable.id, { onDelete: "cascade" }), algorithm: text("algorithm").notNull(), publicKey: text("public_key").notNull(), keyFingerprint: text("key_fingerprint").notNull(), protocolVersion: text("protocol_version").notNull().default("remote_command_v1"), status: agentSigningKeyStatusEnum("status").notNull().default("ACTIVE"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(), revokedAt: timestamp("revoked_at", { withTimezone: true }), replacedBy: uuid("replaced_by"),
}, (t) => [index("nexora_agent_signing_keys_device_idx").on(t.deviceId), uniqueIndex("nexora_agent_signing_keys_active_device_idx").on(t.deviceId, t.status)]);
