import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSoftwareText, sanitizeSoftwareText, softwareIdentity } from "./identity.ts";

test("software normalization is deterministic and version independent", () => {
  assert.equal(normalizeSoftwareText(" Google   Chrome "), "google chrome");
  assert.equal(softwareIdentity("Google Chrome", "Google LLC", "x64"), softwareIdentity(" google  chrome ", " google llc ", "x64"));
  assert.notEqual(softwareIdentity("Google Chrome", "Google LLC", "x64"), softwareIdentity("Google Chrome", "Google LLC", "x86"));
  assert.notEqual(softwareIdentity("Product", "Vendor A", "x64"), softwareIdentity("Product", "Vendor B", "x64"));
  assert.equal(sanitizeSoftwareText("App\0\0 "), "App");
  assert.equal(normalizeSoftwareText(" App\0  Name "), "app name");
});
