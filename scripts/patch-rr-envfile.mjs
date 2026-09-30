// Postinstall patch: silence Vite 8's `envFile` deprecation warning.
// @react-router/dev hardcodes `envFile: false` in two internal createServer()
// calls (dist/vite.js) that user config cannot reach. `envDir: false` is
// Vite's sanctioned equivalent and behavior-identical here (those servers run
// with configFile:false, so dotenv loading is irrelevant either way).
// Idempotent: exits 0 whether it patches, finds clean code (upstream fixed),
// or the file is absent. Re-applied on every `npm install` via postinstall.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "node_modules", "@react-router", "dev", "dist", "vite.js");

if (!existsSync(target)) {
  console.log("[patch-rr-envfile] @react-router/dev not installed, skipping");
  process.exit(0);
}
const src = readFileSync(target, "utf8");
if (!src.includes("envFile")) {
  console.log("[patch-rr-envfile] no envFile usage, already clean");
  process.exit(0);
}
const patched = src.replaceAll("envFile: false", "envDir: false");
if (patched === src) {
  console.log("[patch-rr-envfile] envFile usage differs from expected, leaving untouched");
  process.exit(0);
}
writeFileSync(target, patched);
console.log("[patch-rr-envfile] replaced envFile:false with envDir:false");
