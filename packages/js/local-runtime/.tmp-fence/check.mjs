import { Effect, Layer } from "effect";
import { ExecPolicyStore } from "engine-core";
import { NatsKvLive } from "../dist/infrastructure/nats-kv.js";
import { NatsExecPolicyStoreLive } from "../dist/infrastructure/nats-registry-stores.js";
import { assertExecutorAllowed } from "../dist/domain/policy.js";

const url = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const layer = NatsExecPolicyStoreLive.pipe(Layer.provideMerge(NatsKvLive(url)));
const program = Effect.gen(function* () {
  const store = yield* ExecPolicyStore;
  yield* store.save({
    denied: [{ name: "codex", reason: "operator", deniedAt: new Date().toISOString() }],
    updatedAt: new Date().toISOString(),
  });
  const codex = yield* assertExecutorAllowed("codex", new Date().toISOString()).pipe(
    Effect.map(() => "ALLOWED (wrong!)"),
    Effect.catchAll((e) => Effect.succeed(`DENIED — ${e.message}`)),
  );
  const claude = yield* assertExecutorAllowed("claude", new Date().toISOString()).pipe(
    Effect.map(() => "ALLOWED"),
    Effect.catchAll((e) => Effect.succeed(`DENIED (wrong!) ${e.message}`)),
  );
  yield* store.save({ denied: [], updatedAt: new Date().toISOString() });
  return { codex, claude };
});
console.log(await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer)))));
