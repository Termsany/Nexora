import assert from "node:assert/strict";
import test from "node:test";
import { canInferDisappearance, processIdentity, serviceEvents } from "./semantics.ts";

test("service baseline and partial snapshots never create change events", () => {
  const prior={status:"STOPPED",startup_type:"MANUAL",is_present:true};
  assert.deepEqual(serviceEvents(prior,{status:"RUNNING",startup_type:"AUTOMATIC"},true,true),[]);
  assert.deepEqual(serviceEvents(prior,{status:"RUNNING",startup_type:"AUTOMATIC"},false,false),[]);
  assert.equal(canInferDisappearance("PARTIAL"),false);
  assert.equal(canInferDisappearance("FAILED"),false);
});

test("service status, startup and added changes are deterministic", () => {
  const changes=serviceEvents({status:"STOPPED",startup_type:"MANUAL",is_present:true},{status:"RUNNING",startup_type:"AUTOMATIC"},false,true);
  assert.deepEqual(changes.map(x=>x.type),["STATUS_CHANGED","STARTUP_TYPE_CHANGED"]);
  assert.equal(serviceEvents(undefined,{status:"RUNNING",startup_type:"AUTOMATIC"},false,true)[0].type,"SERVICE_ADDED");
});

test("process identity distinguishes PID reuse", () => {
  assert.notEqual(processIdentity(42,"2026-01-01T00:00:00Z"),processIdentity(42,"2026-01-01T00:01:00Z"));
});
