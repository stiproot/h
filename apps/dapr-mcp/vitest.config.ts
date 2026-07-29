import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Suppress ONE known third-party incompatibility, and nothing else.
     *
     * `@hono/node-server` (a dependency of @modelcontextprotocol/sdk) arms a force-close timer
     * when a server is shut down; if the timer fires it calls `socket.destroySoon()`, a Node
     * API that Bun's socket does not implement:
     *
     *     TypeError: socket.destroySoon is not a function
     *       ❯ Timeout.forceClose @hono/node-server/dist/index.mjs:390:14
     *       ❯ listOnTimeout node:internal/timers
     *
     * It fires on a TIMER after the tests have already finished — all 41 pass — so it is a
     * teardown artifact, not a failure of anything under test. It only appears when teardown is
     * slow enough for the timer to win, which is why it surfaces exclusively under `turbo test`
     * load (23 tasks on 8 cores) and never when this package's tests run alone. Vitest fails the
     * run on any unhandled error, so a green suite became load-dependent.
     *
     * Vitest recommends this hook over `dangerouslyIgnoreUnhandledErrors`, which would hide
     * EVERY unhandled error including real ones. The match below is deliberately narrow: exact
     * message AND the @hono/node-server frame. Anything else still fails the run.
     *
     * Remove this when the SDK's @hono/node-server dependency stops calling `destroySoon`, or
     * when Bun implements it.
     */
    onUnhandledError(error) {
      const isHonoBunSocketGap =
        error.message?.includes("socket.destroySoon is not a function") &&
        (error.stack?.includes("@hono/node-server") ?? false);
      if (isHonoBunSocketGap) return false;
    },
  },
});
