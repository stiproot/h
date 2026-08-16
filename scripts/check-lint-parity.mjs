#!/usr/bin/env node
// Lint-parity guard — every TypeScript workspace package's `lint` script runs the SAME checks.
//
// The rule exists because the repo had drifted into two halves that were each missing what the
// other had, and neither gap was visible from inside its own half:
//
//   apps/*         tsc --noEmit + oxfmt          → no oxlint at all
//   packages/js/*  oxlint + oxfmt                → no tsc --noEmit
//
// `tsc --noEmit` looks redundant in a package that already runs `tsc -p tsconfig.build.json` in its
// build — but tsconfig.build.json EXCLUDES `src/**/*.test.ts`, and vitest transpiles without
// typechecking. So a package's test files were typechecked by nothing whatsoever. Verified 2026-08-16
// by planting `const x: number = "nope"` in a package test: build passed, lint passed, tests passed.
// The gap had accumulated real errors — incomplete port stubs in agent-server and local-runtime that
// silently satisfied nothing, and a `codexStrategy.extractMetrics(events)` call missing an argument
// the interface has required for as long as it has had two parameters.
//
// This is the same failure mode `check-tsc.mjs` guards from the other direction: a check that runs
// and reports success without checking what you believe it checks. A missing check and a hollow
// check are indistinguishable from the outside — which is why the fix is a guard, not a habit.
//
// depcruise is deliberately NOT required of everyone: it applies to packages that declare hexagonal
// layers or are a shared pure core. `check-hex-lint.mjs` owns that half of the contract; this one
// only insists that whatever depcruise invocation a package already has is preserved.
//
// Wired into `bun run lint`. No skip flag.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The checks every TypeScript package must run, in order, and what each one buys. */
const REQUIRED = [
  ["tsc --noEmit", "typechecks the WHOLE package including tests, which the build excludes"],
  ["oxlint src", "the lint rules; without it a package is only typechecked and formatted"],
  ["oxfmt --check src", "formatting"],
];

const PARENTS = ["apps", "packages/js"];

const problems = [];

for (const parent of PARENTS) {
  const parentPath = join(root, parent);
  if (!existsSync(parentPath)) continue;
  for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(parentPath, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (cause) {
      problems.push(`${parent}/${entry.name}/package.json is unparseable: ${cause.message}`);
      continue;
    }

    // A package with no lint script is either not TypeScript (the Python agents) or not built yet;
    // check-steering and check-hex-lint cover those cases from their own angles.
    const lint = pkg.scripts?.lint;
    if (!lint) continue;

    for (const [check, why] of REQUIRED) {
      if (!lint.includes(check)) {
        problems.push(
          `${parent}/${entry.name} (${pkg.name}) lint is missing \`${check}\` — ${why}.\n` +
            `      current: ${lint}`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error("✗ check-lint-parity: TypeScript packages disagree about what `lint` means.\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\n  Every TS package runs the same three checks (plus depcruise where it applies).\n" +
      "  A package that runs fewer is not 'lighter' — it is unchecked in a way nobody can see\n" +
      "  from its green output.\n",
  );
  process.exit(1);
}

console.log("✓ check-lint-parity: every TypeScript package's lint runs the same checks");
