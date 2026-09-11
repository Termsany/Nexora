import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { and, eq, isNull } from "drizzle-orm";
import { agentCredentialsTable, db, devicesTable } from "@workspace/db";
import crypto from "node:crypto";
import { logger } from "../lib/logger.ts";
import { SESSION_COOKIE, resolveSession } from "../auth/sessions.ts";
import { buildTenantContext } from "../tenancy/context.ts";
import { hasPermission } from "../tenancy/policy.ts";
import { recordAudit } from "../tenancy/audit.ts";
import {
  MAX_CONTROL_BYTES, MAX_FRAME_BYTES, MAX_INPUT_EVENTS_PER_SECOND, MAX_VIEWER_FRAME_QUEUE,
  agentMessageSchema, decodeFrame, parseControl, toAgentInput, viewerMessageSchema,
  type ServerToAgent, type ServerToViewer,
} from "./protocol.ts";
import {
  closeSession, getSession, isExpired, markActive, markAgentConnected, markViewerConnected,
  tokenMatches, touch,
} from "./sessions.ts";

/**
 * Remote Desktop gateway.
 *
 * The browser and the Agent each hold one authenticated socket to Nexora and
 * are never introduced to each other. Every byte is re-validated here, and the
 * Agent only ever receives messages this file constructs - a viewer cannot
 * hand it anything, well-formed or not.
 *
 * No unauthenticated endpoint exists: an upgrade that fails authorisation is
 * answered with an HTTP error and the socket destroyed before the WebSocket
 * handshake completes.
 */

const VIEWER_PATH = /^\/api\/v1\/remote-desktop\/sessions\/([0-9a-f-]{36})\/viewer$/;
const AGENT_PATH = /^\/api\/v1\/agent\/remote-desktop\/([0-9a-f-]{36})\/channel$/;

const CAPTURE_FPS = 12;
const CAPTURE_QUALITY = 60;
const CAPTURE_MAX_WIDTH = 1600;
const PING_INTERVAL_MS = 15_000;

type Peer = { socket: WebSocket; alive: boolean };

/** Both halves of one session. Frames flow agent -> viewer, input viewer -> agent. */
type Bridge = {
  sessionId: string;
  deviceId: string;
  organizationId: string;
  viewer: Peer | null;
  agent: Peer | null;
  expiresAt: number;
  inputWindowStart: number;
  inputCount: number;
  framesForwarded: number;
  inputsForwarded: number;
  closing: boolean;
};

const bridges = new Map<string, Bridge>();

function send(peer: Peer | null, message: ServerToViewer | ServerToAgent): void {
  if (!peer || peer.socket.readyState !== peer.socket.OPEN) return;
  try { peer.socket.send(JSON.stringify(message)); } catch { /* socket is going away */ }
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function bridgeFor(sessionId: string): Bridge | undefined {
  return bridges.get(sessionId);
}

async function teardown(bridge: Bridge, reason: string, status: "CLOSED" | "EXPIRED" | "FAILED" = "CLOSED"): Promise<void> {
  if (bridge.closing) return;
  bridge.closing = true;
  bridges.delete(bridge.sessionId);
  send(bridge.viewer, { type: "session.closed", reason });
  send(bridge.agent, { type: "agent.stop", reason });
  // Persist counters before the terminal transition so the record is complete.
  if (bridge.framesForwarded || bridge.inputsForwarded) {
    await touch(bridge.sessionId, { frames: bridge.framesForwarded, inputs: bridge.inputsForwarded }).catch(() => {});
  }
  const row = await closeSession(bridge.sessionId, status, reason).catch(() => null);
  setTimeout(() => {
    try { bridge.viewer?.socket.close(1000, "session closed"); } catch { /* already gone */ }
    try { bridge.agent?.socket.close(1000, "session closed"); } catch { /* already gone */ }
  }, 50);
  if (row) {
    await recordAudit({
      action: status === "EXPIRED" ? "REMOTE_DESKTOP_EXPIRED" : status === "FAILED" ? "REMOTE_DESKTOP_FAILED" : "REMOTE_DESKTOP_DISCONNECTED",
      actorLabel: "system:remote-desktop-gateway",
      organizationId: bridge.organizationId,
      targetType: "remote_desktop_session",
      targetId: bridge.sessionId,
      metadata: { reason, device_id: bridge.deviceId },
    }).catch(() => {});
  }
}

/** Server-side deadline check. Called on every inbound message, not on a timer. */
function enforceDeadline(bridge: Bridge): boolean {
  if (Date.now() < bridge.expiresAt) return false;
  void teardown(bridge, "expired", "EXPIRED");
  return true;
}

// ------------------------------------------------------------------ viewer auth
async function authorizeViewer(request: IncomingMessage, sessionId: string, token: string) {
  const cookies = Object.fromEntries(
    (request.headers.cookie ?? "").split(";").map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }),
  );
  const user = await resolveSession(cookies[SESSION_COOKIE]);
  if (!user) return { error: "unauthenticated" as const };
  const context = await buildTenantContext({ kind: "user", user } as Parameters<typeof buildTenantContext>[0]);

  const session = await getSession(sessionId);
  if (!session) return { error: "not_found" as const };
  // The token is bound to exactly this session row, so a token for another
  // session or device cannot be replayed here.
  if (!tokenMatches(token, session.viewerTokenHash)) return { error: "not_found" as const };
  if (isExpired(session)) return { error: "expired" as const };
  if (!(["AUTHORIZED", "CONNECTING", "CONNECTED", "ACTIVE"] as string[]).includes(session.status)) return { error: "not_authorized" as const };
  // Tenant isolation: membership in the session's organization is required
  // even though the token already matched.
  if (!hasPermission(context, "privileged_actions.request", session.organizationId)) return { error: "not_found" as const };
  return { session, context, user };
}

// ------------------------------------------------------------------- agent auth
async function authorizeAgent(request: IncomingMessage, sessionId: string) {
  const raw = request.headers.authorization;
  if (!raw?.startsWith("Bearer ")) return { error: "unauthenticated" as const };
  const hash = crypto.createHash("sha256").update(raw.slice(7)).digest("hex");
  const [row] = await db.select({ device: devicesTable })
    .from(agentCredentialsTable)
    .innerJoin(devicesTable, eq(agentCredentialsTable.deviceId, devicesTable.id))
    .where(and(eq(agentCredentialsTable.tokenHash, hash), isNull(agentCredentialsTable.revokedAt)));
  if (!row) return { error: "unauthenticated" as const };

  const channelToken = request.headers["x-nexora-session-token"];
  if (typeof channelToken !== "string" || channelToken.length === 0) return { error: "unauthenticated" as const };

  const session = await getSession(sessionId);
  if (!session) return { error: "not_found" as const };
  // Bound to this device: an Agent cannot attach to another device's session
  // even holding a valid credential of its own.
  if (session.deviceId !== row.device.id) return { error: "not_found" as const };
  if (!tokenMatches(channelToken, session.agentTokenHash)) return { error: "not_found" as const };
  if (isExpired(session)) return { error: "expired" as const };
  if (!(["CONNECTING", "CONNECTED", "ACTIVE"] as string[]).includes(session.status)) return { error: "not_authorized" as const };
  return { session, device: row.device };
}

export function attachRemoteDesktopGateway(server: Server): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const viewerMatch = VIEWER_PATH.exec(url.pathname);
    const agentMatch = AGENT_PATH.exec(url.pathname);
    if (!viewerMatch && !agentMatch) return; // not ours; another listener may claim it

    socket.on("error", () => socket.destroy());

    void (async () => {
      try {
        if (viewerMatch) {
          const sessionId = viewerMatch[1]!;
          const token = url.searchParams.get("token") ?? "";
          const outcome = await authorizeViewer(request, sessionId, token);
          if ("error" in outcome) {
            await recordAudit({
              action: "REMOTE_DESKTOP_FAILED", actorLabel: "viewer:unauthorized", organizationId: null,
              targetType: "remote_desktop_session", targetId: sessionId, result: "DENIED",
              metadata: { reason: outcome.error },
            }).catch(() => {});
            return reject(socket, outcome.error === "unauthenticated" ? 401 : 403, "Forbidden");
          }
          wss.handleUpgrade(request, socket, head, (ws) => onViewer(ws, outcome.session, outcome.context.userId));
          return;
        }
        const sessionId = agentMatch![1]!;
        const outcome = await authorizeAgent(request, sessionId);
        if ("error" in outcome) return reject(socket, outcome.error === "unauthenticated" ? 401 : 403, "Forbidden");
        wss.handleUpgrade(request, socket, head, (ws) => onAgent(ws, outcome.session));
      } catch (error) {
        logger.error({ err: error }, "RemoteDesktopUpgradeFailed");
        reject(socket, 500, "Internal Server Error");
      }
    })();
  });

  // ------------------------------------------------------------- viewer socket
  function onViewer(socket: WebSocket, session: Awaited<ReturnType<typeof getSession>> & object, userId: string | null): void {
    const existing = bridgeFor(session.id);
    if (existing?.viewer) {
      // One viewer per session. Never steal: the incumbent keeps control.
      send({ socket, alive: true }, { type: "session.rejected", reason: "session_already_attached" });
      socket.close(1008, "session already attached");
      return;
    }
    const bridge: Bridge = existing ?? {
      sessionId: session.id, deviceId: session.deviceId, organizationId: session.organizationId,
      viewer: null, agent: null, expiresAt: session.expiresAt.getTime(),
      inputWindowStart: Date.now(), inputCount: 0, framesForwarded: 0, inputsForwarded: 0, closing: false,
    };
    const peer: Peer = { socket, alive: true };
    bridge.viewer = peer;
    bridges.set(session.id, bridge);

    send(peer, { type: "session.accepted", sessionId: session.id, deviceId: session.deviceId, expiresAt: session.expiresAt.toISOString() });
    send(peer, { type: "session.status", state: session.status, agentConnected: Boolean(bridge.agent) });
    void markViewerConnected(session.id).catch(() => {});
    void recordAudit({
      action: "REMOTE_DESKTOP_STARTED", actorLabel: userId ? `user:${userId}` : "viewer",
      organizationId: bridge.organizationId, targetType: "remote_desktop_session", targetId: session.id,
      metadata: { device_id: bridge.deviceId },
    }).catch(() => {});

    socket.on("pong", () => { peer.alive = true; });
    socket.on("message", (data, isBinary) => {
      if (enforceDeadline(bridge)) return;
      // A viewer has no reason to send binary; frames only flow the other way.
      if (isBinary) { void teardown(bridge, "protocol_violation", "FAILED"); return; }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const message = parseControl(viewerMessageSchema, buffer);
      if (!message) { send(peer, { type: "session.error", code: "invalid_message" }); return; }

      if (message.type === "session.close") { void teardown(bridge, "viewer_closed"); return; }
      if (message.type === "session.hello") { send(peer, { type: "session.status", state: "ACTIVE", agentConnected: Boolean(bridge.agent) }); return; }
      if (message.type === "session.ping") { send(peer, { type: "session.pong", ...(message.t === undefined ? {} : { t: message.t }) }); return; }

      // Input path. Rate limited per session so a hostile client cannot flood
      // the Agent or starve frame delivery.
      const now = Date.now();
      if (now - bridge.inputWindowStart >= 1000) { bridge.inputWindowStart = now; bridge.inputCount = 0; }
      if (++bridge.inputCount > MAX_INPUT_EVENTS_PER_SECOND) { send(peer, { type: "session.error", code: "input_rate_limited" }); return; }

      const event = toAgentInput(message);
      if (!event) { send(peer, { type: "session.error", code: "invalid_message" }); return; }
      if (!bridge.agent) { send(peer, { type: "session.error", code: "agent_not_connected" }); return; }
      // Reconstructed, never forwarded: the Agent receives our object.
      send(bridge.agent, { type: "agent.input", event });
      bridge.inputsForwarded += 1;
    });

    socket.on("close", () => { if (bridge.viewer === peer) { bridge.viewer = null; void teardown(bridge, "viewer_disconnected"); } });
    socket.on("error", () => { try { socket.close(); } catch { /* already closing */ } });
  }

  // -------------------------------------------------------------- agent socket
  function onAgent(socket: WebSocket, session: Awaited<ReturnType<typeof getSession>> & object): void {
    const existing = bridgeFor(session.id);
    const bridge: Bridge = existing ?? {
      sessionId: session.id, deviceId: session.deviceId, organizationId: session.organizationId,
      viewer: null, agent: null, expiresAt: session.expiresAt.getTime(),
      inputWindowStart: Date.now(), inputCount: 0, framesForwarded: 0, inputsForwarded: 0, closing: false,
    };
    if (bridge.agent) { socket.close(1008, "agent already attached"); return; }
    const peer: Peer = { socket, alive: true };
    bridge.agent = peer;
    bridges.set(session.id, bridge);

    send(peer, { type: "agent.accepted", sessionId: session.id, fps: CAPTURE_FPS, quality: CAPTURE_QUALITY, maxWidth: CAPTURE_MAX_WIDTH });
    send(peer, { type: "agent.start" });
    void markAgentConnected(session.id).catch(() => {});
    send(bridge.viewer, { type: "session.status", state: "CONNECTED", agentConnected: true });
    void recordAudit({
      action: "REMOTE_DESKTOP_AGENT_CONNECTED", actorLabel: `agent:${bridge.deviceId}`,
      organizationId: bridge.organizationId, targetType: "remote_desktop_session", targetId: session.id,
    }).catch(() => {});

    socket.on("pong", () => { peer.alive = true; });
    socket.on("message", (data, isBinary) => {
      if (enforceDeadline(bridge)) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      if (isBinary) {
        const frame = decodeFrame(buffer);
        if (!frame) { void teardown(bridge, "invalid_frame", "FAILED"); return; }
        const viewer = bridge.viewer;
        if (!viewer || viewer.socket.readyState !== viewer.socket.OPEN) return; // nobody watching; drop
        // Backpressure: if the viewer is behind, drop this frame rather than
        // queue it. A stale desktop image has no value, and unbounded queueing
        // is how a slow client turns into a server memory leak.
        if (viewer.socket.bufferedAmount > MAX_VIEWER_FRAME_QUEUE * MAX_FRAME_BYTES) return;
        try { viewer.socket.send(buffer, { binary: true }); bridge.framesForwarded += 1; } catch { /* viewer gone */ }
        return;
      }

      const message = parseControl(agentMessageSchema, buffer);
      if (!message) { void teardown(bridge, "invalid_message", "FAILED"); return; }
      switch (message.type) {
        case "agent.hello": break;
        case "agent.desktop.info":
          void markActive(session.id, { width: message.width, height: message.height }).catch(() => {});
          send(bridge.viewer, { type: "desktop.info", width: message.width, height: message.height, displays: message.displays });
          break;
        case "agent.status":
          send(bridge.viewer, { type: "session.status", state: message.state, agentConnected: true });
          break;
        case "agent.error":
          send(bridge.viewer, { type: "session.error", code: message.code });
          break;
        case "agent.pong": break;
      }
    });

    socket.on("close", () => { if (bridge.agent === peer) { bridge.agent = null; void teardown(bridge, "agent_disconnected"); } });
    socket.on("error", () => { try { socket.close(); } catch { /* already closing */ } });
  }

  // Liveness + deadline sweep for sockets that stop talking without closing.
  const heartbeat = setInterval(() => {
    for (const bridge of [...bridges.values()]) {
      if (Date.now() >= bridge.expiresAt) { void teardown(bridge, "expired", "EXPIRED"); continue; }
      for (const peer of [bridge.viewer, bridge.agent]) {
        if (!peer) continue;
        if (!peer.alive) { try { peer.socket.terminate(); } catch { /* gone */ } continue; }
        peer.alive = false;
        try { peer.socket.ping(); } catch { /* gone */ }
      }
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref?.();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const bridge of [...bridges.values()]) void teardown(bridge, "server_shutdown");
      wss.close();
    },
  };
}

/** Force a live session's sockets down, used when a session is terminated over REST. */
export function terminateBridge(sessionId: string, reason: string): void {
  const bridge = bridgeFor(sessionId);
  if (bridge) void teardown(bridge, reason);
}

export function activeBridgeCount(): number {
  return bridges.size;
}
