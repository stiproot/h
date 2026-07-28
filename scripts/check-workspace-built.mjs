#!/usr/bin/env node
// Workspace-build guard — fail with an UNMISTAKABLE message when a workspace package's `dist/`
// is missing, instead of letting the confusing downstream error stand.
//
// Every JS workspace package is consumed through its BUILT entry (`exports["."].import` →
// `./dist/index.js`), so an unbuilt workspace makes any consumer's test run explode with
//
//     Error: Failed to resolve entry for package "core".
//     The package may have incorrect main/module/exports specified in its package.json.
//
// scattered across every suite that transitively imports it. That message points at the wrong
// thing — it reads as a broken package.json or an ESM/import quirk, not "you forgot to build".
//
// It is easy to hit: `turbo.json` gives the `test` task `dependsOn: ["^build"]`, so a ROOT
// `bun run test` builds deps first and is always fine. But running a package's tests directly —
// `cd apps/workflow-svc && bun run test`, the normal thing to do in a fresh worktree — invokes
// vitest with no turbo in the loop, so nothing builds. That is exactly how PR #97 came to report
// "all 190 tests pass (the 8 failed suites are pre-existing @dapr/dapr ESM import failures)"
// when the real numbers were 333 tests across 22 suites, and the 10 failing suites included the
// very file carrying that PR's new tests. The run failed loudly; its CAUSE was misread.
//
// This guard is the check-tsc.mjs of the test path: it names the real cause and the exact fix.
// Deliberately no skip flag — a misdiagnosed red wastes more time than a fast red.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Walk up from `start` to the repo root (the package.json that declares `workspaces`). */
function findRepoRoot(start) {
  let dir = resolve(start);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).workspaces) return dir;
      } catch {
        // An unreadable manifest on the way up is not the root; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The file a consumer actually resolves when importing this package, or null when it has none. */
function entryFile(pkgDir, manifest) {
  const fromExports = manifest.exports?.["."];
  const entry =
    (typeof fromExports === "string" ? fromExports : fromExports?.import) ??
    manifest.module ??
    manifest.main;
  return entry ? join(pkgDir, entry) : null;
}

const root = findRepoRoot(process.cwd());
if (!root) {
  console.error("check-workspace-built: no workspace root found above " + process.cwd());
  process.exit(1);
}

const packagesDir = join(root, "packages", "js");
const unbuilt = [];
for (const name of existsSync(packagesDir) ? readdirSync(packagesDir) : []) {
  const pkgDir = join(packagesDir, name);
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  // Only packages that are BUILT (entry under dist/) can be unbuilt; source-entry ones cannot.
  const entry = entryFile(pkgDir, manifest);
  if (!entry || !entry.includes("dist")) continue;
  if (!existsSync(entry)) unbuilt.push({ name: manifest.name ?? name, entry });
}

if (unbuilt.length > 0) {
  console.error("\ncheck-workspace-built: workspace packages are NOT BUILT\n");
  for (const { name, entry } of unbuilt) {
    console.error(`  ${name} — missing ${entry.slice(root.length + 1)}`);
  }
  console.error(
    "\nConsumers import these through their built entry, so without a build every suite that\n" +
      "imports one fails with a MISLEADING error:\n" +
      '  Error: Failed to resolve entry for package "core". The package may have incorrect\n' +
      "  main/module/exports specified in its package.json\n" +
      "\nThat is not a package.json problem and not an ESM quirk. Build first:\n" +
      "  bun run build                             # whole workspace\n" +
      "  bunx turbo build --filter=<pkg>...        # just this package's dependency graph\n" +
      "\n(A ROOT `bun run test` builds automatically — turbo's test task dependsOn ^build. Running\n" +
      "a package's tests from inside its own directory bypasses turbo, which is when this bites.)\n",
  );
  process.exit(1);
}
