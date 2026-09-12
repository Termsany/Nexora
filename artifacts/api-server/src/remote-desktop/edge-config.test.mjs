import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Edge configuration. A WebSocket that silently fails to upgrade looks exactly
 * like a broken gateway, so the nginx contract is pinned here rather than
 * rediscovered during a customer session.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const nginx = readFileSync(path.join(repo, "docker/nginx.conf"), "utf8");

/** The Remote Desktop location block, isolated from the rest of the file. */
function remoteDesktopLocation() {
  const start = nginx.indexOf("location ~ ^/api/v1/(remote-desktop/sessions");
  assert.ok(start > 0, "Remote Desktop websocket location is missing");
  let depth = 0;
  for (let index = nginx.indexOf("{", start); index < nginx.length; index++) {
    if (nginx[index] === "{") depth++;
    else if (nginx[index] === "}" && --depth === 0) return nginx.slice(start, index + 1);
  }
  throw new Error("unbalanced location block");
}

test("both websocket paths are matched, and nothing else", () => {
  const block = remoteDesktopLocation();
  assert.match(block, /remote-desktop\/sessions\/\[0-9a-f-\]\+\/viewer/);
  assert.match(block, /agent\/remote-desktop\/\[0-9a-f-\]\+\/channel/);
});

test("the upgrade handshake is actually proxied", () => {
  const block = remoteDesktopLocation();
  // All three are required; any one missing and the socket never opens.
  assert.match(block, /proxy_http_version\s+1\.1;/);
  assert.match(block, /proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
  assert.match(block, /proxy_set_header\s+Connection\s+"upgrade";/);
});

test("long-lived quiet sessions are not dropped by the edge", () => {
  const block = remoteDesktopLocation();
  const read = /proxy_read_timeout\s+(\d+)s;/.exec(block);
  assert.ok(read, "proxy_read_timeout must be set");
  // A static screen sends nothing; the 60s default would kill healthy sessions.
  assert.ok(Number(read[1]) >= 600, `read timeout ${read[1]}s is too short for a desktop stream`);
  assert.match(block, /proxy_buffering\s+off;/);
});

test("no new external port is introduced", () => {
  const listens = [...nginx.matchAll(/^\s*listen\s+([^;]+);/gm)].map((match) => match[1].trim());
  // Unchanged from before Remote Desktop: the standard HTTP/HTTPS listeners.
  for (const listen of listens) assert.match(listen, /^(80|443)\b/, `unexpected listener: ${listen}`);
});

test("the ordinary /api/ proxy is left intact", () => {
  assert.ok(nginx.includes("location /api/ {"), "the plain API location must still exist");
  const plain = nginx.slice(nginx.indexOf("location /api/ {"));
  // The generic block must NOT have become an upgrade proxy for everything.
  const body = plain.slice(0, plain.indexOf("\n    }"));
  assert.ok(!body.includes("$http_upgrade"), "upgrade handling must stay scoped to the websocket location");
});

test("the agent is not exposed through the edge", () => {
  // Only the two session paths are proxied; nothing routes inbound to a device.
  assert.ok(!/proxy_pass\s+http:\/\/[^;]*agent[^;]*;/.test(nginx));
});
