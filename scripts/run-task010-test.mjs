import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(path.join(root, "artifacts/api-server/package.json"))("esbuild");
const output = "/tmp/nexora-task010-integration.mjs";
await build({
  entryPoints: [path.join(root, "artifacts/api-server/src/task010.integration.mjs")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: false,
  tsconfig: path.join(root, "tsconfig.json"),
});
await import(`file://${output}`);
