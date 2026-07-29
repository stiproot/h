#!/usr/bin/env node
// Plan-doc discipline guard — fail LOUDLY when a plan under docs/plans/ drifts from the
// plan-management convention, or when a reference INTO docs/plans/ from anywhere else rots.
//
// Plans are transient by design: they are written, used as a tracking log, then archived to
// docs/plans/impl/ once their durable context is lifted out. Two things break silently as that
// happens, and this guard covers both.
//
//   1. HEADER DRIFT. Before 2026-07-28 the repo carried three status-line formats ("Status:",
//      "**Status:**", and none at all) and nine informal synonyms for four defined states
//      (SHIPPED / DONE / BUILT / IMPLEMENTED / backlog / EXPLORATORY / STUB / …). A reader — human
//      or agent — reconstructing system state from the plan listing could not trust it. So: every
//      plan declares `Status: <Vocabulary> — <one-line>` and `Established: <YYYY-MM-DD>`, and an
//      ARCHIVED plan additionally declares a `Lifted to:` list (the archiving checklist's central
//      gate: if you cannot say where a finding now lives, it is not lifted).
//
//   2. LINK ROT ON ARCHIVE. ~120 references point into docs/plans/ from code comments,
//      ARCHITECTURE.md, CLAUDE.md, README.md, the charts, and the skills. Moving one plan to
//      impl/ breaks every one of them, silently — a code comment citing a design record that no
//      longer resolves is worse than no comment. So every `docs/plans/**.md` path mentioned
//      OUTSIDE docs/plans/ must resolve to a real file.
//
// What this guard deliberately does NOT do: infer that a plan *should* be archived. An earlier
// proposal to fail lint on headline words like DONE|SHIPPED was rejected during the hardening
// audit, and correctly — several plans are deliberately long-lived (workflow-viz is an open-ended
// research log), and archiving is gated on a lift-then-archive judgment no regex can proxy. This
// guard checks that what a plan CLAIMS is well-formed, never what it should claim.
//
// Plan BODIES are exempt from the link check: a plan is a point-in-time record, so a body may
// legitimately cite a doc that has since been retired or a path in another repo. This mirrors the
// same exemption check-vocabulary.mjs makes for docs/plans/.
//
// See .claude/skills/plan-management/SKILL.md (the convention this enforces) and the
// *Harden by encoding* principle in ARCHITECTURE.md. Wired into `bun run lint`. No skip flag.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANS = join(root, "docs/plans");

// The closed status vocabulary. Kept in lockstep with the table in the plan-management skill —
// adding a state means editing both, deliberately.
const STATUSES = ["Planning", "Active", "Blocked", "Deferred", "Complete"];

// A Deferred plan is parked, not abandoned: it must name what would bring it back, so nobody has
// to re-derive the trigger from the body.
const DEFERRED_NEEDS = "Revisit when:";

// Files under docs/plans/ that are not plans and carry no status line.
const NOT_A_PLAN = new Set([".gitkeep"]);

const errors = [];
const fail = (file, msg) => errors.push(`${relative(root, file)}: ${msg}`);

/** Every .md under a directory, recursing (a split plan is a directory of parts). */
function markdownUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (NOT_A_PLAN.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...markdownUnder(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Header discipline
// ---------------------------------------------------------------------------

// docs/plans/domain/ is gitignored and local-only — it has no archive lifecycle and no convention
// to enforce, so skip it entirely rather than nagging about someone's scratch plan.
const planFiles = existsSync(PLANS)
  ? markdownUnder(PLANS).filter((f) => !relative(PLANS, f).startsWith("domain/"))
  : [];

// A split plan is a DIRECTORY (README.md index + numbered parts) and archives as a unit, gated on
// every part being Complete. So a part may sit at Complete while its index is still Active — that
// is the convention working, not drift. Only the index carries the plan-level status.
const isSplitPart = (file) => {
  const parent = dirname(file);
  return parent !== PLANS && parent !== join(PLANS, "impl") && existsSync(join(parent, "README.md"))
    && file !== join(parent, "README.md");
};

for (const file of planFiles) {
  const text = readFileSync(file, "utf8");
  const archived = relative(PLANS, file).startsWith("impl/");
  const part = isSplitPart(file);

  // The status line must be a bare `Status:` at the start of a line — not `**Status:**`, which is
  // the pre-convention spelling and the reason a machine could not read these at all.
  const statusLine = text.match(/^Status:[^\n]*/m);
  if (!statusLine) {
    const legacy = /^\*\*Status:?\*\*/m.test(text);
    fail(
      file,
      legacy
        ? "status line uses the retired `**Status:**` spelling — use a bare `Status: <Vocabulary> — <summary>` so it is machine-readable"
        : "missing a `Status:` line (expected `Status: <Vocabulary> — <summary>` near the top)",
    );
  } else {
    const declared = statusLine[0].slice("Status:".length).trim().split(/[\s—-]/)[0];
    if (!STATUSES.includes(declared)) {
      fail(
        file,
        `status "${declared}" is not in the vocabulary — use one of ${STATUSES.join(" | ")} ` +
          `(see .claude/skills/plan-management/SKILL.md)`,
      );
    }
    if (declared === "Deferred" && !text.includes(DEFERRED_NEEDS)) {
      fail(file, `is Deferred but names no "${DEFERRED_NEEDS}" trigger — a parked plan must say what brings it back`);
    }
    if (archived && declared !== "Complete") {
      fail(file, `lives in impl/ but is "${declared}" — an archived plan is Complete, or it does not belong in impl/`);
    }
    if (!archived && declared === "Complete" && !part) {
      fail(file, `is Complete but still sits in docs/plans/ — lift its durable context, then move it to docs/plans/impl/`);
    }
  }

  if (!/^Established: \d{4}-\d{2}-\d{2}/m.test(text)) {
    fail(file, "missing `Established: YYYY-MM-DD`");
  }

  // The archiving checklist's central gate. A plan that cannot point at where its findings now
  // live has not finished step 4, whatever its status says. A split plan declares it once, on the
  // index — its parts link back rather than restating (the rule-of-one-home).
  if (archived && !part && !/^Lifted to:/m.test(text)) {
    fail(
      file,
      "archived without a `Lifted to:` list — name where each piece of lasting context now lives (ARCHITECTURE.md, a skill, a lint rule, a CLAUDE.md gotcha, a code comment)",
    );
  }
}

// ---------------------------------------------------------------------------
// 2. References into docs/plans/ must resolve
// ---------------------------------------------------------------------------

// Tracked files only, and never a plan itself (bodies are point-in-time records — see the header
// comment). Binary/lockfile extensions are skipped: they cannot carry a meaningful citation.
const SKIP_EXT = /\.(png|jpe?g|gif|svg|ico|lock|ambr|woff2?|ttf)$/;
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("docs/plans/") && !SKIP_EXT.test(f));

// Two citation shapes, both of which broke when plans were archived:
//   - a repo-root-style path in prose or a code comment: docs/plans/<name>.md
//   - a RELATIVE markdown link, which never contains the literal "docs/plans/":
//     docs/h-builds-h-runbook.md cited ](./plans/<name>.md) and rotted invisibly.
// (Both spellings above use the <name> placeholder deliberately — a literal example path
// here would be a citation this very guard then demands resolve. It caught exactly that.)
// So resolve markdown links too, and check any whose resolved target lands under docs/plans/.
const PLAN_PATH = /docs\/plans\/[A-Za-z0-9._/-]*\.md/g;
const MD_LINK = /\]\((\.{0,2}\/?[A-Za-z0-9._/-]*\.md)(?:#[^)]*)?\)/g;

for (const rel of tracked) {
  const abs = join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue; // unreadable / vanished between ls-files and now
  }

  const seen = new Set();
  const check = (display, absTarget) => {
    if (display.includes("<") || seen.has(display)) return; // `docs/plans/<name>.md` documents the convention
    seen.add(display);
    if (!existsSync(absTarget)) {
      fail(
        abs,
        `references "${display}", which does not exist — a plan that moved to docs/plans/impl/ takes its citations with it`,
      );
    }
  };

  if (text.includes("docs/plans/")) {
    for (const m of text.matchAll(PLAN_PATH)) check(m[0], join(root, m[0]));
  }
  if (rel.endsWith(".md")) {
    for (const m of text.matchAll(MD_LINK)) {
      const target = resolve(dirname(abs), m[1]);
      // Only plan citations are in scope; other doc links are not this guard's business.
      if (target.startsWith(PLANS + "/")) check(m[1], target);
    }
  }
}

// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error("check-plans: plan-doc discipline violations\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    `\n${errors.length} problem(s). The convention lives in .claude/skills/plan-management/SKILL.md.`,
  );
  process.exit(1);
}

console.log(`check-plans: ok (${planFiles.length} plans, ${tracked.length} files scanned for references)`);
