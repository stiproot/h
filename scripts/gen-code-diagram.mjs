#!/usr/bin/env node
// Deterministic C4 code diagrams (level 4) — the AST is the source of truth for MEMBERS.
//
// The split that keeps the c4-code guidance honest ("story members, not exhaustive dumps",
// per the c4-mermaid-plugin's c4-code skill) while making updates trivial:
//   - SCOPE, TOPOLOGY, NOTES are curated in a small manifest embedded in the diagram doc
//     (an HTML comment: <!-- gen:c4-code {json} -->) — which symbols appear, which
//     uses-relations matter, the one-line per-symbol notes. These change rarely and are
//     judgment calls no parser should make.
//   - MEMBERS (interface methods/props, union arms, module function signatures) are extracted
//     from the TypeScript AST on every run — the part that actually goes stale when code moves.
//
// The generator REPLACES the first ```mermaid fence in each managed doc. `--check` regenerates
// in memory and fails when the committed fence drifts from the code — wired into `bun run
// lint`, so a refactor that changes a diagrammed contract fails the build until the diagram is
// regenerated (the *Harden by encoding* principle applied to pictures).
//
// Usage:
//   node scripts/gen-code-diagram.mjs               # regenerate every managed doc in docs/diagrams/
//   node scripts/gen-code-diagram.mjs --check       # fail on drift (lint mode)
//   node scripts/gen-code-diagram.mjs <doc.md> ...  # specific docs

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIAGRAMS = join(root, "docs/diagrams");
const MARKER = /<!--\s*gen:c4-code\s*(\{[\s\S]*?\})\s*-->/;

// ---------------------------------------------------------------------------
// Type-text sanitising — deterministic, few rules, documented:
//   1. whitespace collapses;
//   2. an inline object literal type reads as `object`, a function type as `fn`;
//   3. generics keep the outer name + FIRST argument only (`Effect.Effect<A, E, R>` →
//      `Effect~A~`), because mermaid member lines cannot carry commas safely;
//   4. member lines cap at 64 chars.
// ---------------------------------------------------------------------------

function shortType(text) {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.startsWith("{")) return "object";
  if (t.includes("=>")) return "fn";
  const generic = t.match(/^([\w.]+)<(.+)>$/);
  if (generic) {
    const outer = generic[1].split(".").pop();
    // First top-level argument only.
    let depth = 0;
    let first = "";
    for (const ch of generic[2]) {
      if (ch === "<") depth++;
      if (ch === ">") depth--;
      if (ch === "," && depth === 0) break;
      first += ch;
    }
    return `${outer}~${shortType(first.trim())}~`;
  }
  return t;
}

const capLine = (line) => (line.length > 72 ? `${line.slice(0, 69)}…` : line);

/** A destructured parameter's binding pattern must not leak verbatim — render it as `opts`. */
const paramName = (src, p) => (ts.isIdentifier(p.name) ? p.name.getText(src) : "opts");

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

function parseFile(relPath) {
  const abs = join(root, relPath);
  const text = readFileSync(abs, "utf8");
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
}

function memberLines(src, decl) {
  const lines = [];
  for (const m of decl.members) {
    const name = m.name?.getText(src);
    if (!name) continue;
    const opt = m.questionToken ? "?" : "";
    if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
      const params = m.parameters.map((p) => paramName(src, p)).join(", ");
      const ret = m.type ? ` ${shortType(m.type.getText(src))}` : "";
      lines.push(capLine(`+${name}${opt}(${params})${ret}`));
    } else if (
      (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) &&
      m.type &&
      ts.isFunctionTypeNode(m.type)
    ) {
      // A function-typed property IS the method surface (the Effect-service idiom) — render
      // it as one, not as an opaque `fn`.
      const params = m.type.parameters.map((p) => paramName(src, p)).join(", ");
      const ret = m.type.type ? ` ${shortType(m.type.type.getText(src))}` : "";
      lines.push(capLine(`+${name}${opt}(${params})${ret}`));
    } else if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
      const t = m.type ? ` ${shortType(m.type.getText(src))}` : "";
      lines.push(capLine(`+${name}${opt}${t}`));
    }
  }
  return lines;
}

function findTopLevel(src, predicate) {
  return src.statements.find(predicate);
}

/** Extract one manifest class entry → { lines, stereotype, realizes } */
function extractClass(entry) {
  const src = parseFile(entry.file);
  const kind = entry.kind;

  if (kind === "interface") {
    const decl = findTopLevel(
      src,
      (s) => ts.isInterfaceDeclaration(s) && s.name.text === entry.symbol,
    );
    if (!decl) throw new Error(`${entry.file}: interface ${entry.symbol} not found`);
    return { lines: memberLines(src, decl), stereotype: entry.stereotype ?? "interface" };
  }

  if (kind === "union") {
    const decl = findTopLevel(
      src,
      (s) => ts.isTypeAliasDeclaration(s) && s.name.text === entry.symbol,
    );
    if (!decl) throw new Error(`${entry.file}: type ${entry.symbol} not found`);
    const arms = decl.type.getText(src).replace(/\s+/g, " ").replace(/"/g, "");
    return { lines: [capLine(arms)], stereotype: entry.stereotype ?? "union" };
  }

  if (kind === "const") {
    const stmt = findTopLevel(
      src,
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => d.name.getText(src) === entry.symbol),
    );
    if (!stmt) throw new Error(`${entry.file}: const ${entry.symbol} not found`);
    const decl = stmt.declarationList.declarations.find(
      (d) => d.name.getText(src) === entry.symbol,
    );
    const annotated = decl.type ? decl.type.getText(src).replace(/\s+/g, " ") : undefined;
    // The note is manifest-curated; the REALIZATION edge is AST truth (the type annotation).
    return {
      lines: entry.note ? [capLine(entry.note)] : [],
      stereotype: entry.stereotype,
      realizes: annotated,
    };
  }

  if (kind === "module") {
    const lines = [];
    for (const fn of entry.functions) {
      const decl = findTopLevel(
        src,
        (s) => ts.isFunctionDeclaration(s) && s.name?.text === fn,
      );
      if (decl) {
        const params = decl.parameters.map((p) => paramName(src, p)).join(", ");
        const ret = decl.type ? ` ${shortType(decl.type.getText(src))}` : "";
        lines.push(capLine(`+${fn}(${params})${ret}`));
        continue;
      }
      const stmt = findTopLevel(
        src,
        (s) =>
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.some((d) => d.name.getText(src) === fn),
      );
      if (!stmt) throw new Error(`${entry.file}: function ${fn} not found`);
      const vd = stmt.declarationList.declarations.find((d) => d.name.getText(src) === fn);
      const init = vd.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const params = init.parameters.map((p) => paramName(src, p)).join(", ");
        const ret = init.type ? ` ${shortType(init.type.getText(src))}` : "";
        lines.push(capLine(`+${fn}(${params})${ret}`));
      } else {
        lines.push(capLine(`+${fn}`));
      }
    }
    return { lines, stereotype: entry.stereotype ?? `module ${entry.file.split("/").pop()}` };
  }

  throw new Error(`unknown kind "${kind}" for ${entry.id}`);
}

// ---------------------------------------------------------------------------
// Diagram assembly
// ---------------------------------------------------------------------------

function generate(manifest) {
  const out = ["classDiagram"];
  if (manifest.direction) out.push(`  direction ${manifest.direction}`);
  out.push("");

  const ids = new Set(manifest.classes.map((c) => c.id));
  const realizations = [];

  for (const entry of manifest.classes) {
    const { lines, stereotype, realizes } = extractClass(entry);
    out.push(`  class ${entry.id} {`);
    if (stereotype) out.push(`    <<${stereotype}>>`);
    for (const line of lines) out.push(`    ${line}`);
    out.push("  }");
    out.push("");
    if (realizes) {
      // Realize against an included class whose id (or symbol) the annotation names.
      const target = manifest.classes.find(
        (c) => realizes === c.id || realizes === c.symbol || realizes.startsWith(`${c.symbol}<`),
      );
      if (target && ids.has(target.id)) realizations.push(`  ${entry.id} ..|> ${target.id}`);
    }
  }

  for (const r of realizations) out.push(r);
  for (const [from, to, arrow, label] of manifest.relations ?? []) {
    out.push(`  ${from} ${arrow ?? "-->"} ${to}${label ? ` : ${label}` : ""}`);
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Doc rewriting + check mode
// ---------------------------------------------------------------------------

const FENCE = /```mermaid\n[\s\S]*?\n```/;

function processDoc(path, check) {
  const text = readFileSync(path, "utf8");
  const marker = text.match(MARKER);
  if (!marker) return { managed: false };
  const manifest = JSON.parse(marker[1]);
  const diagram = generate(manifest);
  const replacement = `\`\`\`mermaid\n${diagram}\`\`\``;
  if (!FENCE.test(text)) throw new Error(`${path}: no mermaid fence to replace`);
  const next = text.replace(FENCE, replacement);
  if (next === text) return { managed: true, changed: false };
  if (check) return { managed: true, changed: true };
  writeFileSync(path, next);
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
  console.error("\nRegenerate with: node scripts/gen-code-diagram.mjs");
  process.exit(1);
}
console.log(`gen-code-diagram: ok (${managedCount} managed doc(s)${check ? ", no drift" : ""})`);
