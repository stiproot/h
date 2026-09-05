import { Effect } from "effect";
// BAD: rejection from Effect.promise is a defect; Effect.ignore does not catch defects
const cleanup = Effect.promise(() => client.stop()).pipe(Effect.ignore);
const release = Effect.promise(() => connection.close()).pipe(Effect.ignore);
