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
export const rules = [
  { pattern: /\bhops?\b/gi, replacement: "path or step" },
  // Retired 2026-08-06: "local mode" split into HOST mode (the fleet's services as host
  // processes) and the LOCAL substrate (in-process execution, formerly "direct").
  {
    pattern: /\blocal[- ]mode\b/gi,
    replacement: "host mode (the fleet on the host) or the local substrate (in-process execution)",
  },
  { pattern: /\bdirect[- ](?:mode|substrate|runtime|execution)\b/gi, replacement: "the local substrate" },
  { pattern: /\b(?:family|families)\b/gi, replacement: "cron siblings or a precise grouping" },
  { pattern: /\bblackboards?\b/gi, replacement: "chain data" },
  { pattern: /\bchain workflows?\b/gi, replacement: "chain member" },
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

export function findViolations(path, contents, repositoryRoot = root) {
  const violations = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of lines[index].matchAll(rule.pattern)) {
        violations.push(
          `${relative(repositoryRoot, path)}:${index + 1}:${match.index + 1}: ` +
            `replace “${match[0]}” with “${rule.replacement}”; ` +
            `see ${glossary}`,
        );
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = [
    ...exactFiles.map((path) => resolve(root, path)).filter(existsSync),
    ...proseDirs.flatMap((path) => filesUnder(resolve(root, path))),
  ];
  const violations = files.flatMap((path) =>
    findViolations(path, readFileSync(path, "utf8")),
  );

  if (violations.length) {
    console.error("Vocabulary guard failed:");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Vocabulary guard passed (${files.length} long-lived prose files checked).`);
  }
}
