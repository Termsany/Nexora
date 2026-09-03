import crypto from "node:crypto";

export type SoftwareArchitecture = "x64" | "x86" | "unknown";

export function normalizeSoftwareText(value?: string | null) {
  return sanitizeSoftwareText(value)?.toLowerCase().replace(/\s+/g, " ") ?? "";
}

export function sanitizeSoftwareText(value?: string | null) {
  const clean = (value ?? "").replaceAll("\0", "").trim();
  return clean || null;
}

export function softwareIdentity(name: string, publisher: string | null | undefined, architecture: SoftwareArchitecture) {
  return crypto.createHash("sha256").update(`${normalizeSoftwareText(publisher)}|${normalizeSoftwareText(name)}|${architecture}`).digest("hex");
}
