import { CommunicationProtocolEnum, DaprServer } from "@dapr/dapr";
import { Context, Effect, Layer } from "effect";

import { DaprActorError } from "./actor-client.ts";
import { GenericActor } from "./generic-actor.ts";
import { waitForSidecarEffect, type DaprSidecarError } from "./wait-for-sidecar.ts";

export interface ActorHostOptions {
  // Port the express/DaprServer actor runtime listens on. This must equal the Dapr
  // --app-port, because the sidecar calls actor callbacks (config, method, timer,
  // reminder) on the app-port. The JS actor SDK runs its own express listener and
  // cannot share Fastify's socket, hence a dedicated port.
  actorPort: string;
  daprHttpPort?: string;
  serverHost?: string;
}

/**
 * The running GenericActor host. The service is a handle, not a capability surface —
 * once the layer is built the host is up and the sidecar drives it via actor callbacks;
 * the DaprServer itself stays an adapter internal.
 */
export interface ActorHostService {
  /** Port the actor runtime listens on (the Dapr --app-port). */
  readonly actorPort: string;
}

/** Service tag for the actor host. Depend on it to require a running actor runtime. */
export class ActorHostTag extends Context.Tag("ActorHost")<ActorHostTag, ActorHostService>() {}

// One startup step of the host acquisition, with the SDK's rejection mapped to the tag.
const step = (
  operation: string,
  run: () => Promise<unknown>,
): Effect.Effect<unknown, DaprActorError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new DaprActorError({ cause, operation }) });

/**
 * Scoped live layer hosting the GenericActor runtime. Acquisition preserves the legacy
 * ordering EXACTLY — it is load-bearing: registerActor must precede start, waitForSidecar
 * must gate start, and start() does NOT auto-call actor.init() — init() registers the
 * actor callback routes.
 *
 * Release calls `DaprServer.stop()` — verified present in the installed @dapr/dapr@3.17.0
 * typings (`stop(): Promise<void>`, delegating to the underlying HTTP server's stop).
 * It is wrapped best-effort (`Effect.ignore`): the SDK's stop may reject when the server
 * never fully started, and scope teardown must not fail on it.
 */
export const ActorHostLive = (
  opts: ActorHostOptions,
): Layer.Layer<ActorHostTag, DaprActorError | DaprSidecarError> =>
  Layer.scoped(
    ActorHostTag,
    Effect.gen(function* () {
      const daprPort = opts.daprHttpPort ?? "3500";
      // Register the finalizer against the constructed server BEFORE the startup steps run,
      // so a failure mid-sequence (e.g. actor.init after a successful start) still stops it.
      const server = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new DaprServer({
              serverHost: opts.serverHost ?? "0.0.0.0",
              serverPort: opts.actorPort,
              communicationProtocol: CommunicationProtocolEnum.HTTP,
              clientOptions: { daprHost: "127.0.0.1", daprPort },
            }),
        ),
        (s) => Effect.ignore(Effect.tryPromise(() => s.stop())),
      );
      yield* step("registerActor", () => server.actor.registerActor(GenericActor));
      yield* waitForSidecarEffect(daprPort);
      yield* step("start", () => server.start());
      yield* step("actor.init", () => server.actor.init());
      return { actorPort: opts.actorPort };
    }),
  );
