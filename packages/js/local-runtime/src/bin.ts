#!/usr/bin/env node
/**
 * Composition root of the local execution substrate: a one-shot binary that reads a job on
 * stdin, runs it, and writes the result envelope to stdout.
 *
 * The boundary is deliberately the SAME artifact the service substrate would have been sent —
 * JSON, composed by the `h` CLI — so the two paths stay auditably symmetric and the CLI keeps one
 * composition stack. Human progress goes to stderr; stdout carries only the envelope.
 */
import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { RunLedgerLive } from "run-ledger";
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { ExecGitClient } from "git-core";

import { runChain } from "./domain/chain.ts";
import { runRegistry } from "./domain/registry.ts";
import { runDelegate } from "./domain/delegate.ts";
import { runWorkflow } from "./domain/execute.ts";
import { LOCAL_PROTOCOL_VERSION, LocalJob } from "./domain/models.ts";
import { AgentCliAgentLive } from "./infrastructure/agent-cli-agent.ts";
import { GitWorkspaceLive } from "./infrastructure/git-workspace.ts";
import { NatsJournalLive } from "./infrastructure/nats-journal.ts";
import { NatsKvLive } from "./infrastructure/nats-kv.ts";
import {
  NatsExecPolicyStoreLive,
  NatsWfStoreLive,
  NatsWorkflowStoreLive,
} from "./infrastructure/nats-registry-stores.ts";
import { StderrProgressLive } from "./infrastructure/stderr-progress.ts";

// NodeContext supplies FileSystem + CommandExecutor (spawning the agent CLIs, git and setup
// commands); FetchHttpClient satisfies agent-cli's HttpClient requirement.
const platform = Layer.merge(NodeContext.layer, FetchHttpClient.layer);
const ledger = RunLedgerLive.pipe(Layer.provide(NodeContext.layer));
const git = ExecGitClient.pipe(Layer.provide(NodeContext.layer));

/**
 * Where the local fabric answers. An ENV value, not job data: it is one configured endpoint for the
 * whole machine (the CLI's `EVENTS_URL`, stamped into the child env by local_runtime.py), so
 * carrying it per job would put an environment fact in the wire protocol and require a version
 * bump to change it. The literal fallback mirrors `cli/h/src/h_cli/config.py`'s default and is
 * held to it by `cli/h/tests/test_local_fabric_url_sync.py`.
 */
const FABRIC_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";

const AppLive = Layer.mergeAll(
  AgentCliAgentLive.pipe(Layer.provide(Layer.merge(ledger, platform))),
  GitWorkspaceLive.pipe(Layer.provide(Layer.merge(git, NodeContext.layer))),
  StderrProgressLive,
  // Connects nothing until a journaled chain actually appends/replays — an unjournaled run
  // never touches the fabric.
  NatsJournalLive,
  // The executor-policy registry. Connects on FIRST READ, so a job that reads no registry never
  // opens a socket — see NatsKvLive.
  Layer.mergeAll(NatsExecPolicyStoreLive, NatsWorkflowStoreLive, NatsWfStoreLive).pipe(
    Layer.provide(NatsKvLive(FABRIC_URL)),
  ),
);

const readStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });

/**
 * A vanished reader is a normal way for this process to end, not a crash.
 *
 * When the CLI that spawned us dies — Ctrl-C, a killed job, a closed pipe — writing the envelope
 * raises EPIPE on the stdio socket, and an unhandled 'error' event takes the process down with a
 * Node stack trace stamped over the run's own output. Observed live 2026-08-06 when a long chain
 * was stopped mid-review: the actual outcome was fine and the terminal showed a crash. There is by
 * definition nobody left to report to, so swallow EPIPE and let the exit code carry the news.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

/** Every exit path answers in JSON, so the caller never has to guess from an exit code alone. */
const emit = (envelope: Record<string, unknown>, code: number): void => {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = code;
};

const main = async (): Promise<void> => {
  const raw = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    emit({ ok: false, error: `stdin was not valid JSON: ${String(cause)}` }, 2);
    return;
  }

  // The handshake runs BEFORE schema decode, because decode IGNORES unknown fields — the
  // precise mechanism that would make version skew silent instead of loud.
  const declared = (parsed as { protocolVersion?: unknown }).protocolVersion;
  if (typeof declared === "number" && declared !== LOCAL_PROTOCOL_VERSION) {
    emit(
      {
        ok: false,
        error:
          `protocol mismatch: the CLI speaks v${declared}, this runner v${LOCAL_PROTOCOL_VERSION}` +
          " — rebuild the checkout (`bun run build`) or reinstall h-cli so the pair matches",
      },
      2,
    );
    return;
  }

  const runtime = ManagedRuntime.make(AppLive);
  const fiber = runtime.runFork(
    Effect.gen(function* () {
      const job = yield* Schema.decodeUnknown(LocalJob)(parsed);
      switch (job.kind) {
        case "delegate":
          return yield* runDelegate(job);
        case "workflow":
          return yield* runWorkflow(job);
        case "chain":
          return yield* runChain(job);
        case "registry":
          return yield* runRegistry(job);
      }
    }),
  );

  // Ctrl-C must reach the agent CLIs, not just this process: interrupting the fiber closes the
  // run scopes, and agent-cli's reaper group-kills each CLI (and any grandchild it spawned). An
  // orphaned CLI keeps working and keeps billing with nothing recording it.
  const interrupt = (): void => {
    void Effect.runPromise(Fiber.interrupt(fiber));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const exit = await Effect.runPromise(Fiber.await(fiber));
  await runtime.dispose();

  if (Exit.isSuccess(exit)) {
    emit(exit.value as unknown as Record<string, unknown>, exit.value.ok ? 0 : 1);
    return;
  }
  if (Exit.isInterrupted(exit)) {
    emit({ ok: false, error: "interrupted" }, 130);
    return;
  }
  emit({ ok: false, error: String(Cause.squash(exit.cause)) }, 1);
};

void main();
