#!/usr/bin/env node
// Chart-template content guard — fail LOUDLY when a workflow template's agent prose tells an
// agent to force-push UNSAFELY.
//
// The `revise` workflow rebases a stale PR branch onto main and force-pushes (docs/plans/impl/
// revise-rebase-stale.md — the first force-push in the codebase). The sanctioned convention is
// ALWAYS `git push --force-with-lease`, NEVER a bare `git push --force` / `git push -f`: the lease
// protects commits pushed since the last fetch from being clobbered. This guard scans every chart
// template for a bare force-push in a `git push` command and fails the lint if it finds one, so the
// convention can't silently drift as new templates add push prose. See the `force-with-lease`
// memory + the *Harden by encoding* principle in ARCHITECTURE.md.
//
// Wired into `bun run lint` (package.json) beside check-tsc.mjs. No skip flag by design.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = resolve(root, "cli/charts/workflows/templates");

// A line is a violation when it drives a `git push` AND carries a force flag that is not
// `--force-with-lease`: a bare `--force` (not followed by `-with-lease`) or the short `-f` flag.
const bareForce = /--force(?!-with-lease)/;
const shortForce = /(?:^|\s)-f(?:\s|$)/;

const violations = [];
const gateViolations = [];
for (const file of readdirSync(templatesDir).filter((f) => f.endsWith(".yaml"))) {
  const path = join(templatesDir, file);
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (!/git\s+push/.test(line)) return;
    if (bareForce.test(line) || shortForce.test(line)) {
      violations.push({ file: relative(root, path), line: i + 1, text: line.trim() });
    }
  });

  const templateName = basename(file, ".yaml");
  const escapedName = templateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gatePattern = new RegExp(
    `^\\s*\\{\\{-?\\s*if\\s+eq\\s+\\(\\s*\\.Values\\.template\\s*\\|\\s*default\\s+(?:""|'')\\s*\\)\\s+(?:"${escapedName}"|'${escapedName}')\\s*-?\\}\\}\\s*$`,
    "m",
  );
  if (!gatePattern.test(content)) {
    gateViolations.push(
      `${relative(root, path)}: missing or mismatched chart template gate for "${templateName}"; expected {{- if eq (.Values.template | default "") "${templateName}" }}. See CLAUDE.md Chart template gate gotcha and author-workflow-template skill.`,
    );
  }
}

if (violations.length > 0 || gateViolations.length > 0) {
  for (const violation of gateViolations) console.error(violation);

  if (violations.length === 0) process.exit(1);

  console.error("✗ check-templates: bare force-push found in a chart template.\n");
  console.error("  Use `git push --force-with-lease` (never a bare `--force` / `-f`) — the lease");
  console.error("  protects commits pushed since the last fetch. On a token-URL push (not a named");
  console.error('  remote) use the explicit form: --force-with-lease="<branch>:<expected-sha>".\n');
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}

console.log("✓ check-templates: no unsafe force-push in chart templates");
