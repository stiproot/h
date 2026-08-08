import type { CommandExecutor, FileSystem, HttpClient } from "@effect/platform";
import {
  AgentInvoker,
  ClaudeInvokerLive,
  CodexInvokerLive,
  OpenhandsInvokerLive,
  PiInvokerLive,
  toolCallTallyFor,
} from "agent-cli";
import { RunLedger, startRunLedgerEffect } from "run-ledger";
import { Cause, Effect, Layer } from "effect";

import { failureDetail } from "../domain/delegate.ts";
import type { AgentRunReport, AgentRunRequest, LocalAgentType } from "../domain/models.ts";
import { AgentPort } from "../domain/ports.ts";

/**
 * Agent name → the agent-cli invoker that drives its CLI. Exhaustive over `LocalAgentType`, so
 * widening the vocabulary is a compile error here rather than a runtime surprise.
 *
 * The service substrate reaches these same strategies through a `run-*` activity, a Dapr invoke
 * and an agent service's `/run` route; this substrate is the same call with the network removed.
 */
const INVOKERS: Record<
  LocalAgentType,
  Layer.Layer<AgentInvoker, never, CommandExecutor.CommandExecutor | HttpClient.HttpClient>
> = {
  claude: ClaudeInvokerLive,
  codex: CodexInvokerLive,
  openhands: OpenhandsInvokerLive,
  pi: PiInvokerLive,
};

const runOne = (
  request: AgentRunRequest,
): Effect.Effect<
  AgentRunReport,
  never,
  RunLedger | CommandExecutor.CommandExecutor | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const startedAtMs = Date.now();
    const ledger = yield* startRunLedgerEffect({
      // The canonical agent name, NOT the service's app id ("codex" vs "codex-agent"): a local
      // run and a service run of the same agent stay distinguishable in the ledger.
      agentId: request.agent,
      runsDir: request.runsDir,
      // Local execution has no Dapr instance to name, so the job's group keys the ledger through
      // workspaceId and `workflowInstanceId` stays null — honestly absent rather than invented.
      workspaceId: request.group,
      workspacePath: request.cwd,
      input: request.task,
      // No daprHttpPort: the `run:` statestore mirror needs a sidecar. The on-disk ledger is the
      // source of truth anyway, and it is what obs-mcp and `h runs` read.
      tallyToolCalls: toolCallTallyFor(request.agent),
    });

    const invoked = yield* Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      return yield* invoker.invoke({
        systemPrompt: request.systemPrompt ?? "",
        taskPrompt: request.task,
        cwd: request.cwd,
        env: {},
        timeout: request.timeoutMs,
        model: request.model,
        permissionMode: request.permissionMode,
        onEvent: ledger.onEvent,
        // No llmConfig ON PURPOSE. agent-cli merges the ambient process env into the child, so a
        // local run uses whatever the operator already authenticated — a logged-in claude CLI,
        // ~/.codex/auth.json, ANTHROPIC_API_KEY/OPENAI_API_KEY/LLM_API_KEY from the shell. Passing
        // one here would also switch on the LiteLLM preflight, which needs a proxy that is not
        // running on this substrate.
      });
    }).pipe(Effect.provide(INVOKERS[request.agent]));

    // A resolved result can still carry a non-zero exit: timeout → 124, spawn failure → 1, CLI not
    // installed → 127, or the agent's own error exit.
    const failed = invoked.exitCode !== undefined && invoked.exitCode !== 0;
    const output = invoked.stdout ?? "";
    const detail = failed ? failureDetail(invoked) : null;
    const summary = yield* ledger.finish({
      status: failed ? "failed" : "completed",
      output,
      error: detail,
      sessionId: invoked.sessionId ?? null,
      model: invoked.model ?? request.model ?? null,
      turns: invoked.numTurns ?? null,
      tokens: invoked.tokenUsage ?? null,
      costUsd: invoked.costUsd ?? null,
      costPartial: invoked.costPartial ?? null,
      stopReason: invoked.stopReason ?? null,
    });

    return {
      agent: request.agent,
      status: failed ? "failed" : "completed",
      cwd: request.cwd,
      output,
      durationMs: Date.now() - startedAtMs,
      error: detail ?? undefined,
      exitCode: invoked.exitCode,
      stopReason: invoked.stopReason,
      model: invoked.model ?? request.model,
      costUsd: invoked.costUsd,
      costPartial: invoked.costPartial,
      tokens: invoked.tokenUsage,
      turns: invoked.numTurns,
      sessionId: invoked.sessionId,
      runId: summary.runId,
      runDir: ledger.dir,
    } satisfies AgentRunReport;
  }).pipe(
    // The port promises a report, never a failure — including for defects, so one agent crashing
    // the adapter cannot take its siblings' answers down with it. The ledger entry for such a run
    // is written by the paths above when they are reached; this is the outer backstop.
    Effect.catchAllCause((cause) =>
      Effect.succeed({
        agent: request.agent,
        status: "failed",
        cwd: request.cwd,
        output: "",
        durationMs: 0,
        error: String(Cause.squash(cause)),
      } satisfies AgentRunReport),
    ),
  );

/**
 * The `AgentPort` adapter over agent-cli. `RunLedger` and the platform services are captured from
 * the layer's context so the port method stays `R = never`; the per-agent invoker layer is
 * provided inside `runOne`, since the strategy is only known per request.
 */
export const AgentCliAgentLive: Layer.Layer<
  AgentPort,
  never,
  RunLedger | CommandExecutor.CommandExecutor | HttpClient.HttpClient | FileSystem.FileSystem
> = Layer.effect(
  AgentPort,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      RunLedger | CommandExecutor.CommandExecutor | HttpClient.HttpClient
    >();
    return {
      run: (request: AgentRunRequest) => runOne(request).pipe(Effect.provide(context)),
    };
  }),
);
