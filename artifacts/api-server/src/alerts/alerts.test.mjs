import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDisks, evaluateOffline, evaluateSustained } from "./evaluation.ts";

const now = new Date("2026-08-21T12:00:00Z");
const metrics = (cpu, ram, count = 5, ageStep = 30) => Array.from({ length: count }, (_, index) => ({ cpuPercent: Array.isArray(cpu) ? cpu[index] : cpu, ramPercent: Array.isArray(ram) ? ram[index] : ram, receivedAt: new Date(now.getTime() - index * ageStep * 1000) }));
const decision = (samples, index) => evaluateSustained("device-1", samples, now)[index];

test("CPU sustained warning and critical use the latest five-sample average", () => {
  assert.deepEqual([decision(metrics(84, 20), 0).decision, decision(metrics(84, 20), 0).severity], ["trigger", "warning"]);
  assert.deepEqual([decision(metrics(97, 20), 0).decision, decision(metrics(97, 20), 0).severity], ["trigger", "critical"]);
});

test("a single CPU spike is ignored by the sustained average", () => {
  assert.equal(decision(metrics([100, 20, 20, 20, 20], 20), 0).decision, "recover");
});

test("CPU recovery and hysteresis are deterministic", () => {
  assert.equal(decision(metrics(69, 20), 0).decision, "recover");
  assert.equal(decision(metrics(75, 20), 0).decision, "hold");
});

test("memory warning, critical, recovery, and hysteresis match policy", () => {
  assert.deepEqual([decision(metrics(20, 82), 1).decision, decision(metrics(20, 82), 1).severity], ["trigger", "warning"]);
  assert.equal(decision(metrics(20, 96), 1).severity, "critical");
  assert.equal(decision(metrics(20, 69), 1).decision, "recover");
  assert.equal(decision(metrics(20, 75), 1).decision, "hold");
});

test("incomplete or stale sustained telemetry is unavailable", () => {
  assert.equal(decision(metrics(99, 99, 4), 0).decision, "unavailable");
  const stale = metrics(99, 99).map((item) => ({ ...item, receivedAt: new Date(item.receivedAt.getTime() - 91_000) }));
  assert.equal(decision(stale, 0).decision, "unavailable");
});

test("disk warning, critical, hysteresis, and recovery use latest fresh values", () => {
  const values = [86, 96, 82, 79].map((usedPercent, index) => ({ volume: `${index}:`, usedPercent, receivedAt: now }));
  const decisions = evaluateDisks("device-1", values, now);
  assert.deepEqual(decisions.map((item) => [item.decision, item.severity]), [["trigger", "warning"], ["trigger", "critical"], ["hold", undefined], ["recover", undefined]]);
});

test("disk volumes are isolated and stale disk telemetry is unavailable", () => {
  const decisions = evaluateDisks("device-1", [{ volume: "C:", usedPercent: 90, receivedAt: now }, { volume: "D:", usedPercent: 20, receivedAt: now }, { volume: "E:", usedPercent: 99, receivedAt: new Date(now.getTime() - 91_000) }], now);
  assert.deepEqual(decisions.map((item) => [item.resource, item.decision]), [["C:", "trigger"], ["D:", "recover"], ["E:", "unavailable"]]);
  assert.equal(new Set(decisions.map((item) => item.dedupKey)).size, 3);
});

test("offline signal uses one stable dedup key and recovers online", () => {
  const offline = evaluateOffline("device-1", true);
  const online = evaluateOffline("device-1", false);
  assert.equal(offline.severity, "critical");
  assert.equal(offline.decision, "trigger");
  assert.equal(online.decision, "recover");
  assert.equal(offline.dedupKey, online.dedupKey);
});
