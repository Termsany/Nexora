import { z } from "zod";

/**
 * Remote Desktop V1 wire contract.
 *
 * Nothing is tunnelled. The browser and the Agent speak two DIFFERENT
 * protocols, and the gateway translates between them - a viewer can therefore
 * never hand the Agent a message it did not construct itself. Unknown types
 * and oversized payloads are rejected before any handler sees them.
 */

/** Control frames are JSON text and are tiny; anything larger is hostile or broken. */
export const MAX_CONTROL_BYTES = 8 * 1024;
/** A single encoded desktop frame. Generous for 1080p JPEG, far below memory risk. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Input is cheap but must not be a flood vector. Per session, per second. */
export const MAX_INPUT_EVENTS_PER_SECOND = 200;
/** Frames queued toward one viewer before we start dropping the oldest. */
export const MAX_VIEWER_FRAME_QUEUE = 2;

const finite = z.number().finite();
/** Normalised 0..1 device-independent coordinates; the Agent maps to pixels. */
const unit = finite.min(0).max(1);

export const MOUSE_BUTTONS = ["LEFT", "RIGHT", "MIDDLE"] as const;
export const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

const modifiers = z.object({
  ctrl: z.boolean(), alt: z.boolean(), shift: z.boolean(), meta: z.boolean(),
}).strict();

/**
 * Keys travel as W3C KeyboardEvent.code values, never as characters. The Agent
 * maps a code to a virtual-key and injects it through SendInput. There is no
 * path by which a key name becomes a string the Agent could execute.
 */
const keyCode = z.string().regex(/^[A-Za-z0-9]{1,24}$/, "unsupported key code");

// ---------------------------------------------------------------- viewer -> server
export const viewerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.hello"), protocol: z.literal("nexora-remote-desktop-v1") }).strict(),
  z.object({ type: z.literal("input.mouse.move"), x: unit, y: unit }).strict(),
  z.object({ type: z.literal("input.mouse.button"), x: unit, y: unit, button: z.enum(MOUSE_BUTTONS), pressed: z.boolean() }).strict(),
  z.object({ type: z.literal("input.mouse.wheel"), x: unit, y: unit, deltaY: finite.min(-10_000).max(10_000) }).strict(),
  z.object({ type: z.literal("input.keyboard.keydown"), code: keyCode, modifiers }).strict(),
  z.object({ type: z.literal("input.keyboard.keyup"), code: keyCode, modifiers }).strict(),
  z.object({ type: z.literal("session.ping"), t: finite.optional() }).strict(),
  z.object({ type: z.literal("session.close") }).strict(),
]);
export type ViewerMessage = z.infer<typeof viewerMessageSchema>;

// ---------------------------------------------------------------- agent -> server
export const agentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.hello"), protocol: z.literal("nexora-remote-desktop-v1"), agentVersion: z.string().max(32) }).strict(),
  z.object({
    type: z.literal("agent.desktop.info"),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    displays: z.number().int().min(1).max(16),
  }).strict(),
  z.object({ type: z.literal("agent.status"), state: z.enum(["CAPTURING", "PAUSED"]) }).strict(),
  // Reason codes only. Never a stack trace, path, or screen content.
  z.object({ type: z.literal("agent.error"), code: z.string().regex(/^[a-z_]{1,48}$/) }).strict(),
  z.object({ type: z.literal("agent.pong"), t: finite.optional() }).strict(),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;

// ---------------------------------------------------------------- server -> viewer
export type ServerToViewer =
  | { type: "session.accepted"; sessionId: string; deviceId: string; expiresAt: string }
  | { type: "session.rejected"; reason: string }
  | { type: "desktop.info"; width: number; height: number; displays: number }
  | { type: "session.status"; state: string; agentConnected: boolean }
  | { type: "session.error"; code: string }
  | { type: "session.closed"; reason: string }
  | { type: "session.pong"; t?: number };

// ---------------------------------------------------------------- server -> agent
export type ServerToAgent =
  | { type: "agent.accepted"; sessionId: string; fps: number; quality: number; maxWidth: number }
  | { type: "agent.rejected"; reason: string }
  | { type: "agent.start" }
  | { type: "agent.stop"; reason: string }
  | { type: "agent.input"; event: AgentInputEvent }
  | { type: "agent.ping"; t?: number };

/** The only shapes the Agent will act on. Derived from a validated viewer message, never forwarded raw. */
export type AgentInputEvent =
  | { kind: "mouse_move"; x: number; y: number }
  | { kind: "mouse_button"; x: number; y: number; button: (typeof MOUSE_BUTTONS)[number]; pressed: boolean }
  | { kind: "mouse_wheel"; x: number; y: number; deltaY: number }
  | { kind: "key"; code: string; pressed: boolean; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

/**
 * Translate a validated viewer message into the Agent's input vocabulary.
 * Returns null for anything that is not an input event, which keeps session
 * control messages from ever reaching the Agent.
 */
export function toAgentInput(message: ViewerMessage): AgentInputEvent | null {
  switch (message.type) {
    case "input.mouse.move": return { kind: "mouse_move", x: message.x, y: message.y };
    case "input.mouse.button": return { kind: "mouse_button", x: message.x, y: message.y, button: message.button, pressed: message.pressed };
    case "input.mouse.wheel": return { kind: "mouse_wheel", x: message.x, y: message.y, deltaY: message.deltaY };
    case "input.keyboard.keydown": return { kind: "key", code: message.code, pressed: true, ...message.modifiers };
    case "input.keyboard.keyup": return { kind: "key", code: message.code, pressed: false, ...message.modifiers };
    default: return null;
  }
}

/** Frame wire format: 4-byte big-endian sequence number, then the encoded image. */
export const FRAME_HEADER_BYTES = 4;

export function decodeFrame(data: Buffer): { sequence: number; image: Buffer } | null {
  if (data.length <= FRAME_HEADER_BYTES || data.length > MAX_FRAME_BYTES) return null;
  return { sequence: data.readUInt32BE(0), image: data.subarray(FRAME_HEADER_BYTES) };
}

/** Parse a control message, enforcing the size cap before touching the JSON parser. */
export function parseControl<T extends z.ZodTypeAny>(schema: T, raw: Buffer): z.infer<T> | null {
  if (raw.length === 0 || raw.length > MAX_CONTROL_BYTES) return null;
  let candidate: unknown;
  try { candidate = JSON.parse(raw.toString("utf8")); } catch { return null; }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
