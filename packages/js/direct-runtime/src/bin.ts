#!/usr/bin/env node
/**
 * Composition root of the direct execution substrate: a one-shot binary that reads a job on
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
import { runDelegate } from "./domain/delegate.ts";
import { runWorkflow } from "./domain/execute.ts";
import { DirectJob } from "./domain/models.ts";
import { AgentCliAgentLive } from "./infrastructure/agent-cli-agent.ts";
import { GitWorkspaceLive } from "./infrastructure/git-workspace.ts";
import { StderrProgressLive } from "./infrastructure/stderr-progress.ts";

// NodeContext supplies FileSystem + CommandExecutor (spawning the agent CLIs, git and setup
// commands); FetchHttpClient satisfies agent-cli's HttpClient requirement.
const platform = Layer.merge(NodeContext.layer, FetchHttpClient.layer);
const ledger = RunLedgerLive.pipe(Layer.provide(NodeContext.layer));
const git = ExecGitClient.pipe(Layer.provide(NodeContext.layer));

const AppLive = Layer.mergeAll(
  AgentCliAgentLive.pipe(Layer.provide(Layer.merge(ledger, platform))),
  GitWorkspaceLive.pipe(Layer.provide(Layer.merge(git, NodeContext.layer))),
  StderrProgressLive,
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

  const runtime = ManagedRuntime.make(AppLive);
  const fiber = runtime.runFork(
    Effect.gen(function* () {
      const job = yield* Schema.decodeUnknown(DirectJob)(parsed);
      switch (job.kind) {
        case "delegate":
          return yield* runDelegate(job);
        case "workflow":
          return yield* runWorkflow(job);
        case "chain":
          return yield* runChain(job);
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
