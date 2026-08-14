#!/usr/bin/env node
// Steering-surface drift guard — fail LOUDLY when on-disk components are not documented in the
// steering sources agents plan from.
//
// Two checks:
//
// 1. DIRECTORY CHECK — every directory under apps/, packages/js/, packages/py/ must appear by
//    name in CLAUDE.md and README.md. These steering files are the per-component index every
//    agent session is oriented by; an undocumented component is invisible to agents and causes
//    the kind of drift the hardening-audit found live (apps/codex-agent and packages/js/telemetry
//    absent despite being real, in-use components).
//
// 2. ACTIVITY CHECK — every `case "run-*":` activity name in workflow-svc's activity-registry.ts
//    must appear in CLAUDE.md (brace-expansion-aware: `run-{a,b,c}` counts as listing all three)
//    and in skills/workflow-orchestrator/SKILL.md (literal substring). Missing activities make the
//    SKILL.md guidance incorrect, steering agents toward an incomplete activity set.
//
// 3. CLI COMMAND CHECK — every module under cli/h/src/h_cli/commands/ must be named in CLAUDE.md
//    (its layout line or its prose — the bar is "an agent reading CLAUDE.md learns this command
//    exists", not a specific location) AND invoked as `h <name>` in cli/README.md's command list.
//    An undocumented command is invisible:
//    CLAUDE.md is loaded into every agent session, so a command missing from it may as well not
//    exist. This check exists because the omission happened TWICE in one session and neither the
//    directory nor the activity check could see it — `h worktrees` shipped absent from CLAUDE.md
//    (caught only by a human code review) and `h delegate` shipped absent from both lists
//    (caught only when someone thought to ask whether the docs were current).
//
// Wired into `bun run lint` (package.json) beside check-templates.mjs. No skip flag by design.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

function subdirs(rel) {
  const abs = resolve(root, rel);
  return readdirSync(abs).filter((name) => statSync(join(abs, name)).isDirectory());
}

// Expand `run-{a,b,c}` brace groups in text into individual `run-X` names, then also
// collect all bare `run-<word>` occurrences. Used to check CLAUDE.md, which uses brace-
// expansion shorthand for the activity list.
function expandRunNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/\brun-\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      names.add("run-" + part.trim());
    }
  }
  for (const m of text.matchAll(/\brun-([\w][\w-]*)/g)) {
    names.add("run-" + m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Load steering files
// ---------------------------------------------------------------------------

const claudeMd = readText("CLAUDE.md");
const readmeMd = readText("README.md");
const skillMd = readText("skills/workflow-orchestrator/SKILL.md");
const activityRegistry = readText(
  "apps/workflow-svc/src/infrastructure/activity-registry.ts",
);
const cliReadmeMd = readText("cli/README.md");

// ---------------------------------------------------------------------------
// 1. Directory check
// ---------------------------------------------------------------------------

// Deliberately empty: web/ is not under apps/ or packages/ so it needs no entry.
// Add a name here only for a directory that genuinely should not appear in steering docs
// (e.g. a scaffolding directory that is not a real component).
const OMIT_FROM_CHECK = new Set([]);

const dirViolations = [];

const groups = [
  { prefix: "apps/", dirs: subdirs("apps") },
  { prefix: "packages/js/", dirs: subdirs("packages/js") },
  { prefix: "packages/py/", dirs: subdirs("packages/py") },
];

for (const { prefix, dirs } of groups) {
  for (const name of dirs) {
    if (OMIT_FROM_CHECK.has(name)) continue;
    const missingFrom = [];
    if (!claudeMd.includes(name)) missingFrom.push("CLAUDE.md");
    if (!readmeMd.includes(name)) missingFrom.push("README.md");
    if (missingFrom.length > 0) {
      dirViolations.push({ path: prefix + name, missingFrom });
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Activity check
// ---------------------------------------------------------------------------

const runActivities = [];
for (const m of activityRegistry.matchAll(/case\s+"(run-[^"]+)"/g)) {
  runActivities.push(m[1]);
}

const claudeRunNames = expandRunNames(claudeMd);
const activityViolations = [];

for (const activity of runActivities) {
  const missingFrom = [];
  if (!claudeRunNames.has(activity)) missingFrom.push("CLAUDE.md");
  if (!skillMd.includes(activity)) missingFrom.push("skills/workflow-orchestrator/SKILL.md");
  if (missingFrom.length > 0) {
    activityViolations.push({ activity, missingFrom });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. SKILL SCRIPT CHECK — a skill that tells an agent to run a script must name a path that
//    actually exists.
//
//    Skills are copied wholesale into an agent's `~/.claude/skills/`, so a SKILL.md instructs
//    with an installed path (`~/.claude/skills/<skill>/<rest>`) that maps 1:1 onto this repo's
//    `skills/<skill>/<rest>`. Nothing checked that mapping, and it had rotted: the `linear`
//    skill — the ONLY way h reads/writes Linear, since the hosted MCP cannot authenticate
//    unattended — pointed every one of its invocations at
//    `~/.claude/skills/linear/cli/scripts/…`, an extra `cli/` segment. The scripts live at
//    `skills/linear/scripts/`. Any agent following that skill ran a nonexistent file.
//
//    This is the worst class of steering drift: it fails at the agent, mid-task, as a
//    "no such file" the agent then has to work around or silently skip.
// ---------------------------------------------------------------------------

const SKILL_PATH_RE = /~\/\.claude\/skills\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._/-]+)/g;
const skillViolations = [];

function skillMarkdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry}`;
    let st;
    try {
      st = statSync(join(root, rel));
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...skillMarkdownFiles(rel));
    else if (entry.endsWith(".md")) out.push(rel);
  }
  return out;
}

for (const file of skillMarkdownFiles("skills")) {
  const text = readText(file) ?? "";
  const seen = new Set();
  for (const m of text.matchAll(SKILL_PATH_RE)) {
    const [, skill, rest] = m;
    // Skip placeholders — a doc may illustrate with <ISSUE_ID>-style tokens.
    if (rest.includes("<") || rest.includes("*")) continue;
    // Only check things that look like an invocable file, not a directory reference.
    if (!/\.[a-z0-9]+$/i.test(rest)) continue;
    const key = `${skill}/${rest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      statSync(join(root, "skills", skill, rest));
    } catch {
      skillViolations.push({ file, ref: `~/.claude/skills/${key}`, expected: `skills/${key}` });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. HOLLOW-GREEN TEST COMMAND CHECK — a steering doc must never cite the CLI test suite
//    without its path scope.
//
//    The root pyproject sets `testpaths = ["packages/py"]` and deliberately EXCLUDES cli/h (its
//    `--disable-socket` fail-closed guard does not compose into one root config). So a bare
//    `uv run --package h-cli pytest` from the root runs packages/py's ~52 tests, NOT the CLI's
//    ~390 — and reports a green indistinguishable from a real one. Same hollow-green class as the
//    tsc no-op guard. Found 2026-08-06 (nats work) and recorded only in that plan; the steering
//    docs kept the broken form and it bit a local-substrate run on 2026-08-10. This check is the
//    lift: the knowledge now lives where a machine enforces it.
//
//    Plan docs under docs/plans/ are EXCLUDED — they are historical logs, and rewriting what a
//    past run actually typed would falsify the record.
// ---------------------------------------------------------------------------

const CLI_PYTEST_RE = /uv run --package h-cli pytest(?<rest>[^\n`]*)/g;
const testCmdViolations = [];

const steeringDocs = [
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "cli/README.md",
  "docs/DRIVER.md",
  "docs/cookbook.md",
  "docs/h-builds-h-runbook.md",
  ...skillMarkdownFiles("skills"),
];

for (const file of steeringDocs) {
  const text = readText(file);
  if (text === null) continue;
  for (const m of text.matchAll(CLI_PYTEST_RE)) {
    // The guard's own explanatory prose necessarily quotes the bad form; a line that also names
    // the correct path-scoped form is documentation ABOUT the trap, not an instruction to run it.
    const line = text.slice(0, m.index).split("\n").length;
    const lineText = text.split("\n")[line - 1] ?? "";
    if (/cli\/h(\/tests)?\b/.test(m.groups.rest) || /cli\/h(\/tests)?\b/.test(lineText)) continue;
    testCmdViolations.push({ file, line, snippet: `uv run --package h-cli pytest${m.groups.rest}` });
  }
}

let failed = false;

if (testCmdViolations.length > 0) {
  failed = true;
  console.error("✗ check-steering: CLI test command cited without its path scope.\n");
  console.error(
    "  `uv run --package h-cli pytest` WITHOUT `cli/h/tests` is a HOLLOW GREEN: the root",
  );
  console.error(
    "  pyproject's testpaths excludes cli/h, so it runs packages/py's ~52 tests instead of the",
  );
  console.error("  CLI's ~390 and reports a pass that checked the wrong suite.\n");
  for (const v of testCmdViolations) {
    console.error(`  ${v.file}:${v.line}  →  ${v.snippet.trim()}`);
  }
  console.error("\n  Fix: cite `uv run --package h-cli pytest cli/h/tests` (what make test-py runs).\n");
}

if (skillViolations.length > 0) {
  failed = true;
  console.error("✗ check-steering: skill scripts referenced at paths that do not exist.\n");
  console.error(
    "  A `~/.claude/skills/<skill>/<rest>` reference in a SKILL.md maps 1:1 onto this repo's",
  );
  console.error(
    "  `skills/<skill>/<rest>` — skills are copied wholesale into the agent's home. A wrong",
  );
  console.error("  path fails at the AGENT, mid-task, as a 'no such file'.\n");
  for (const v of skillViolations) {
    console.error(`  ${v.file}  →  ${v.ref}  (expected on disk at ${v.expected})`);
  }
  console.error("");
}

if (dirViolations.length > 0) {
  failed = true;
  console.error("✗ check-steering: undocumented component directories found.\n");
  console.error(
    "  Every directory under apps/, packages/js/, packages/py/ must appear by name in",
  );
  console.error("  CLAUDE.md and README.md so agents can orient themselves.\n");
  for (const v of dirViolations) {
    console.error(`  ${v.path}  →  missing from: ${v.missingFrom.join(", ")}`);
  }
  console.error("");
}

if (activityViolations.length > 0) {
  failed = true;
  console.error("✗ check-steering: undocumented run-* activities found.\n");
  console.error(
    "  Every case \"run-*\" in activity-registry.ts must appear in CLAUDE.md (brace-expansion",
  );
  console.error(
    "  syntax counts: run-{a,b} covers both) and skills/workflow-orchestrator/SKILL.md.\n",
  );
  for (const v of activityViolations) {
    console.error(`  ${v.activity}  →  missing from: ${v.missingFrom.join(", ")}`);
  }
  console.error("");
}

if (failed) {
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. CLI command check
// ---------------------------------------------------------------------------

// Command modules that are not a user-facing `h <name>` surface belong here, with a reason.
// _local_journal: the journal preflight shared by `h chain run --local` and `h workflow run
// --local` — a helper both commands import, never an `h _local_journal` surface of its own.
const OMIT_COMMANDS = new Set(["__init__", "_local_journal"]);

const commandViolations = [];
for (const file of readdirSync(resolve(root, "cli/h/src/h_cli/commands"))) {
  if (!file.endsWith(".py")) continue;
  const name = file.slice(0, -3);
  if (OMIT_COMMANDS.has(name)) continue;
  // CLAUDE.md lists the modules brace-expanded (`commands/{a,b,c}.py`); cli/README.md lists the
  // user-facing invocation. Require BOTH, since they serve different readers.
  const inClaude = claudeMd.includes(`${name},`) || claudeMd.includes(`${name}}`) ||
    claudeMd.includes(`h ${name}`);
  const inCliReadme = cliReadmeMd.includes(`h ${name}`);
  const missing = [!inClaude && "CLAUDE.md", !inCliReadme && "cli/README.md"].filter(Boolean);
  if (missing.length > 0) {
    commandViolations.push(
      `  cli/h/src/h_cli/commands/${file}  ->  missing from: ${missing.join(", ")}`,
    );
  }
}

if (commandViolations.length > 0) {
  console.error("✗ check-steering: undocumented h CLI commands.\n");
  console.error("  Every command module must appear in CLAUDE.md's layout and cli/README.md's");
  console.error("  command list — CLAUDE.md is loaded into every agent session, so a command");
  console.error("  missing from it is invisible to the agents working in this repo.\n");
  for (const violation of commandViolations) console.error(violation);
  process.exit(1);
}

console.log("✓ check-steering: all components, activities and CLI commands documented in steering sources");
