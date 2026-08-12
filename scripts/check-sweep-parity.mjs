#!/usr/bin/env node
// Worktree-sweep parity guard — fail LOUDLY when either side stops checking itself against the
// shared safety contract.
//
// The rules for what may be deleted from a worktree exist TWICE: in Python (the attended
// `h worktrees` command an operator runs) and in TypeScript (git-core's collector, run unattended
// by the gc-worktrees workflow). Two implementations of one safety policy is the classic drift
// shape, and drift here has a specific bad failure — the unattended collector destroying
// something the attended command refuses to touch.
//
// scripts/fixtures/worktree-classification.json owns the rules instead, and BOTH test suites read
// it and assert their own API agrees. That makes the parity check behavioural rather than
// textual. But a shared fixture only guards anything while both sides still read it: delete one
// consumer's parametrized test and the fixture silently becomes decoration, with every remaining
// test still green. THAT is the hole this guard closes — it asserts the fixture exists, that both
// consumers reference it, and that neither has been reduced to reading it without asserting.
//
// Wired into `bun run lint` (package.json) beside check-runtime-parity.mjs, whose job is the same
// shape one layer up: keep two substrates' shared semantics in one place. No skip flag by design.
// See the *Harden by encoding* principle in ARCHITECTURE.md.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "scripts/fixtures/worktree-classification.json";

// Every implementation of the sweep rules, and the test that holds it to the shared contract.
const CONSUMERS = [
  {
    test: "packages/js/git-core/src/worktree-gc.test.ts",
    implementation: "packages/js/git-core/src/worktree-gc.ts",
    what: "the unattended collector (gc-worktrees workflow)",
  },
  {
    test: "cli/h/tests/test_worktrees.py",
    implementation: "cli/h/src/h_cli/infrastructure/git.py",
    what: "the attended command (`h worktrees`)",
  },
];

const problems = [];

if (!existsSync(resolve(root, FIXTURE))) {
  problems.push(
    `${FIXTURE} is missing — it is the single home of the sweep safety rules. ` +
      `Restore it, or remove this guard along with the second implementation.`,
  );
} else {
  const fixture = JSON.parse(readFileSync(resolve(root, FIXTURE), "utf8"));
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    problems.push(`${FIXTURE} declares no cases — a parity check over nothing passes trivially.`);
  }
  for (const { test, implementation, what } of CONSUMERS) {
    if (!existsSync(resolve(root, implementation))) {
      // The implementation is gone: parity is moot, but say so rather than passing silently.
      problems.push(
        `${implementation} is missing (${what}). If that side was deliberately retired, drop its ` +
          `entry from this guard and its cases' second consumer.`,
      );
      continue;
    }
    if (!existsSync(resolve(root, test))) {
      problems.push(`${test} is missing — nothing holds ${what} to ${FIXTURE}.`);
      continue;
    }
    const source = readFileSync(resolve(root, test), "utf8");
    if (!source.includes("scripts/fixtures/worktree-classification.json")) {
      problems.push(
        `${test} no longer reads ${FIXTURE}, so ${what} is unchecked against the other ` +
          `implementation. Every remaining test in that file still passes — which is exactly why ` +
          `this guard exists.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("check-sweep-parity: FAILED\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(`check-sweep-parity: ok (${CONSUMERS.length} implementations share ${FIXTURE})`);
