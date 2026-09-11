import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTROL_BYTES, MAX_FRAME_BYTES, agentMessageSchema, decodeFrame,
  parseControl, toAgentInput, viewerMessageSchema,
} from "./protocol.ts";

const control = (value) => Buffer.from(JSON.stringify(value), "utf8");

test("accepts the documented viewer messages", () => {
  const accepted = [
    { type: "session.hello", protocol: "nexora-remote-desktop-v1" },
    { type: "input.mouse.move", x: 0, y: 1 },
    { type: "input.mouse.button", x: 0.5, y: 0.5, button: "LEFT", pressed: true },
    { type: "input.mouse.wheel", x: 0.5, y: 0.5, deltaY: -120 },
    { type: "input.keyboard.keydown", code: "KeyA", modifiers: { ctrl: true, alt: false, shift: false, meta: false } },
    { type: "session.close" },
  ];
  for (const message of accepted) {
    assert.ok(parseControl(viewerMessageSchema, control(message)), `${message.type} should parse`);
  }
});

test("rejects unknown message types outright", () => {
  for (const type of ["input.mouse.teleport", "session.escalate", "agent.start", "", "__proto__"]) {
    assert.equal(parseControl(viewerMessageSchema, control({ type })), null, `${type} must be rejected`);
  }
});

test("rejects extra properties so nothing rides along unnoticed", () => {
  const smuggled = { type: "input.mouse.move", x: 0.5, y: 0.5, command: "shutdown /s" };
  assert.equal(parseControl(viewerMessageSchema, control(smuggled)), null);
});

test("rejects out-of-range and non-finite coordinates", () => {
  for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
    assert.equal(parseControl(viewerMessageSchema, control({ type: "input.mouse.move", x: value, y: 0.5 })), null, `x=${value}`);
  }
});

test("rejects key codes outside the allowed shape", () => {
  const modifiers = { ctrl: false, alt: false, shift: false, meta: false };
  for (const code of ["Key A", "../../etc/passwd", "a".repeat(25), "Key-A", "", "Key;rm"]) {
    assert.equal(parseControl(viewerMessageSchema, control({ type: "input.keyboard.keydown", code, modifiers })), null, `code=${JSON.stringify(code)}`);
  }
  assert.ok(parseControl(viewerMessageSchema, control({ type: "input.keyboard.keydown", code: "KeyA", modifiers })));
});

test("requires a complete modifier set rather than assuming false", () => {
  assert.equal(parseControl(viewerMessageSchema, control({ type: "input.keyboard.keyup", code: "KeyA", modifiers: { ctrl: true } })), null);
});

test("rejects oversized and empty control payloads before parsing", () => {
  assert.equal(parseControl(viewerMessageSchema, Buffer.alloc(0)), null);
  assert.equal(parseControl(viewerMessageSchema, Buffer.alloc(MAX_CONTROL_BYTES + 1, 0x20)), null);
});

test("rejects malformed JSON without throwing", () => {
  assert.equal(parseControl(viewerMessageSchema, Buffer.from("{not json", "utf8")), null);
});

test("agent error codes are constrained to reason codes", () => {
  assert.ok(parseControl(agentMessageSchema, control({ type: "agent.error", code: "capture_failed" })));
  // A stack trace or path must never be accepted as an error code.
  assert.equal(parseControl(agentMessageSchema, control({ type: "agent.error", code: "C:\\Users\\bob\\secret.txt" })), null);
  assert.equal(parseControl(agentMessageSchema, control({ type: "agent.error", code: "Capture Failed" })), null);
});

test("agent screen geometry is bounded", () => {
  assert.ok(parseControl(agentMessageSchema, control({ type: "agent.desktop.info", width: 1920, height: 1080, displays: 2 })));
  for (const bad of [{ width: 0, height: 1080, displays: 1 }, { width: 99999, height: 1080, displays: 1 }, { width: 1920, height: 1080, displays: 99 }]) {
    assert.equal(parseControl(agentMessageSchema, control({ type: "agent.desktop.info", ...bad })), null);
  }
});

test("viewer control messages never translate into agent input", () => {
  // session.* must not be able to reach the Agent in any form.
  for (const message of [{ type: "session.hello", protocol: "nexora-remote-desktop-v1" }, { type: "session.close" }, { type: "session.ping" }]) {
    const parsed = parseControl(viewerMessageSchema, control(message));
    assert.ok(parsed);
    assert.equal(toAgentInput(parsed), null, `${message.type} must not become agent input`);
  }
});

test("translation produces only the agent's own vocabulary", () => {
  const move = toAgentInput(parseControl(viewerMessageSchema, control({ type: "input.mouse.move", x: 0.25, y: 0.75 })));
  assert.deepEqual(move, { kind: "mouse_move", x: 0.25, y: 0.75 });

  const key = toAgentInput(parseControl(viewerMessageSchema, control({
    type: "input.keyboard.keydown", code: "KeyC", modifiers: { ctrl: true, alt: false, shift: false, meta: false },
  })));
  assert.deepEqual(key, { kind: "key", code: "KeyC", pressed: true, ctrl: true, alt: false, shift: false, meta: false });
  // The translated object carries no field the viewer chose the name of.
  assert.deepEqual(Object.keys(key).sort(), ["alt", "code", "ctrl", "kind", "meta", "pressed", "shift"]);
});

test("frame decoding enforces the header and the size ceiling", () => {
  const framed = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("jpegdata")]);
  assert.deepEqual(decodeFrame(framed), { sequence: 7, image: Buffer.from("jpegdata") });
  assert.equal(decodeFrame(Buffer.alloc(4)), null, "header with no payload is not a frame");
  assert.equal(decodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), null, "oversized frame is refused");
});
