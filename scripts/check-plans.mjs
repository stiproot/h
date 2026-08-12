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
//   2. PLAN REFERENCES FROM OUTSIDE. Nothing outside docs/plans/ may reference a plan — not
//      source, not steering docs, not runbooks, not READMEs, not skills. A citation is a
//      DEPENDENCY, and a plan is by design written, used, archived and forgotten, so pointing
//      contextual documentation at one guarantees it rots. State the fact where you are, or cite
//      the durable home (ARCHITECTURE.md, CLAUDE.md, a skill, the cookbook, a lint rule). This is
//      the lift-on-archive discipline applied at WRITE time, and it is what makes archiving a
//      plan a change confined to docs/plans/.
//
//      History: 2026-07-30 a sweep removed ~160 such citations from SOURCE and the rule was
//      source-only, with documentation merely required to RESOLVE. That weaker half coupled every
//      archive move to a doc sweep and was tightened to a ban on 2026-08-11 (39 citations removed).
//
//   3. INTRA-PLAN LINK ROT. Plans may cite each other — they are transient together — but an
//      archive move gains a directory level and silently mis-levels every relative link in the
//      moved file (../FOO.md must become ../../FOO.md). That is ROT, distinct from the legitimate
//      staleness a point-in-time record is allowed. The two are told apart by whether the target
//      still EXISTS somewhere in the repo: still there ⇒ wrong path, fail with the correction;
//      gone ⇒ genuinely retired, exempt. Six such links had accumulated undetected.
//
// What this guard deliberately does NOT do: infer that a plan *should* be archived. An earlier
// proposal to fail lint on headline words like DONE|SHIPPED was rejected during the hardening
// audit, and correctly — several plans are deliberately long-lived (workflow-viz is an open-ended
// research log), and archiving is gated on a lift-then-archive judgment no regex can proxy. This
// guard checks that what a plan CLAIMS is well-formed, never what it should claim.
//
// Plan BODIES stay exempt from strict link resolution — a plan is a point-in-time record, so a
// body may legitimately cite a doc since retired or a path in another repo. Check 3 narrows that
// exemption to exactly the case it was written for, without letting move-rot hide behind it. This
// mirrors the same exemption check-vocabulary.mjs makes for docs/plans/.
//
// See the plan-management plugin skill (v0.1.0) + the CLAUDE.md Plans section (the convention
// this enforces) and the *Harden by encoding* principle in ARCHITECTURE.md. Wired into
// `bun run lint`. No skip flag.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANS = join(root, "docs/plans");

// The closed status vocabulary. Kept in lockstep with the status table in the plan-management
// PLUGIN skill — this mirrors plugin version 0.1.0 (+ the CLAUDE.md Plans section, h's concrete
// policy). Adding a state means editing both, deliberately; a plugin bump that changes the
// table must update this list AND the version named here.
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
          `(see the plan-management plugin skill v0.1.0 + the CLAUDE.md Plans section)`,
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
// 1b. Every OPEN carried follow-up names what brings it back
// ---------------------------------------------------------------------------
//
// The carried-followups doc holds parked ideas that get read months after they were written, so
// the standing rule (CLAUDE.md, Plans) is to interrogate one before building it: has its trigger
// actually fired, what real usage exists, what changed? That check needs something to check
// AGAINST. An item with no stated trigger cannot be interrogated at all — it can only be
// rediscovered and rebuilt on faith, which is how §2 nearly got built for a benefit this repo
// does not want.
//
// So: an `### N. Title` section is either RESOLVED/DROPPED (its outcome recorded, nothing owed)
// or it names a trigger. Deliberately scoped to this one doc — it is the only place where parked
// items accumulate across plans; a plan's own body is a point-in-time record.

const CARRIED = join(PLANS, "carried-followups.md");
// The three spellings in use. `Revisit as part of` defers to another plan that owns the story;
// `Not revisited unless` parks something behind evidence that does not exist yet.
const TRIGGERS = ["*Revisit when:*", "*Revisit as part of*", "*Not revisited unless*"];
const CLOSED = /\b(RESOLVED|DROPPED|refuted)\b/;

if (existsSync(CARRIED)) {
  const sections = readFileSync(CARRIED, "utf8").split(/\n### /).slice(1);
  for (const section of sections) {
    const heading = section.split("\n")[0].trim();
    // Only numbered items are follow-ups; "Resolved since the list was written" is a ledger.
    if (!/^\d+[a-z]?\./.test(heading)) continue;
    if (CLOSED.test(heading)) continue;
    if (TRIGGERS.some((trigger) => section.includes(trigger))) continue;
    fail(
      CARRIED,
      `open item "${heading}" names no trigger — add a "${TRIGGERS[0]}" line saying what brings ` +
        `it back, or mark it RESOLVED/DROPPED with the reasoning. An item nobody can interrogate ` +
        `gets rebuilt on faith (CLAUDE.md, Plans).`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Plan references: prohibited in source, must resolve elsewhere
// ---------------------------------------------------------------------------

// Tracked files only, and never a plan itself (bodies are point-in-time records — see the header
// comment). Binary/lockfile extensions are skipped: they cannot carry a meaningful citation.
const SKIP_EXT = /\.(png|jpe?g|gif|svg|ico|lock|ambr|woff2?|ttf)$/;
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("docs/plans/") && !SKIP_EXT.test(f));

// This guard's own comments must name the path shapes it enforces, so it cannot obey its own rule.
const isSelf = (f) => f === "scripts/check-plans.mjs";

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
  if (isSelf(rel)) continue;
  const abs = join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue; // unreadable / vanished between ls-files and now
  }

  const seen = new Set();
  const banned = (display) => {
    // `docs/plans/<name>.md` is the convention being DESCRIBED, not a citation.
    if (display.includes("<") || seen.has(display)) return;
    seen.add(display);
    fail(
      abs,
      `references the plan "${display}" — plans are TRANSIENT, so nothing outside docs/plans/ ` +
        `may point at one. State the fact itself here, or cite its durable home ` +
        `(ARCHITECTURE.md, CLAUDE.md, a skill, the cookbook, a lint rule)`,
    );
  };

  if (text.includes("docs/plans/")) {
    for (const m of text.matchAll(PLAN_PATH)) banned(m[0]);
  }
  if (rel.endsWith(".md")) {
    for (const m of text.matchAll(MD_LINK)) {
      // A relative link never contains the literal "docs/plans/" — docs/h-builds-h-runbook.md
      // cited ](./plans/<name>.md) and rotted invisibly — so resolve and check where it LANDS.
      if (resolve(dirname(abs), m[1]).startsWith(PLANS + "/")) banned(m[1]);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Intra-plan link rot — plans may cite each other, but the links must survive archiving
// ---------------------------------------------------------------------------
//
// Plan bodies stay exempt from rule 2 (they are transient together, so a plan citing a plan is
// fine) and from strict link resolution (a point-in-time record may cite something since
// RETIRED). But an archive move silently mis-levels every relative link in the moved file — a
// plan gains a directory level, so ../FOO.md becomes ../../FOO.md — and that is rot, not
// staleness.
//
// The two are told apart by whether the target still EXISTS somewhere: a basename that is still
// in the repo means the link points at a live document by the wrong path (fix it, and the
// suggestion below says where); a basename that is gone means the document was genuinely retired
// (exempt, as before). Six such links had accumulated undetected when this check was added.

const basenameIndex = new Map();
for (const f of execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".md"))) {
  const base = f.slice(f.lastIndexOf("/") + 1);
  if (!basenameIndex.has(base)) basenameIndex.set(base, []);
  basenameIndex.get(base).push(f);
}

for (const file of planFiles) {
  const text = readFileSync(file, "utf8");
  const seen = new Set();
  for (const m of text.matchAll(MD_LINK)) {
    const link = m[1];
    if (link.includes("<") || seen.has(link)) continue;
    seen.add(link);
    const target = resolve(dirname(file), link);
    if (existsSync(target)) continue;
    const elsewhere = basenameIndex.get(link.slice(link.lastIndexOf("/") + 1)) ?? [];
    if (elsewhere.length === 0) continue; // genuinely retired — a point-in-time record may say so
    const suggestion = relative(dirname(file), join(root, elsewhere[0])) || elsewhere[0];
    fail(
      file,
      `link "${link}" does not resolve, but that file still exists at ${elsewhere[0]} — an ` +
        `archive move mis-levels relative links (a plan gains a directory). Use "${suggestion}"`,
    );
  }
}

// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error("check-plans: plan-doc discipline violations\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    `\n${errors.length} problem(s). The convention lives in the plan-management plugin skill (v0.1.0) + the CLAUDE.md Plans section.`,
  );
  process.exit(1);
}

console.log(`check-plans: ok (${planFiles.length} plans, ${tracked.length} files scanned for references)`);
