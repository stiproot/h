#!/usr/bin/env node
// Guard the two homes h's skills have to reach. `.h/skills/` is the DISTRIBUTION source — a setup
// step copies it into an agent's own ~/.claude/skills. `.claude/skills/` is what a session
// working ON this repo can load. They are different audiences, but every skill h ships to its
// agents is also a skill the session building h needs, so each one is SYMLINKED (relative, so it
// survives a clone, a worktree and a container) rather than copied: one source of truth, and a
// skill edit is live in both homes at once.
//
// Why this is a guard and not a convention: `skills/ways-of-working` and `skills/delegate-locally`
// existed for ten days reachable by NEITHER this repo's sessions nor the operator's home, because
// the only propagation path was a setup step that `--local` runs deliberately skip. CLAUDE.md said
// "the ways-of-working skill carries the detail" the whole time — a dangling pointer nobody could
// see, since a missing skill is silent: it just never triggers. (Found 2026-08-30.)
//
// A REAL directory in .claude/skills/ is legal and unpoliced — those are repo-only skills (diagrams,
// integrate-agent, observe-h) that agents are not given. Repair with: node scripts/link-skills.mjs
import { readdirSync, readlinkSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, ".h/skills");
const DEST = join(ROOT, ".claude/skills");
const failures = [];

const skillDirs = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);

for (const name of skillDirs(SRC)) {
  const link = join(DEST, name);
  if (!existsSync(link)) {
    failures.push(`.h/skills/${name} has no .claude/skills/${name} link — a session working on h cannot load it`);
    continue;
  }
  if (!lstatSync(link).isSymbolicLink()) {
    failures.push(`.claude/skills/${name} is a COPY of .h/skills/${name} — copies drift; make it a symlink`);
    continue;
  }
  const target = readlinkSync(link);
  if (target !== `../../.h/skills/${name}`) {
    failures.push(`.claude/skills/${name} -> ${target}; expected ../../.h/skills/${name} (relative, so clones/worktrees resolve)`);
  }
}

// A dangling link is worse than a missing one: it looks maintained.
for (const entry of readdirSync(DEST, { withFileTypes: true })) {
  if (!entry.isSymbolicLink()) continue;
  const link = join(DEST, entry.name);
  if (!existsSync(link)) failures.push(`.claude/skills/${entry.name} is a BROKEN symlink -> ${readlinkSync(link)}`);
}

if (failures.length) {
  console.error("check-skills: every skill in skills/ must be symlinked into .claude/skills/\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nRepair: node scripts/link-skills.mjs");
  process.exit(1);
}
console.log("check-skills: ok");
