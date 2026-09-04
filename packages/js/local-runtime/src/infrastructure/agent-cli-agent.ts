import type { CommandExecutor, FileSystem, HttpClient } from "@effect/platform";
import {
  AgentInvoker,
  ClaudeInvokerLive,
  CodexInvokerLive,
  foldQuota,
  OpenhandsInvokerLive,
  parseRateLimitEvent,
  PiInvokerLive,
  toolCallTallyFor,
} from "agent-cli";
import type { QuotaObservation, QuotaReport } from "agent-cli";
import {
  activeDenial,
  ExecPolicyStore,
  executorFromActivity,
  fenceUntilFrom,
  foldQuotaRow,
  mergeAutoDeny,
  QuotaStore,
} from "engine-core";
import { RunLedger, startRunLedgerEffect } from "run-ledger";
import { Cause, Effect, Layer, Option, Runtime } from "effect";

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

/**
 * The quota row's writer, local side. The CLI reports the account's windows as `rate_limit_event`s
 * DURING the run, and the row is written as they arrive rather than only at the end, because the
 * reader that matters most — the gate in front of the NEXT step, or a driver deciding whether to
 * fire at all — needs the state while a long run is still going. Each write folds the report so
 * far (so a killed run has already recorded what it spent) under the run's id, which the final
 * write upserts. Only a CHANGED observation is written; the CLI repeats the same state on every
 * turn.
 *
 * Best-effort, like the ledger: a fabric that cannot take the write is reported on stderr and the
 * run continues. The row is an observation, and a missing observation reads as "no headroom
 * known" — which is the same answer as before this existed.
 */
const quotaWriter = (executor: string, runId: string) =>
  Effect.gen(function* () {
    const store = yield* QuotaStore;
    const runtime = yield* Effect.runtime<never>();
    const permit = yield* Effect.makeSemaphore(1);
    const observations: QuotaObservation[] = [];
    let written: string | undefined;

    const write = (report: QuotaReport) =>
      permit.withPermits(1)(
        Effect.gen(function* () {
          const nowIso = new Date().toISOString();
          const prev = Option.getOrUndefined(yield* store.get(executor));
          yield* store.save(foldQuotaRow(prev, executor, report, runId, nowIso));
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.sync(() =>
              process.stderr.write(
                `quota: could not write quota:${executor} — ${String((cause as { cause?: unknown }).cause ?? cause)}\n`,
              ),
            ),
          ),
        ),
      );

    return {
      /** Called from the invoker's SYNC event callback: parse, dedupe, fork the write. */
      observe: (event: Record<string, unknown>): void => {
        const observation = parseRateLimitEvent(event);
        if (!observation) return;
        observations.push(observation);
        const report = foldQuota(observations);
        if (!report) return;
        const fingerprint = JSON.stringify([report.status, report.windows]);
        if (fingerprint === written) return;
        written = fingerprint;
        Runtime.runFork(runtime)(write(report));
      },
      /** The run is over: the report to keep is the invoker's own fold, written behind any live write still in flight. */
      finish: (report: QuotaReport | undefined) => (report ? write(report) : Effect.void),
      current: () => foldQuota(observations),
    };
  });

/**
 * A usage-limited run FENCES its executor, the same auto-deny the fleet's watcher applies — and
 * with the same improvement: when the run reported when its window resets, the fence lifts then,
 * not after the fixed default. Written here because on this substrate there is no watcher; the
 * adapter that saw the stop is the only party that can.
 */
const fenceUsageLimited = (executor: string, report: QuotaReport | undefined) =>
  Effect.gen(function* () {
    const store = yield* ExecPolicyStore;
    const nowIso = new Date().toISOString();
    const policy = Option.getOrUndefined(yield* store.get());
    const merged = mergeAutoDeny(policy, executor, nowIso, fenceUntilFrom(report, nowIso));
    if (merged === null) return;
    yield* store.save(merged);
    const until = activeDenial(merged, executor, nowIso)?.until ?? "?";
    process.stderr.write(`quota: ${executor} usage-limited — fenced until ${until}\n`);
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.sync(() =>
        process.stderr.write(
          `quota: could not fence ${executor} after a usage-limited run — ${String((cause as { cause?: unknown }).cause ?? cause)}\n`,
        ),
      ),
    ),
  );

const runOne = (
  request: AgentRunRequest,
): Effect.Effect<
  AgentRunReport,
  never,
  RunLedger | QuotaStore | ExecPolicyStore | CommandExecutor.CommandExecutor | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const startedAtMs = Date.now();
    // The executor shortname the registries key on — derived the way the service gate derives it.
    const executor = executorFromActivity(`run-${request.agent}`) ?? request.agent;
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
    const quota = yield* quotaWriter(executor, ledger.runId);

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
        onEvent: (event) => {
          ledger.onEvent(event);
          quota.observe(event);
        },
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
    const quotaReport = invoked.quota ?? quota.current();
    yield* quota.finish(quotaReport);
    if (invoked.stopReason === "usage-limited") yield* fenceUsageLimited(executor, quotaReport);
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
      quota: quotaReport ?? null,
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
      toolCalls: summary.toolCalls,
      runId: summary.runId,
      runDir: ledger.dir,
      quota: quotaReport,
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
  | RunLedger
  | QuotaStore
  | ExecPolicyStore
  | CommandExecutor.CommandExecutor
  | HttpClient.HttpClient
  | FileSystem.FileSystem
> = Layer.effect(
  AgentPort,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | RunLedger
      | QuotaStore
      | ExecPolicyStore
      | CommandExecutor.CommandExecutor
      | HttpClient.HttpClient
    >();
    return {
      run: (request: AgentRunRequest) => runOne(request).pipe(Effect.provide(context)),
    };
  }),
);
