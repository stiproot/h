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
//
// WIRED INTO the per-package `test` scripts ONLY, deliberately not the root lint/test chains:
// every turbo task already declares `dependsOn: ["^build"]`, so turbo builds before it runs. A
// root-chain copy runs BEFORE turbo gets that chance and reports staleness turbo is about to
// resolve itself — a false failure in the one place the guard is not needed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * Whether turbo would serve `pkg`'s build from cache — i.e. its inputs hash to a build it has
 * already produced. One dry run per call; the answer is memoised across packages because the
 * dry run for one package lists its whole dependency closure.
 */
let turboTasks;
function turboCacheHit(pkg) {
  if (turboTasks === undefined) {
    turboTasks = null;
    const turbo = join(root, "node_modules", ".bin", "turbo");
    if (existsSync(turbo)) {
      try {
        const out = execFileSync(turbo, ["build", "--dry-run=json"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 60_000,
        });
        turboTasks = JSON.parse(out).tasks ?? null;
      } catch {
        turboTasks = null;
      }
    }
  }
  if (!turboTasks) return false;
  const task = turboTasks.find((t) => t.package === pkg && t.task === "build");
  return task?.cache?.status === "HIT";
}

/** Newest mtime under `dir` (recursive), or 0 when it has no files. */
function newestMtime(dir) {
  let newest = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    newest = Math.max(newest, item.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const packagesDir = join(root, "packages", "js");
const unbuilt = [];
const stale = [];
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
  if (!existsSync(entry)) {
    unbuilt.push({ name: manifest.name ?? name, entry });
    continue;
  }
  // STALE is worse than missing: a missing dist fails loudly, but a dist older than its source
  // silently tests the PREVIOUS build — green on code that no longer exists. (Hit live while
  // adding per-agent tool-call tallies: a runner kept reading the old dist and the new tally
  // "did not work".) turbo's `test dependsOn ^build` rebuilds for a ROOT run; a per-package
  // `bun run test` does not, which is the same gap that makes the missing-dist case bite.
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) continue;
  const srcMtime = newestMtime(srcDir);
  const distMtime = statSync(entry).mtimeMs;
  if (srcMtime > distMtime) {
    stale.push({ name: manifest.name ?? name, entry });
  }
}

// mtime is a SIEVE, not a verdict. It lies in one common direction: after a rebase, a branch
// switch or a fresh worktree, every checked-out src file is newer than a dist turbo restored
// from its cache — with the cache tarball's ORIGINAL timestamps — even though the bytes are
// identical and the build is current. (Bit us 2026-09-03: a rebase onto one unrelated commit
// made four packages read STALE straight after a green `bun run build`.) turbo's cache key is a
// content hash, so its dry run is the arbiter: HIT clears the flag, anything else keeps it —
// and if turbo cannot answer (missing, hollow, unparsable) the mtime verdict stands, because a
// guard that fails open on a broken toolchain is the hollow-green check-tsc.mjs exists to catch.
// Consulted only when the sieve caught something, so the common path pays no subprocess.
const confirmedStale = stale.length > 0 ? stale.filter((s) => !turboCacheHit(s.name)) : stale;

if (unbuilt.length > 0 || confirmedStale.length > 0) {
  const kind = unbuilt.length > 0 ? "NOT BUILT" : "STALE";
  console.error(`\ncheck-workspace-built: workspace packages are ${kind}\n`);
  for (const { name, entry } of unbuilt) {
    console.error(`  ${name} — missing ${entry.slice(root.length + 1)}`);
  }
  for (const { name, entry } of confirmedStale) {
    console.error(`  ${name} — ${entry.slice(root.length + 1)} is OLDER than its src/`);
  }
  if (unbuilt.length > 0) {
    console.error(
      "\nConsumers import these through their built entry, so without a build every suite that\n" +
        "imports one fails with a MISLEADING error:\n" +
        '  Error: Failed to resolve entry for package "core". The package may have incorrect\n' +
        "  main/module/exports specified in its package.json\n" +
        "\nThat is not a package.json problem and not an ESM quirk.",
    );
  }
  if (confirmedStale.length > 0) {
    console.error(
      "\nThese built entries are OLDER than their source, so consumers are importing the\n" +
        "PREVIOUS build: tests can pass green against code that no longer exists, and a change\n" +
        "you just made will look like it 'did nothing'. Worse than the missing case, which at\n" +
        "least fails loudly.",
    );
  }
  console.error(
    "\nBuild first:\n" +
      "  bun run build                             # whole workspace\n" +
      "  bunx turbo build --filter=<pkg>...        # just this package's dependency graph\n" +
      "\n(A ROOT `bun run test` builds automatically — turbo's test task dependsOn ^build. Running\n" +
      "a package's tests from inside its own directory bypasses turbo, which is when this bites.)\n",
  );
  process.exit(1);
}
