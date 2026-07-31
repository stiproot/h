// Type-text sanitising for mermaid class-diagram member lines — deterministic, few rules,
// documented (part of the diagrams toolkit; see tools/diagrams/README.md):
//   1. whitespace collapses;
//   2. an inline object literal type reads as `object`, a function type as `fn`;
//   3. generics keep the outer name + FIRST argument only (`Effect.Effect<A, E, R>` →
//      `Effect~A~`), because mermaid member lines cannot carry commas safely;
//   4. member lines cap at 72 chars.

export function shortType(text) {
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

export const capLine = (line) => (line.length > 72 ? `${line.slice(0, 69)}…` : line);
