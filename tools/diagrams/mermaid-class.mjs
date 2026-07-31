// Mermaid classDiagram assembly — pure over a manifest and an injected extractor, so
// generation is unit-testable with a stub extractor and composable with future extractors
// (a Python one, a checker-based one) without touching this module.

/**
 * manifest → mermaid classDiagram text.
 * `extract(entry) → { lines, stereotype?, realizes? }` supplies each class's body;
 * realization edges derive from `realizes` matching an included class's id/symbol;
 * `manifest.relations` adds the curated uses-edges ([from, to, arrow|null, label?]).
 */
export function generateClassDiagram(manifest, extract) {
  const out = ["classDiagram"];
  if (manifest.direction) out.push(`  direction ${manifest.direction}`);
  out.push("");

  const ids = new Set(manifest.classes.map((c) => c.id));
  const realizations = [];

  for (const entry of manifest.classes) {
    const { lines, stereotype, realizes } = extract(entry);
    out.push(`  class ${entry.id} {`);
    if (stereotype) out.push(`    <<${stereotype}>>`);
    for (const line of lines) out.push(`    ${line}`);
    out.push("  }");
    out.push("");
    if (realizes) {
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
