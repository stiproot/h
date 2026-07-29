// Unit tests for the workspace-build guard. It only earns its place if it fires on an unbuilt
// package and stays quiet on a built one — a guard that cannot fail is decoration.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "check-workspace-built.mjs");

/** A throwaway workspace: root manifest + one built-entry package, dist optional. */
function makeWorkspace({ built }) {
  const root = mkdtempSync(join(tmpdir(), "h-wsguard-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/js/*"] }),
  );
  const pkg = join(root, "packages", "js", "core");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "core",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    }),
  );
  if (built) {
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
  }
  return root;
}

/** Run the guard in `cwd`; returns {status, stderr}. */
function runGuard(cwd) {
  try {
    execFileSync(process.execPath, [GUARD], { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

test("passes silently when every workspace package is built", () => {
  const root = makeWorkspace({ built: true });
  try {
    const { status, stderr } = runGuard(root);
    assert.equal(status, 0);
    assert.equal(stderr.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails and names the package AND the fix when dist is missing", () => {
  const root = makeWorkspace({ built: false });
  try {
    const { status, stderr } = runGuard(root);
    assert.equal(status, 1);
    assert.match(stderr, /NOT BUILT/);
    assert.match(stderr, /core — missing packages\/js\/core\/dist\/index\.js/);
    // The whole point is redirecting from the misleading symptom to the real cause.
    assert.match(stderr, /Failed to resolve entry for package/);
    assert.match(stderr, /bun run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds the repo root from INSIDE a package dir (the path that bypasses turbo)", () => {
  const root = makeWorkspace({ built: false });
  try {
    const { status, stderr } = runGuard(join(root, "packages", "js", "core"));
    assert.equal(status, 1, "must fire regardless of which directory tests were started from");
    assert.match(stderr, /NOT BUILT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when dist is OLDER than src — the silent-wrong-results case", () => {
  const root = makeWorkspace({ built: true });
  try {
    // Touch a source file so it is newer than the built entry.
    const src = join(root, "packages", "js", "core", "src");
    mkdirSync(src, { recursive: true });
    const future = Date.now() + 10_000;
    writeFileSync(join(src, "index.ts"), "export {};\n");
    utimesSync(join(src, "index.ts"), future / 1000, future / 1000);

    const { status, stderr } = runGuard(root);
    assert.equal(status, 1);
    assert.match(stderr, /STALE/);
    assert.match(stderr, /core — packages\/js\/core\/dist\/index\.js is OLDER than its src\//);
    // The stale symptom differs from the missing one and must be explained as such.
    assert.match(stderr, /PREVIOUS build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores packages whose entry is source, not dist — they cannot be unbuilt", () => {
  const root = makeWorkspace({ built: true });
  try {
    const pkg = join(root, "packages", "js", "srcpkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "srcpkg", exports: { ".": { import: "./src/index.ts" } } }),
    );
    assert.equal(runGuard(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
