import crypto from "node:crypto";

export function csrfTokenForSession(rawSessionToken: string) {
  return crypto.createHmac("sha256", rawSessionToken).update("nexora-csrf-v1").digest("base64url");
}
