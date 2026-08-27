#!/usr/bin/env node
// Local-substrate refusal DRIFT guard — prose that enumerates the refused flags must match the code.
//
// The sibling of check-refusal-classification.mjs. That one guards the SOURCE (every refused
// activity declares pending-vs-permanent, and no refusal outlives its engine). This one guards the
// DOCS, and it exists because the local substrate's refusal set SHRINKS: as the engine host grew,
// `--cron`, `--at`, `--in` and `--watch` each stopped being refused, and `--budget` became
// driver-enforced rather than declined.
//
// Every shrink leaves prose behind, and this drift is uniquely expensive. A doc that OMITS a flag
// is merely incomplete; a doc that says a WORKING capability is "REFUSED BY NAME" actively stops a
// reader using something that would have worked, and reads as maintained while doing it. Three
// live instances had accumulated by 2026-08-27, all invisible to every other guard:
//
//   - cli/README.md's local-substrate footer      (the operator's own command reference)
//   - docs/diagrams/execution-substrates-c4-container.md  (THE diagram answering "what differs?")
//   - docs/diagrams/local-run-sequence.md         (a Note in the sequence itself)
//
// The last two matter for a second reason: hand-authored sequence and C4 diagrams have no drift
// check at all — CLAUDE.md says so plainly ("obligation 2 is yours alone"). This guard does not
// verify a diagram's meaning, which no machine can. It verifies one FACT those diagrams state,
// which is the part that provably rots.
//
// HOW IT WORKS. The canonical set is the dict literal passed to `_refuse_engine_flags(...)` in the
// CLI — the code path that actually refuses. Docs opt IN by bracketing their enumeration with two
// bare tokens (the marker convention vizzle's `gen:` marker and install-steering.sh already use):
//
//     local-refusals:begin  …the enumeration…  local-refusals:end
//
// The tokens are BARE rather than an HTML comment because two of the three docs state the set
// inside a fenced block, where `<!-- … -->` would render literally. Bare tokens drop into whatever
// comment syntax already surrounds them and stay invisible:
//
//     <!-- local-refusals:begin -->   in markdown prose
//     # local-refusals:begin          in a fenced shell block
//     %% local-refusals:begin         in a mermaid fence
//
// Inside a marked block, every `--flag` token must be in the canonical set, and every canonical
// flag must appear. `--fallback-*` stands in for the whole --fallback-agent/-model/-after/-max
// family, because spelling all four in prose helps nobody.
//
// The blind spot is real and deliberate, and it is the same one check-diagrams accepts for a
// manifest-less doc: an UNMARKED doc drifts silently. Marking is cheap, and a guard that tried to
// parse free prose for "is this sentence claiming a refusal?" would produce false positives, which
// is how guards get routed around. So this guard also fails when a doc it KNOWS about loses its
// marker — see REQUIRED below — which is what stops the coverage quietly shrinking to zero.
//
// Wired into `bun run lint`. No skip flag by design.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE = "cli/h/src/h_cli/commands/workflow.py";
const CALL = "_refuse_engine_flags(";

// Docs known to enumerate the set. Losing a marker here is a failure, not a silent opt-out:
// the whole point is that this list only ever grows.
const REQUIRED = [
  "cli/README.md",
  "docs/diagrams/execution-substrates-c4-container.md",
  "docs/diagrams/local-run-sequence.md",
];

const OPEN = "local-refusals:begin";
const CLOSE = "local-refusals:end";

const fail = (...lines) => {
  for (const l of lines) console.error(l);
  process.exit(1);
};

// ---- 1. derive the canonical set from the code that does the refusing ----------------------
const sourcePath = resolve(root, SOURCE);
if (!existsSync(sourcePath)) {
  fail(
    `✗ check-local-refusals: ${SOURCE} not found — it moved or was renamed.`,
    "  Update SOURCE here so the rule keeps applying.\n",
  );
}
const source = readFileSync(sourcePath, "utf8");
const callAt = source.indexOf(CALL);
if (callAt === -1) {
  fail(
    `✗ check-local-refusals: no ${CALL} call in ${SOURCE}.`,
    "  It was renamed or restructured; update this guard, or the docs stop being checked.\n",
  );
}
// The call site is a dict literal: read to its closing brace and take the "--flag" keys.
const literal = source.slice(callAt, source.indexOf("\n            }", callAt));
const canonicalRaw = [...literal.matchAll(/"(--[a-z-]+)":/g)].map((m) => m[1]);
if (canonicalRaw.length === 0) {
  fail(
    `✗ check-local-refusals: found ${CALL} but no "--flag": keys inside it.`,
    "  The call shape changed; update the parse here.\n",
  );
}

// Collapse the --fallback-* family to the token docs actually use.
const canonical = new Set();
for (const flag of canonicalRaw) {
  canonical.add(flag.startsWith("--fallback-") ? "--fallback-*" : flag);
}
const rendered = [...canonical].join(" / ");

// ---- 2. check every doc that enumerates it -------------------------------------------------
const problems = [];

for (const rel of REQUIRED) {
  const path = resolve(root, rel);
  if (!existsSync(path)) {
    problems.push(`${rel}: listed as enumerating the refusal set, but the file does not exist.`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(OPEN, from);
    if (start === -1) break;
    const end = text.indexOf(CLOSE, start);
    if (end === -1) {
      problems.push(`${rel}: an opening ${OPEN} has no closing ${CLOSE}.`);
      break;
    }
    blocks.push(text.slice(start + OPEN.length, end));
    from = end + CLOSE.length;
  }

  if (blocks.length === 0) {
    problems.push(
      `${rel}: no ${OPEN} marker. This doc states the local refusal set, so it must be bracketed —\n` +
        `    put ${OPEN} / ${CLOSE} around it, in whatever comment syntax surrounds it, so it is checked.\n` +
        `    The set is: ${rendered}`,
    );
    continue;
  }

  for (const block of blocks) {
    const named = new Set(
      [...block.matchAll(/--[a-z][a-z-]*\*?/g)].map((m) =>
        m[0].startsWith("--fallback-") ? "--fallback-*" : m[0],
      ),
    );
    const stale = [...named].filter((f) => !canonical.has(f));
    const missing = [...canonical].filter((f) => !named.has(f));
    if (stale.length) {
      problems.push(
        `${rel}: names ${stale.join(", ")} as refused on the local substrate, but ${stale.length > 1 ? "they are" : "it is"} NOT refused.\n` +
          `    A doc that denies a working capability is worse than one that omits it. The set is: ${rendered}`,
      );
    }
    if (missing.length) {
      problems.push(
        `${rel}: omits ${missing.join(", ")} from the refusal set it enumerates.\n` +
          `    The set is: ${rendered}`,
      );
    }
  }
}

if (problems.length) {
  console.error("✗ check-local-refusals: docs disagree with the code that does the refusing\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(`  Canonical set, from ${SOURCE}: ${rendered}`);
  console.error("  (--budget is deliberately NOT refused — the driver enforces it between steps.)\n");
  process.exit(1);
}

console.log(
  `✓ check-local-refusals: ${REQUIRED.length} docs match the canonical refusal set (${rendered})`,
);
