import crypto from "node:crypto";

export const SIGNING_VERSION = "nexora-agent-sign-v1";
export function canonicalAgentRequest(method: string, path: string, body: Buffer, timestamp: string, nonce: string, agentId: string, keyId: string) {
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  return [SIGNING_VERSION, method.toUpperCase(), path, digest, timestamp, nonce, agentId, keyId].join("\n");
}
export function verifyAgentSignature(publicKey: string, canonical: string, signature: string) {
  try { return crypto.verify("sha256", Buffer.from(canonical, "utf8"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(signature, "base64")); } catch { return false; }
}
