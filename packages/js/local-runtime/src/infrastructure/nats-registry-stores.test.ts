import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecPolicyStore, WfStore, WorkflowStore } from "engine-core";

import { assertExecutorAllowed } from "../domain/policy.ts";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NatsKvLive } from "./nats-kv.ts";
import {
  NatsExecPolicyStoreLive,
  NatsWfStoreLive,
  NatsWorkflowStoreLive,
} from "./nats-registry-stores.ts";

/**
 * These run against a REAL nats-server, spawned per suite on an ephemeral port.
 *
 * A fake `NatsKv` would exercise the mapping logic and miss everything that actually makes this
 * adapter risky: whether the server accepts the encoded keys at all, whether a decoded id survives
 * the round trip through `kv.keys()`, and whether the CAS rejection is the shape the code catches.
 * Those are the failure modes that produce an EMPTY registry rather than an error — the one class
 * of bug this substrate is most exposed to (see kv-key.ts). The binary is a hard dependency of
 * local mode, so requiring it here costs nothing a developer does not already have.
 *
 * The binary is REQUIRED, not optional-with-a-skip. A first attempt skipped when it was absent and
 * printed the reason with console.warn — which vitest SUPPRESSES when every test in a file is
 * skipped, so the run reported "6 skipped" and nothing else. That is the silent-green shape this
 * repo keeps finding in its own guards, reproduced inside a test file.
 *
 * So: a missing binary FAILS with the install hint, mirroring how every h surface refuses loud by
 * name (nats-server is a hard dependency of the local substrate). CI installs it. A deliberate
 * waiver is `H_SKIP_NATS_TESTS=1` — an explicit, greppable opt-out in the spirit of run-itest's
 * skip/skipReason break-glass, rather than an absence nobody notices.
 */

const WAIVED = process.env.H_SKIP_NATS_TESTS === "1";

const requireNatsServer = (): void => {
  try {
    execFileSync("nats-server", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "nats-server is not on PATH. It is a hard dependency of the local substrate, and these " +
        "registry adapters are tested against a real server because the bug they exist to prevent " +
        "(a key the server takes on write and loses on read) is invisible to a fake. Install it, " +
        "or waive deliberately with H_SKIP_NATS_TESTS=1.",
    );
  }
};

const describeKv = WAIVED ? describe.skip : describe;

let server: ChildProcess;
let storeDir: string;
let url: string;

const PORT = 42_222;

beforeAll(async () => {
  if (WAIVED) return;
  requireNatsServer();
  storeDir = mkdtempSync(join(tmpdir(), "h-kv-test-"));
  url = `nats://127.0.0.1:${PORT}`;
  server = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", storeDir, "-a", "127.0.0.1"], {
    stdio: "ignore",
  });
  // Poll rather than sleep a fixed amount: JetStream readiness is what matters, not elapsed time.
  const { connect } = await import("nats");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const probe = await connect({ servers: url, timeout: 500, maxReconnectAttempts: 1 });
      await probe.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("nats-server did not become ready");
}, 20_000);

afterAll(async () => {
  server?.kill("SIGKILL");
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, unknown, WfStore | WorkflowStore | ExecPolicyStore>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(NatsWfStoreLive, NatsWorkflowStoreLive, NatsExecPolicyStoreLive).pipe(
            Layer.provideMerge(NatsKvLive(url)),
          ),
        ),
      ),
    ) as Effect.Effect<A, unknown, never>,
  );

describeKv("NatsWfStoreLive", () => {
  it("round-trips a row whose repo carries a slash — the shape that broke the Dapr sibling", async () => {
    const identity = { repo: "acme/api", slug: "dark-mode", workflow: "implement-pr" };
    const row = {
      ...identity,
      status: "running" as const,
      instanceId: "dark-mode",
      updatedAt: "2026-08-16T00:00:00.000Z",
    };

    const found = await run(
      Effect.gen(function* () {
        const wf = yield* WfStore;
        yield* wf.saveRow(row);
        return yield* wf.getRow(identity);
      }),
    );

    // The whole point: a slashed repo saved AND read back. The Dapr version of this bug saved
    // fine and returned nothing, so asserting the read is what makes the test meaningful.
    expect(Option.isSome(found)).toBe(true);
    expect(Option.getOrThrow(found)).toMatchObject(identity);
  });

  it("reads a missing row as none rather than failing", async () => {
    const found = await run(
      Effect.gen(function* () {
        const wf = yield* WfStore;
        return yield* wf.getRow({ repo: "o/r", slug: "never-written", workflow: "implement-pr" });
      }),
    );
    expect(Option.isNone(found)).toBe(true);
  });
});

describeKv("NatsWorkflowStoreLive", () => {
  it("saves, gets and ENUMERATES without an index key", async () => {
    const definition = { steps: [{ activity: "run-claude" }] };

    const keys = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore;
        yield* store.save("answer", definition);
        yield* store.save("implement-pr", definition);
        return yield* store.list();
      }),
    );

    // `__workflow_index__` has no counterpart here: the bucket IS the index, so a save cannot
    // leave the two out of step.
    expect([...keys].sort()).toEqual(expect.arrayContaining(["answer", "implement-pr"]));
  });

  it("lists only scheduled workflows, and stamps lastRunAt forward", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore;
        yield* store.save("plain", { steps: [{ activity: "run-claude" }] });
        yield* store.save("nightly", {
          steps: [{ activity: "run-claude" }],
          schedule: { cron: "0 3 * * *", savedAt: "2026-08-16T00:00:00.000Z" },
        });
        const before = yield* store.listScheduled();
        yield* store.markRun("nightly", "2026-08-16T03:00:00.000Z");
        const after = yield* store.get("nightly");
        return { before, after };
      }),
    );

    expect(result.before.map((entry) => entry.key)).toEqual(["nightly"]);
    expect(Option.getOrThrow(result.after).schedule?.lastRunAt).toBe("2026-08-16T03:00:00.000Z");
  });

  it("treats markRun on an unknown key as a no-op, not a failure", async () => {
    // The only caller is the tick that just read this workflow from the same store, so a vanished
    // key means a concurrent delete — nothing worth failing a whole tick over.
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* WorkflowStore;
          yield* store.markRun("gone", "2026-08-16T03:00:00.000Z");
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describeKv("NatsExecPolicyStoreLive", () => {
  it("round-trips the single exec:config row", async () => {
    const policy = {
      denied: [
        { name: "claude", reason: "usage-limited" as const, deniedAt: "2026-08-16T00:00:00.000Z" },
      ],
      updatedAt: "2026-08-16T00:00:00.000Z",
    };

    const found = await run(
      Effect.gen(function* () {
        const store = yield* ExecPolicyStore;
        yield* store.save(policy);
        return yield* store.get();
      }),
    );

    expect(Option.getOrThrow(found).denied?.[0]).toMatchObject({ name: "claude" });
  });
});

describeKv("the executor fence, end to end", () => {
  /**
   * The JOIN the unit tests cannot show: `h agents deny` writes through ExecPolicyStore, and the
   * executor reads through `assertExecutorAllowed`. Both halves are tested in isolation against
   * stubs; this asserts they meet on the SAME key in a real bucket. A key-encoding mistake would
   * pass both unit suites and fence nothing here.
   */
  it("denies the executor the policy names, and only that one", async () => {
    const now = "2026-08-16T12:00:00.000Z";

    const outcome = await run(
      Effect.gen(function* () {
        const store = yield* ExecPolicyStore;
        yield* store.save({
          denied: [{ name: "codex", reason: "operator" as const, deniedAt: now }],
          updatedAt: now,
        });
        const codex = yield* assertExecutorAllowed("codex", now).pipe(
          Effect.map(() => "allowed"),
          Effect.catchAll((error: Error) => Effect.succeed(`denied: ${error.message}`)),
        );
        const claude = yield* assertExecutorAllowed("claude", now).pipe(
          Effect.map(() => "allowed"),
          Effect.catchAll((error: Error) => Effect.succeed(`denied: ${error.message}`)),
        );
        return { codex, claude };
      }),
    );

    expect(outcome.codex).toMatch(/^denied: /);
    expect(outcome.codex).toContain("codex");
    expect(outcome.claude).toBe("allowed");
  });
});
