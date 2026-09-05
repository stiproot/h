import { Effect } from "effect";
// GOOD: Effect.try wraps the throwing call
const program = Effect.try({ try: () => JSON.parse(text), catch: (e) => e });
// GOOD: try/catch outside Effect.gen is fine
function parse(text: string) {
  try { return JSON.parse(text); } catch (e) { return null; }
}
