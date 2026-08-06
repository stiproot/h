#!/usr/bin/env node
// Canonical-diagram guard — fail LOUDLY when the diagram set drifts from its own rules.
//
// Diagrams are h's communication medium for design and architecture (CLAUDE.md, "Diagrams are the
// medium…"; the `diagrams` skill has the full policy). Enforcement used to cover only the
// GENERATED `-class` docs, via `gen-code-diagram --check` — which is precisely backwards for
// communication: the machine guarded the diagrams a tool rewrites anyway and stayed silent on the
// hand-authored sequence/C4 set, where the architecture actually gets explained. Result: the only
// diagram work that reliably happened was the work lint forced.
//
// This guard cannot tell you a hand-authored sequence diagram has quietly gone WRONG — no machine
// can. What it can do is keep the set navigable and well-formed, which is what makes the diagrams
// usable enough to be worth updating:
//
//   1. INDEX INTEGRITY, both directions. An unregistered diagram is invisible — nobody reads a
//      file they cannot find from the index; a dangling index row sends a reader to a 404.
//   2. NAMING. `<scope>-<kind>.md` with the kind from the closed vocabulary, so a reader can tell
//      a C4 component diagram from a UML class diagram by file name alone.
//   3. SHAPE. Exactly one mermaid fence (one diagram = one story) plus a `## Reading notes`
//      section — the notes are where the load-bearing invariants get named, and a diagram without
//      them is a picture without an argument.
//   4. GENERATED docs stay generated. A `-class` doc must carry its `gen:` manifest; hand-drawing
//      one puts it permanently out of step with the AST it claims to model.
//
// Wired into `bun run lint`. No skip flag.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The generator's OWN manifest parser, imported rather than re-implemented. The
// `@stiproot/code-comprehension` package publishes it (and its extractors) as explicit `exports`
// subpaths precisely so consumers do not hand-roll them — and this guard's whole subject is
// duplication drifting from its source, so re-deriving the marker regex here would be the exact
// mistake it exists to catch. If the managed-doc format changes upstream, this guard follows.
import { parseManifest } from "@stiproot/code-comprehension/managed-doc";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "docs/diagrams";
const INDEX = "README.md";

/** The closed kind vocabulary — the suffix a file name must end with. */
export const KINDS = [
  "sequence",
  "class",
  "c4-component",
  "uml-component",
  "c4-container",
  "c4-context",
  "state",
];

const kindOf = (name) => KINDS.find((kind) => name.endsWith(`-${kind}.md`));

/** Diagram docs in the set (README is the index, not a diagram). */
export function diagramFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== INDEX)
    .sort();
}

/** Every `./<name>.md` link target the index table points at. */
export function indexedNames(indexContents) {
  return new Set([...indexContents.matchAll(/\]\(\.\/([A-Za-z0-9._-]+\.md)\)/g)].map((m) => m[1]));
}

export function checkSet(files, indexContents, read) {
  const problems = [];
  const indexed = indexedNames(indexContents);

  for (const name of files) {
    if (!indexed.has(name)) {
      problems.push(
        `${DIR}/${name}: not registered in ${DIR}/${INDEX} — add a row to the set table, or a ` +
          "reader will never find it.",
      );
    }
    const kind = kindOf(name);
    if (!kind) {
      problems.push(
        `${DIR}/${name}: name must end with a kind — one of ${KINDS.map((k) => `-${k}`).join(", ")}` +
          " — so the diagram type is readable from the file name alone.",
      );
    }
    const contents = read(name);
    const fences = (contents.match(/^```mermaid$/gm) ?? []).length;
    if (fences !== 1) {
      problems.push(
        `${DIR}/${name}: has ${fences} mermaid fences, expected exactly 1 — one diagram is one ` +
          "story; split it or narrow it.",
      );
    }
    if (!/^## Reading notes$/m.test(contents)) {
      problems.push(
        `${DIR}/${name}: no '## Reading notes' section — name the load-bearing invariants the ` +
          "picture cannot say by itself.",
      );
    }
    // Complements `gen-code-diagram --check` rather than repeating it: the generator only sees
    // MANAGED docs, so a hand-drawn `-class` diagram with no manifest is invisible to it — it is
    // skipped, not flagged. This closes exactly that gap.
    if (kind === "class" && parseManifest(contents) === null) {
      problems.push(
        `${DIR}/${name}: a -class diagram is GENERATED from the AST and must carry its ` +
          "`gen:c4-code` manifest — without one the generator skips it silently, so it can never " +
          "drift-check. Produce it with `gen-code-diagram --dir docs/diagrams`, never by hand.",
      );
    }
  }

  for (const name of indexed) {
    if (!files.includes(name)) {
      problems.push(`${DIR}/${INDEX}: links './${name}', which does not exist (renamed? removed?)`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(root, DIR);
  if (!existsSync(dir)) {
    console.error(`✗ check-diagrams: ${DIR} is missing — this guard is checking nothing.`);
    process.exit(1);
  }
  const files = diagramFiles(dir);
  const problems = checkSet(files, readFileSync(join(dir, INDEX), "utf8"), (name) =>
    readFileSync(join(dir, name), "utf8"),
  );

  if (problems.length > 0) {
    console.error("✗ check-diagrams: the canonical diagram set drifted from its rules.\n");
    for (const problem of problems) console.error(`  ${relative(root, root)}${problem}`);
    console.error("\n  Policy: CLAUDE.md 'Diagrams are the medium…' + the `diagrams` skill.");
    process.exit(1);
  }
  console.log(`✓ check-diagrams: ${files.length} canonical diagrams registered and well-formed`);
}
