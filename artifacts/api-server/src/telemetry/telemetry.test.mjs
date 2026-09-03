import assert from "node:assert/strict";
import test from "node:test";
import { groupDiskPoints, historicalRange } from "./history-query.ts";
import { classifyHealth, downtimeSummary } from "./monitoring.ts";
import { retentionCutoffs } from "./policy.ts";
import { runTelemetryMaintenance } from "./maintenance.ts";

const now = new Date("2026-08-21T12:00:00Z");
test("historical ranges default to one hour and auto-select deterministic resolutions", () => {
  assert.equal(historicalRange({}, now).resolution, "raw");
  assert.equal(historicalRange({ from: "2026-08-21T06:00:00Z", to: now.toISOString(), resolution: "auto" }).resolution, "raw");
  assert.equal(historicalRange({ from: "2026-08-14T12:00:00Z", to: now.toISOString(), resolution: "auto" }).resolution, "hour");
  assert.equal(historicalRange({ from: "2026-08-21T00:00:00Z", to: now.toISOString(), resolution: "auto" }).resolution, "hour");
  assert.equal(historicalRange({ from: "2026-08-01T00:00:00Z", to: now.toISOString(), resolution: "auto" }).resolution, "day");
  assert.equal(historicalRange({ resolution: "hour" }, now).resolution, "hour");
  assert.equal(historicalRange({ resolution: "day" }, now).resolution, "day");
});
test("historical ranges reject invalid, reversed, excessive, and unsupported raw ranges", () => {
  assert.throws(() => historicalRange({ from: "invalid", to: now.toISOString() }), /Invalid/);
  assert.throws(() => historicalRange({ from: now.toISOString(), to: "2026-08-20T00:00:00Z" }), /earlier/);
  assert.throws(() => historicalRange({ from: "2025-01-01T00:00:00Z", to: now.toISOString() }), /365/);
  assert.throws(() => historicalRange({ from: "2026-08-01T00:00:00Z", to: now.toISOString(), resolution: "raw" }), /7 days/);
  assert.throws(() => historicalRange({ resolution: "week" }), /Unsupported resolution/);
});
test("health uses five-sample CPU and memory averages with offline precedence", () => {
  const healthy = Array.from({ length: 4 }, () => ({ cpuPercent: 20, ramPercent: 30, diskPercent: 40 }));
  assert.equal(classifyHealth("ONLINE", [{ cpuPercent: 100, ramPercent: 30, diskPercent: 40 }, ...healthy]), "HEALTHY");
  assert.equal(classifyHealth("ONLINE", Array.from({ length: 5 }, () => ({ cpuPercent: 96, ramPercent: 20, diskPercent: 30 }))), "CRITICAL");
  assert.equal(classifyHealth("ONLINE", [{ cpuPercent: 1, ramPercent: 1, diskPercent: 86 }]), "WARNING");
  assert.equal(classifyHealth("OFFLINE", [{ cpuPercent: 100, ramPercent: 100, diskPercent: 100 }]), "OFFLINE");
  assert.equal(classifyHealth("UNKNOWN", [{ cpuPercent: 100, ramPercent: 100, diskPercent: 100 }]), "UNKNOWN");
  assert.equal(classifyHealth("ONLINE", []), "UNKNOWN");
});
test("downtime pairs only completed outages and labels ongoing outages", () => {
  const summary = downtimeSummary([{ event: "ONLINE_TO_OFFLINE", timestamp: new Date("2026-08-21T10:00:00Z") }, { event: "OFFLINE_TO_ONLINE", timestamp: new Date("2026-08-21T10:05:00Z") }, { event: "ONLINE_TO_OFFLINE", timestamp: new Date("2026-08-21T11:00:00Z") }], now);
  assert.equal(summary.last_completed_outage_seconds, 300);
  assert.equal(summary.ongoing_outage_seconds, 3600);
});
test("multi-disk points remain isolated by volume", () => {
  const grouped = groupDiskPoints([{ volume: "C:\\", value: 70 }, { volume: "D:\\", value: 20 }, { volume: "C:\\", value: 71 }]);
  assert.deepEqual(grouped.map((item) => [item.volume, item.points.length]), [["C:\\", 2], ["D:\\", 1]]);
});
test("retention cutoffs are exact", () => {
  const cutoffs = retentionCutoffs(now);
  assert.equal((now.getTime() - cutoffs.raw.getTime()) / 86400000, 7);
  assert.equal((now.getTime() - cutoffs.hour.getTime()) / 86400000, 90);
  assert.equal((now.getTime() - cutoffs.day.getTime()) / 86400000, 365);
});
test("maintenance is idempotent SQL and aggregates before cleanup", async () => {
  const statements = [];
  const client = { query: async (sql) => { statements.push(String(sql)); return { rowCount: 0 }; } };
  await runTelemetryMaintenance(client);
  assert.equal(statements.filter((sql) => sql.includes("ON CONFLICT")).length, 4);
  assert.ok(statements.findIndex((sql) => sql.includes("INSERT INTO")) < statements.findIndex((sql) => sql.includes("DELETE FROM")));
  assert.equal(statements.at(0), "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
});
test("maintenance rolls back a failed aggregation before cleanup", async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(String(sql));
    if (String(sql).includes("INSERT INTO nexora_disk_metric_aggregates")) throw new Error("fixture failure");
    return { rowCount: 0 };
  } };
  await assert.rejects(runTelemetryMaintenance(client), /fixture failure/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM")), false);
});
