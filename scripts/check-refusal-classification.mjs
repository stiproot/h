#!/usr/bin/env node
// Local-substrate refusal guard — every refused activity declares WHY it is refused.
//
// The local substrate declines certain activities loudly rather than skipping them, because a
// silently-skipped `register-cron` reports a recurrence that was never armed. That part was always
// right. What was wrong was that the reasons sat in ONE flat list, which conflated two futures:
//
//   pending    — `register-cron` waits on a cron engine this substrate is growing.
//   permanent  — `run-itest` needs an ephemeral k8s namespace and always will.
//
// Written as one list they are indistinguishable, and "1-to-1 parity with the service substrate"
// becomes an open-ended chase with no way to say what is finished. Splitting them is what bounds
// the work; this guard is what stops the split collapsing back the next time someone adds an entry
// in the shape of the ones around it.
//
// Two rules:
//   1. Every REFUSED entry declares `why: "pending" | "permanent"`.
//   2. A `pending` entry's reason NAMES what it is waiting for — an engine, a registry, a bracket.
//      "not supported here" is exactly the non-answer this whole split exists to eliminate.
//
// Wired into `bun run lint`. No skip flag by design.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "packages/js/local-runtime/src/domain/activities.ts";
const path = resolve(root, SOURCE);

if (!existsSync(path)) {
  console.error(`✗ check-refusal-classification: ${SOURCE} not found — it moved or was renamed.`);
  console.error("  Update SOURCE here so the rule keeps applying.\n");
  process.exit(1);
}

const text = readFileSync(path, "utf8");

const start = text.indexOf("const REFUSED");
if (start === -1) {
  console.error(`✗ check-refusal-classification: no REFUSED map in ${SOURCE}.`);
  console.error("  It was renamed; update this guard, or the classification stops being checked.\n");
  process.exit(1);
}
const body = text.slice(start, text.indexOf("\n};", start));

/** Each entry: a quoted activity name, then its object literal up to the next entry. */
const ENTRY = /"([\w-]+)"\s*:\s*\{([\s\S]*?)\}\s*,\n(?=\s*(?:"|\/\/|$))/g;

/** What a `pending` reason must point at: the thing whose arrival lifts the refusal. */
const NAMES_A_BLOCKER = /\b(engine|registry|bracket|store|fabric|adapter)\b/i;

const problems = [];
const seen = [];

for (const match of body.matchAll(ENTRY)) {
  const [, activity, entry] = match;
  seen.push(activity);
  const why = /why:\s*"(pending|permanent)"/.exec(entry)?.[1];
  if (!why) {
    problems.push(
      `'${activity}' does not declare \`why\` — is it waiting on machinery (pending), or does it ` +
        "need a cluster/service this substrate will never have (permanent)?",
    );
    continue;
  }
  if (why !== "pending") continue;
  const reason = /reason:\s*([\s\S]*)/.exec(entry)?.[1] ?? "";
  if (!NAMES_A_BLOCKER.test(reason)) {
    problems.push(
      `'${activity}' is pending but its reason names nothing it is waiting for. Say which engine, ` +
        "registry or bracket lifts it — a pending refusal nobody can act on is a permanent one " +
        "that has not admitted it.",
    );
  }
}

if (seen.length === 0) {
  console.error("✗ check-refusal-classification: parsed the REFUSED map but found no entries.");
  console.error("  The literal's shape changed; fix this guard rather than leaving it vacuous.\n");
  process.exit(1);
}

if (problems.length > 0) {
  console.error("✗ check-refusal-classification: refusals must say WHY.\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(
  `✓ check-refusal-classification: ${seen.length} refusals each declare pending or permanent`,
);
