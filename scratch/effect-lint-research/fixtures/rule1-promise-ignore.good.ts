import { Effect } from "effect";
// GOOD: tryPromise puts rejection in typed channel; ignore CAN catch it
const cleanup = Effect.tryPromise({ try: () => client.stop(), catch: (e) => e }).pipe(Effect.ignore);
// GOOD: bare Effect.promise without ignore is fine
const task = Effect.promise(() => fetchData());
