// Managed-doc plumbing: find the `<!-- gen:c4-code {json} -->` manifest in a diagram doc and
// replace its first mermaid fence. Pure over text (unit-testable); the CLI composes file IO.

export const MARKER = /<!--\s*gen:c4-code\s*(\{[\s\S]*?\})\s*-->/;
const FENCE = /```mermaid\n[\s\S]*?\n```/;

/** The parsed manifest of a managed doc, or null when the doc is not managed. */
export function parseManifest(text) {
  const marker = text.match(MARKER);
  return marker ? JSON.parse(marker[1]) : null;
}

/** Replace the doc's first mermaid fence with `diagram`. Throws when no fence exists. */
export function replaceFence(text, diagram) {
  if (!FENCE.test(text)) throw new Error("no mermaid fence to replace");
  return text.replace(FENCE, `\`\`\`mermaid\n${diagram}\`\`\``);
}
