#!/usr/bin/env node
// Guard the repository's canonical, long-lived prose against retired vocabulary.
// Historical records under docs/plans are deliberately excluded.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const glossary = "ARCHITECTURE.md#glossary";
const exactFiles = [
  "CLAUDE.md",
  "README.md",
  "ARCHITECTURE.md",
  "cli/README.md",
  "docs/cookbook.md",
  "apps/claude-agent/steering/h-runtime.md",
];
const proseDirs = ["skills", ".claude/skills/observe-h"];
const proseExtensions = new Set([".md", ".txt", ".yaml", ".yml"]);
const rules = [
  { pattern: /\bhop\b/gi, replacement: "path or step" },
  { pattern: /\bfamily\b/gi, replacement: "cron siblings or a precise grouping" },
  { pattern: /\bblackboard\b/gi, replacement: "chain data" },
  { pattern: /\bchain workflow\b/gi, replacement: "chain member" },
];

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else if (proseExtensions.has(extname(entry.name))) files.push(child);
  }
  return files;
}

const files = [
  ...exactFiles.map((path) => resolve(root, path)).filter(existsSync),
  ...proseDirs.flatMap((path) => filesUnder(resolve(root, path))),
];
const violations = [];

for (const path of files) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(lines[index])) {
        violations.push(
          `${relative(root, path)}:${index + 1}: replace with “${rule.replacement}”; ` +
            `see ${glossary}`,
        );
      }
    }
  }
}

if (violations.length) {
  console.error("Vocabulary guard failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Vocabulary guard passed (${files.length} long-lived prose files checked).`);
}
