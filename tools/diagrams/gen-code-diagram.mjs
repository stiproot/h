#!/usr/bin/env node
// Deterministic C4 code diagrams (level 4) — thin CLI over the composable toolkit in
// tools/diagrams/ (sanitize / ts-extract / mermaid-class / managed-doc; see its README).
//
// The split that keeps the c4-code guidance honest ("story members, not exhaustive dumps",
// per the c4-mermaid-plugin's c4-code skill) while making updates trivial:
//   - SCOPE, TOPOLOGY, NOTES are curated in a manifest embedded in the diagram doc
//     (<!-- gen:c4-code {json} -->) — judgment calls no parser should make.
//   - MEMBERS are extracted from the TypeScript AST on every run — the part that goes stale.
//
// `--check` regenerates in memory and fails on drift — wired into `bun run lint`, so a
// refactor that changes a diagrammed contract fails the build until the diagram is
// regenerated (the *Harden by encoding* principle applied to pictures).
//
// Usage:
//   node tools/diagrams/gen-code-diagram.mjs       # regenerate every managed doc in docs/diagrams/
//   node tools/diagrams/gen-code-diagram.mjs --check   # fail on drift (lint mode)
//   node tools/diagrams/gen-code-diagram.mjs <doc.md> ...  # specific docs

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateClassDiagram } from "./mermaid-class.mjs";
import { parseManifest, replaceFence } from "./managed-doc.mjs";
import { extractClass } from "./ts-extract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIAGRAMS = join(root, "docs/diagrams");

function processDoc(path, check) {
  const text = readFileSync(path, "utf8");
  const manifest = parseManifest(text);
  if (manifest === null) return { managed: false };
  const diagram = generateClassDiagram(manifest, (entry) => extractClass(root, entry, { join }));
  const next = replaceFence(text, diagram);
  if (next === text) return { managed: true, changed: false };
  if (!check) writeFileSync(path, next);
  return { managed: true, changed: true };
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const docs = args.filter((a) => a !== "--check");
const targets =
  docs.length > 0
    ? docs.map((d) => resolve(d))
    : readdirSync(DIAGRAMS)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(DIAGRAMS, f));

let managedCount = 0;
const drifted = [];
for (const path of targets) {
  const result = processDoc(path, check);
  if (!result.managed) continue;
  managedCount += 1;
  if (result.changed && check) drifted.push(path);
  else if (result.changed) console.log(`gen-code-diagram: regenerated ${path}`);
}

if (check && drifted.length > 0) {
  console.error("gen-code-diagram: diagram fences drifted from the code\n");
  for (const d of drifted) console.error(`  ✗ ${d}`);
  console.error("\nRegenerate with: node tools/diagrams/gen-code-diagram.mjs");
  process.exit(1);
}
console.log(`gen-code-diagram: ok (${managedCount} managed doc(s)${check ? ", no drift" : ""})`);
