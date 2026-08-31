#!/usr/bin/env node
// Create the .claude/skills/ -> skills/ symlinks that scripts/check-skills.mjs enforces.
// Idempotent: it repairs a wrong or broken link and leaves real directories (repo-only skills)
// alone. Run after adding a skill to skills/.
import { readdirSync, existsSync, lstatSync, symlinkSync, unlinkSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "skills");
const DEST = join(ROOT, ".claude/skills");

for (const entry of readdirSync(SRC, { withFileTypes: true })) {
  if (!entry.isDirectory() || !existsSync(join(SRC, entry.name, "SKILL.md"))) continue;
  const link = join(DEST, entry.name);
  const want = `../../skills/${entry.name}`;
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
    const isLink = lstatSync(link).isSymbolicLink();
    if (isLink && readlinkSync(link) === want) continue;
    if (!isLink) {
      console.error(`refusing to replace real directory .claude/skills/${entry.name} — move or delete it first`);
      process.exitCode = 1;
      continue;
    }
    unlinkSync(link);
  }
  symlinkSync(want, link);
  console.log(`linked .claude/skills/${entry.name} -> ${want}`);
}
