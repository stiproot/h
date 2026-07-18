#!/usr/bin/env node
// Toolchain guard — fail LOUDLY when `tsc` is a no-op.
//
// bun's package store can leave `node_modules/.bin/tsc` pointing at a 0-byte `bin/tsc`
// stub, so `tsc --noEmit` / `tsc -p …` exit 0 while doing NOTHING — turning every
// `bun run lint` / `bun run build` into a hollow green (typechecks that check nothing,
// builds that emit no `dist/`). turbo faithfully runs `tsc`; `tsc` faithfully does nothing.
//
// This guard runs the repo's OWN tsc and asserts it actually (a) reports a version and
// (b) catches a deliberate type error, so a broken compiler can never pass silently. It is
// the first step of `bun run lint` (see package.json). Escape hatch: TSC_BIN overrides the
// binary (used by tests); there is deliberately no skip flag — a hollow green is worse than red.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = process.env.TSC_BIN || resolve(root, "node_modules/.bin/tsc");

function die(reason) {
  console.error(`\n\x1b[31m✗ toolchain check failed:\x1b[0m ${reason}`);
  console.error(
    "\n  `tsc` is not doing its job — lint/build would be a HOLLOW GREEN (checks that\n" +
      "  check nothing). Known cause: bun's store leaves node_modules/.bin/tsc as a 0-byte\n" +
      "  stub. Fix: `rm -rf node_modules && bun install`; if that doesn't repair it, run the\n" +
      "  compiler directly via `node node_modules/typescript/lib/_tsc.js`. Details:\n" +
      "  memory/tsc-launcher-noop.md.\n",
  );
  process.exit(1);
}

if (!process.env.TSC_BIN && !existsSync(tsc)) {
  die(`no tsc at ${tsc} — run \`bun install\` first.`);
}

// (a) It must report a version. An empty-stub launcher throws (ENOEXEC) or prints nothing.
let version = "";
try {
  version = execFileSync(tsc, ["--version"], { encoding: "utf8" }).trim();
} catch (e) {
  die(`\`tsc --version\` could not run (${e.code ?? e.message}).`);
}
if (!/^Version \d+\.\d+/.test(version)) {
  die(`\`tsc --version\` produced no version output (got ${JSON.stringify(version)}).`);
}

// (b) It must actually typecheck — a deliberate error must be caught (non-zero exit).
const dir = mkdtempSync(join(tmpdir(), "tsc-check-"));
const badFile = join(dir, "bad.ts");
writeFileSync(badFile, 'const n: number = "definitely not a number";\nexport { n };\n');
let caughtTheError = false;
try {
  execFileSync(tsc, ["--noEmit", "--skipLibCheck", badFile], { stdio: "pipe" });
} catch {
  caughtTheError = true; // non-zero exit ⇒ tsc reported the type error, as it should
}
rmSync(dir, { recursive: true, force: true });
if (!caughtTheError) {
  die("tsc did NOT catch a deliberate type error — it is a no-op.");
}

console.log(`✓ toolchain: tsc ${version} is functional (typecheck verified)`);
