#!/usr/bin/env node
/**
 * gen-effect-rules-v2.mjs — PROTOTYPE v2
 * Fixed: the ❌/✅ comment labels are INSIDE fences, not before them.
 * This version parses fence blocks and looks for the labels inside them.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ROOT = join(homedir(), ".claude/plugins/cache/effect-primitives/effect-claude-primitives/1.1.0/skills");
const OUT_DIR = "scratch/effect-lint-research/gen/output-v2";
mkdirSync(OUT_DIR, { recursive: true });

function sha256(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Extract all code fences and their content from a markdown file
function extractFences(text) {
  const fences = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceLines = [];
  let fenceLang = "";
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence && line.startsWith("```")) {
      inFence = true;
      fenceLang = line.slice(3).trim();
      fenceLines = [];
      startLine = i;
    } else if (inFence && line.startsWith("```")) {
      inFence = false;
      fences.push({ lang: fenceLang, content: fenceLines.join("\n"), startLine });
      fenceLines = [];
    } else if (inFence) {
      fenceLines.push(line);
    }
  }
  return fences;
}

// Try to find ❌/✅ labeled blocks within a SINGLE fence that contains both
// e.g. the tooling-debugging.md format where all examples are in one fence
function findPairsInFence(fence) {
  const pairs = [];
  const lines = fence.content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.match(/\/\/ ❌ Bad:/)) {
      const badLabel = line.replace(/.*\/\/ ❌ Bad:\s*/, "").trim();
      // Collect lines until we hit a blank line followed by ✅ Good
      const badLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/\/\/ ✅ Good:/)) {
        badLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) break;
      const goodLabel = lines[i].replace(/.*\/\/ ✅ Good:\s*/, "").trim();
      const goodLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/\/\/ ❌/) && !lines[i].match(/^---/)) {
        goodLines.push(lines[i]);
        i++;
      }
      pairs.push({
        badLabel,
        badCode: badLines.filter(l => l.trim()).join("\n").trim(),
        goodLabel,
        goodCode: goodLines.filter(l => l.trim()).join("\n").trim(),
      });
    } else {
      i++;
    }
  }
  return pairs;
}

const skillDirs = readdirSync(PLUGIN_ROOT).filter(d => statSync(join(PLUGIN_ROOT, d)).isDirectory());
const manifest = { generated: new Date().toISOString(), version: "v2", rules: [], prosePatternsOnly: [] };

let totalFences = 0;
let fencesWithPairs = 0;

for (const skillName of skillDirs) {
  const skillDir = join(PLUGIN_ROOT, skillName);
  const mdFiles = [];
  const skillMd = join(skillDir, "SKILL.md");
  if (existsSync(skillMd)) mdFiles.push(skillMd);
  const refDir = join(skillDir, "references");
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) {
      if (f.endsWith(".md")) mdFiles.push(join(refDir, f));
    }
  }

  for (const mdPath of mdFiles) {
    const text = readFileSync(mdPath, "utf8");
    const hash = sha256(text);
    const shortPath = mdPath.replace(homedir(), "~");
    const fences = extractFences(text);
    totalFences += fences.filter(f => f.lang === "typescript").length;

    for (const fence of fences) {
      const pairs = findPairsInFence(fence);
      if (pairs.length > 0) fencesWithPairs++;
      for (const pair of pairs) {
        const ruleId = `effect-${skillName.replace("effect-", "")}-${sha256(pair.badLabel).slice(0, 8)}`;
        const stub = [
          `id: ${ruleId}`,
          `language: TypeScript`,
          `# SOURCE: ${shortPath}`,
          `# SOURCE_HASH: ${hash}`,
          `# GENERATED: stub — bad/good pair from inline fence comments`,
          `# HUMAN REVIEW REQUIRED: convert the code shape below to an ast-grep rule`,
          `message: |`,
          `  ${pair.badLabel}`,
          `  Prefer: ${pair.goodLabel}`,
          `severity: warning`,
          `rule:`,
          `  # TODO: fill in from bad code:`,
          ...pair.badCode.split("\n").map(l => `  # ${l}`),
          `  pattern: "TODO"`,
        ].join("\n");
        writeFileSync(join(OUT_DIR, `${ruleId}.yaml`), stub + "\n");
        manifest.rules.push({ ruleId, sourceFile: shortPath, sourceHash: hash, kind: "stub", label: pair.badLabel });
      }

    }

    // Prose ❌ bullets (no code fence)
    for (const line of text.split("\n")) {
      if (line.match(/^- ❌/)) {
        manifest.prosePatternsOnly.push({
          sourceFile: shortPath, sourceHash: hash,
          pattern: line.replace(/^- ❌\s*/, "").trim(),
          note: "prose bullet — no code fence; cannot derive structural rule",
        });
      }
    }
  }
}

writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Total TypeScript fences scanned: ${totalFences}`);
console.log(`Fences containing ❌/✅ pairs: ${fencesWithPairs}`);
console.log(`Rule stubs generated: ${manifest.rules.length}`);
console.log(`Prose-only patterns (no fence): ${manifest.prosePatternsOnly.length}`);
if (manifest.rules.length > 0) {
  console.log("\nRule stubs:");
  for (const r of manifest.rules) console.log(`  ${r.ruleId}: ${r.label}`);
}
if (manifest.prosePatternsOnly.length > 0) {
  console.log("\nProse-only patterns:");
  for (const p of manifest.prosePatternsOnly) console.log(`  [${p.sourceFile.split("/").slice(-3).join("/")}] ${p.pattern}`);
}
