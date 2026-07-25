#!/usr/bin/env node
// Toolchain guard — fail LOUDLY when a toolchain binary is a silent no-op.
//
// bun's package store can leave a tool's launcher as a 0-byte stub (`node_modules/.bin/<tool>`
// resolving to an empty file). Two symptoms, same class:
//   - `tsc` hollow → `tsc --noEmit`/`tsc -p …` exit 0 while doing NOTHING — every `bun run lint`/
//     `bun run build` becomes a HOLLOW GREEN (typechecks that check nothing, builds that emit no dist).
//   - a NATIVE binary hollow (turbo/oxlint/oxfmt/tsgo/tsgolint) → it exits NONZERO with NO output, so
//     every `cli/scripts/run-*.sh` (which opens with `bunx turbo build`) dies cryptically and the
//     host stack silently won't come up. Root cause: a cross-uid-POISONED bun cache under
//     `fs.protected_hardlinks=1` (an agent uid populated the shared ~/.bun cache; the host user then
//     can't hardlink those entries → 0-byte placeholders). See the `Toolchain guard` gotcha in CLAUDE.md.
//
// This guard asserts (native) the native binaries are non-hollow and turbo actually runs, and (tsc)
// the compiler reports a version AND catches a deliberate type error — so a broken toolchain can
// never pass silently. Modes: default runs BOTH; `--native-only` runs just the native check (fast,
// no compile) — used by the run scripts before `bunx turbo build`. It is also the first step of
// `bun run lint`/`build` (see package.json). Escape hatch: TSC_BIN overrides the tsc binary (tests);
// there is deliberately no skip flag — a hollow green is worse than red.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = process.env.TSC_BIN || resolve(root, "node_modules/.bin/tsc");
const nativeOnly = process.argv.includes("--native-only");

// The no-sudo repair recipe, shared by every hollow-toolchain failure.
const REPAIR =
  "\n  Repair (no sudo — heals the default bun cache in place):\n" +
  "    find ~/.bun/install/cache -mindepth 1 ! -uid $(id -u) -print0 | xargs -0 -r rm -rf --\n" +
  "    rm -rf node_modules && bun install --frozen-lockfile\n" +
  "  (bun re-fetches the removed packages as YOU and hardlinks clean.) Full detail: the\n" +
  "  `Toolchain guard` gotcha in CLAUDE.md + memory/tsc-launcher-noop.md.\n";

function die(reason, extra) {
  console.error(`\n\x1b[31m✗ toolchain check failed:\x1b[0m ${reason}`);
  console.error(extra ?? REPAIR);
  process.exit(1);
}

// (native) The native binaries must not be 0-byte stubs, and turbo must actually run — a hollow
// turbo is what makes every run-*.sh die at its opening `bunx turbo build`.
const NATIVE_BINS = ["turbo", "oxlint", "oxfmt", "tsgo", "tsgolint"];
function checkNativeBins() {
  for (const name of NATIVE_BINS) {
    const link = resolve(root, "node_modules/.bin", name);
    if (!existsSync(link)) continue; // absent (optional tool) — not this guard's concern
    let target;
    try {
      target = realpathSync(link);
    } catch (e) {
      die(`native binary '${name}' does not resolve (${e.code ?? e.message}).`);
    }
    if (statSync(target).size === 0) {
      die(`native binary '${name}' is a 0-byte stub (${target}).`);
    }
  }
  // turbo is the run-script-critical tool — probe it emits a version (a non-hollow-but-broken
  // turbo, e.g. a missing @turbo/<platform> dep, still fails silently).
  const turbo = resolve(root, "node_modules/.bin/turbo");
  if (existsSync(turbo)) {
    let v = "";
    try {
      v = execFileSync(turbo, ["--version"], { encoding: "utf8" }).trim();
    } catch (e) {
      die(`\`turbo --version\` could not run (${e.code ?? e.message}).`);
    }
    if (!/^\d+\.\d+/.test(v)) {
      die(`\`turbo --version\` produced no output (got ${JSON.stringify(v)}).`);
    }
  }
}

checkNativeBins();
if (nativeOnly) {
  console.log("✓ toolchain: native binaries (turbo/oxlint/oxfmt) are functional");
  process.exit(0);
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
