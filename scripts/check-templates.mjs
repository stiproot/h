#!/usr/bin/env node
// Chart-template content guard — fail LOUDLY when a workflow template's agent prose tells an
// agent to force-push UNSAFELY.
//
// The `revise` workflow rebases a stale PR branch onto main and force-pushes (the
// first force-push in the codebase). The sanctioned convention is
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

export function hasCompleteTemplateGate(content, templateName) {
  const escapedName = templateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gatePattern = new RegExp(
    `^if\\s+eq\\s+\\(\\s*\\.Values\\.template\\s*\\|\\s+default\\s+(?:""|'')\\s*\\)\\s+(?:"${escapedName}"|'${escapedName}')$`,
  );
  const actionPattern = /\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}|\{\{-?([\s\S]*?)-?\}\}/g;
  const stack = [];
  let gateDepth = -1;
  let gateSeen = false;
  let gateHasRenderableContent = false;
  let cursor = 0;

  for (const match of content.matchAll(actionPattern)) {
    const inDefinition = stack.some((entry) => entry === "define");
    const text = content.slice(cursor, match.index).trim();
    if (text && gateDepth === -1 && !inDefinition) return false;
    if (text && gateDepth !== -1 && !inDefinition) gateHasRenderableContent = true;

    const isComment = match[1] === undefined;
    const action = isComment ? "" : match[1].trim();
    const control = action.match(/^(if|range|with|define|block)\b/);
    const isStructuralAction =
      control ||
      /^(?:end|else|break|continue)(?:\s|$)/.test(action) ||
      /^\$[\w.]+\s*(?::=|=)/.test(action);

    if (
      gateDepth !== -1 &&
      !inDefinition &&
      !isComment &&
      action &&
      !isStructuralAction
    ) {
      gateHasRenderableContent = true;
    }

    if (
      gateDepth === -1 &&
      !inDefinition &&
      !isComment &&
      !gatePattern.test(action) &&
      control?.[1] !== "define"
    ) {
      return false;
    }

    if (control) {
      const entry = gatePattern.test(action) ? "gate" : control[1];
      stack.push(entry);
      if (entry === "gate") {
        if (gateSeen) return false;
        gateSeen = true;
        gateDepth = stack.length;
      }
    } else if (/^end(?:\s|$)/.test(action)) {
      if (stack.length === 0) return false;
      if (stack.length === gateDepth) gateDepth = -1;
      stack.pop();
    } else if (/^else(?:\s|$)/.test(action)) {
      if (stack.length === 0 || stack.length === gateDepth) return false;
    }

    cursor = match.index + match[0].length;
  }

  return gateSeen && gateHasRenderableContent && stack.length === 0 && !content.slice(cursor).trim();
}

export function declaredTemplateRole(content) {
  const roles = [...content.matchAll(/^role:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  return roles.length === 1 && ["standalone", "base", "overlay"].includes(roles[0])
    ? roles[0]
    : null;
}

// The catalog line `h template list` shows beside the role. Same plain-top-level mechanic as
// `role:` (column-0 line-scan, no render), required on every stock template so the listing
// can't drift back to bare names; consumer charts without one degrade to "—" in the CLI.
export function declaredTemplateSummary(content) {
  const summaries = [...content.matchAll(/^summary:\s*(.+?)\s*$/gm)].map((match) => match[1]);
  if (summaries.length !== 1 || summaries[0].length === 0) return null;
  // The value must stay a plain YAML scalar: an inner `: ` starts a nested mapping and breaks
  // EVERY render of the chart (helm parses the whole file). Use an em-dash instead of a colon.
  if (summaries[0].includes(": ") || summaries[0].endsWith(":")) return null;
  return summaries[0];
}

export function checkTemplates() {
  const violations = [];
  const suffixViolations = [];
  const gateViolations = [];
  const roleViolations = [];
  const summaryViolations = [];
  for (const file of readdirSync(templatesDir).filter((f) => f !== "_helpers.tpl")) {
    if (!file.endsWith(".tmpl.yaml")) {
      suffixViolations.push(
        `${relative(root, join(templatesDir, file))}: workflow template files must end in .tmpl.yaml`,
      );
      continue;
    }
    const path = join(templatesDir, file);
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (!/git\s+push/.test(line)) return;
      if (bareForce.test(line) || shortForce.test(line)) {
        violations.push({ file: relative(root, path), line: i + 1, text: line.trim() });
      }
    });

    const templateName = basename(file, ".tmpl.yaml");
    if (!hasCompleteTemplateGate(content, templateName)) {
      gateViolations.push(
        `${relative(root, path)}: missing or mismatched chart template gate for "${templateName}"; expected {{- if eq (.Values.template | default "") "${templateName}" }}. See CLAUDE.md Chart template gate gotcha and author-workflow-template skill.`,
      );
    }
    if (!declaredTemplateRole(content)) {
      roleViolations.push(
        `${relative(root, path)}: missing or invalid plain top-level role; expected exactly one of standalone|base|overlay.`,
      );
    }
    if (!declaredTemplateSummary(content)) {
      summaryViolations.push(
        `${relative(root, path)}: missing or invalid plain top-level summary; expected exactly one non-empty \`summary: <one line>\` beside \`role:\` — the catalog line \`h template list\` shows.`,
      );
    }
  }

  if (
    violations.length > 0 ||
    suffixViolations.length > 0 ||
    gateViolations.length > 0 ||
    roleViolations.length > 0 ||
    summaryViolations.length > 0
  ) {
    for (const violation of suffixViolations) console.error(violation);
    for (const violation of gateViolations) console.error(violation);
    for (const violation of roleViolations) console.error(violation);
    for (const violation of summaryViolations) console.error(violation);

    if (violations.length === 0) return 1;

    console.error("✗ check-templates: bare force-push found in a chart template.\n");
    console.error("  Use `git push --force-with-lease` (never a bare `--force` / `-f`) — the lease");
    console.error("  protects commits pushed since the last fetch. On a token-URL push (not a named");
    console.error('  remote) use the explicit form: --force-with-lease="<branch>:<expected-sha>".\n');
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
    return 1;
  }

  console.log("✓ check-templates: suffixes, gates, roles, summaries, and force-pushes are valid");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkTemplates());
}
