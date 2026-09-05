import { Effect } from "effect";
// BAD: raw try/catch inside Effect.gen
const program = Effect.gen(function* () {
  try {
    const result = JSON.parse(text);
    return result;
  } catch (e) {
    return null;
  }
});
