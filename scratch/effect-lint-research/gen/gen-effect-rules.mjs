#!/usr/bin/env node
/**
 * gen-effect-rules.mjs — PROTOTYPE (scratch only, do not move to scripts/)
 *
 * Reads the installed effect-claude-primitives plugin and attempts to:
 * 1. Find code fences labeled as bad/good patterns
 * 2. Emit ast-grep YAML rule stubs where possible
 * 3. Write a manifest recording each rule's source skill and content hash
 *
 * Run from repo root: node scratch/effect-lint-research/gen/gen-effect-rules.mjs
 */
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ROOT = join(homedir(), ".claude/plugins/cache/effect-primitives/effect-claude-primitives/1.1.0/skills");
const OUT_DIR = "scratch/effect-lint-research/gen/output";

if (!existsSync(OUT_DIR)) {
  import("node:fs").then(fs => fs.mkdirSync(OUT_DIR, { recursive: true }));
}
import { mkdirSync } from "node:fs";
mkdirSync(OUT_DIR, { recursive: true });

function sha256(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function extractFencePairs(text) {
  // Find consecutive ❌ Bad ... ✅ Good pairs from tooling-debugging style
  const pairs = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Look for fence openings preceded by a "bad" label comment
    if (line.startsWith("// ❌ Bad:")) {
      const badLabel = line.slice("// ❌ Bad:".length).trim();
      // Collect the fence that follows
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith("```")) j++;
      if (j >= lines.length) { i++; continue; }
      let fenceStart = j + 1;
      let fenceEnd = fenceStart;
      while (fenceEnd < lines.length && !lines[fenceEnd].startsWith("```")) fenceEnd++;
      const badCode = lines.slice(fenceStart, fenceEnd).join("\n").trim();
      // Look for the matching ✅ Good
      let k = fenceEnd + 1;
      while (k < lines.length && !lines[k].startsWith("// ✅ Good:")) k++;
      if (k >= lines.length) { i++; continue; }
      const goodLabel = lines[k].slice("// ✅ Good:".length).trim();
      let l = k + 1;
      while (l < lines.length && !lines[l].startsWith("```")) l++;
      let goodFenceStart = l + 1;
      let goodFenceEnd = goodFenceStart;
      while (goodFenceEnd < lines.length && !lines[goodFenceEnd].startsWith("```")) goodFenceEnd++;
      const goodCode = lines.slice(goodFenceStart, goodFenceEnd).join("\n").trim();
      pairs.push({ badLabel, badCode, goodLabel, goodCode });
      i = goodFenceEnd + 1;
    } else {
      i++;
    }
  }
  return pairs;
}

function extractAvoidPatternsFromBullets(text) {
  // Find ❌ bullet points (mcp-server style: prose, not fences)
  const avoids = [];
  for (const line of text.split("\n")) {
    if (line.match(/^- ❌/)) {
      avoids.push(line.replace(/^- ❌\s*/, "").trim());
    }
  }
  return avoids;
}

// Walk all skill directories
const skillDirs = readdirSync(PLUGIN_ROOT).filter(d => {
  const p = join(PLUGIN_ROOT, d);
  return statSync(p).isDirectory();
});

const manifest = { generated: new Date().toISOString(), rules: [], prosePatternsOnly: [] };

for (const skillName of skillDirs) {
  const skillDir = join(PLUGIN_ROOT, skillName);
  
  // Collect all markdown files: SKILL.md + references/*.md
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

    // Try to extract fence pairs (❌ Bad / ✅ Good format)
    const pairs = extractFencePairs(text);
    for (const pair of pairs) {
      const ruleId = `effect-${skillName.replace("effect-", "")}-${sha256(pair.badLabel).slice(0, 6)}`;
      const ruleNote = [
        `BAD label: ${pair.badLabel}`,
        `GOOD label: ${pair.goodLabel}`,
        ``,
        `BAD code:`,
        pair.badCode,
        ``,
        `GOOD code:`,
        pair.goodCode,
      ].join("\n");
      
      // A generator CAN identify the bad shape from prose, but cannot reliably
      // derive an ast-grep structural pattern automatically. Emit a STUB.
      const stub = [
        `id: ${ruleId}`,
        `language: TypeScript`,
        `# SOURCE: ${shortPath}`,
        `# SOURCE_HASH: ${hash}`,
        `# GENERATED: stub only — bad/good pattern from markdown pair`,
        `# HUMAN REVIEW REQUIRED: translate the code shape below into an ast-grep rule`,
        `message: |`,
        `  ${pair.badLabel}`,
        `  Prefer: ${pair.goodLabel}`,
        `severity: warning`,
        `rule:`,
        `  # TODO: fill in ast-grep structural pattern from the bad code below`,
        `  # Bad code shape:`,
        ...pair.badCode.split("\n").map(l => `  #   ${l}`),
        `  pattern: "TODO"`,
      ].join("\n");
      
      writeFileSync(join(OUT_DIR, `${ruleId}.yaml`), stub + "\n");
      manifest.rules.push({
        ruleId,
        sourceFile: shortPath,
        sourceHash: hash,
        kind: "stub",
        label: pair.badLabel,
      });
    }

    // Extract prose ❌ bullets — these cannot be rules but should be in manifest
    const avoids = extractAvoidPatternsFromBullets(text);
    for (const avoid of avoids) {
      manifest.prosePatternsOnly.push({
        sourceFile: shortPath,
        sourceHash: hash,
        pattern: avoid,
        note: "prose-only — no code fence pair; cannot derive structural rule automatically",
      });
    }
  }
}

writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated ${manifest.rules.length} rule stubs and found ${manifest.prosePatternsOnly.length} prose-only patterns.`);
console.log(`Output in ${OUT_DIR}/`);
