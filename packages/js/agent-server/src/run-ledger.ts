import { join } from "path";

import { FileSystem } from "@effect/platform";
import { Context, Data, Effect, Layer, Runtime } from "effect";

/**
 * The run ledger captures "what an agent did" for every run as durable, inspectable artifacts:
 * a {AGENT_RUNS_DIR}/<group>/<agentId>-<ts>/ directory holding summary.json, output.txt and (for agents
 * that stream events) events.jsonl. It also mirrors a compact record into the Dapr statestore under
 * `run:<runId>` plus a `runs:index` list, so runs are queryable through the existing dapr-mcp.
 *
 * Everything here is best-effort: observability must never break a run. In the Effect surface the
 * service methods are honestly typed (`Effect<_, RunLedgerError>`) and the best-effort policy lives
 * at the call sites — `startRunLedgerEffect` / `recordActivityEffect` apply an independent
 * `Effect.ignore` per sub-effect (run-dir mkdir, per-event append, summary+output write, statestore
 * mirror), so a failure in one never skips the others and the on-disk files stay the source of truth.
 */

/** A run's observed event vocabulary — see `observeShape`. */
export type ObservedEventShape = {
  total: number;
  byType: Record<string, number>;
  byKeys: Record<string, number>;
};

export type RunLedgerContext = {
  agentId: string;
  /** Shared runs root (AGENT_RUNS_DIR), visible to every agent and the host. */
  runsDir: string;
  workflowInstanceId?: string;
  workspaceId?: string;
  /** The agent's working directory for this run. */
  workspacePath: string;
  input: string;
  /** Dapr sidecar HTTP port; when set, a compact record is mirrored to the statestore. */
  daprHttpPort?: string;
  /**
   * This agent's tool-call tally (`toolCallTallyFor(agentType)` from agent-cli — injected by
   * the runner, which owns the agent-cli dependency this package deliberately avoids).
   *
   * OMIT IT when the agent's stream shape has not actually been verified: the summary then
   * records `toolCalls: null` (unknown) instead of 0. A 0 reads as a measured zero and has
   * already caused a false "hollow panelist" reading of a busy openhands run (2026-07-27).
   */
  tallyToolCalls?: (current: number, event: Record<string, unknown>) => number;
};

export type RunOutcome = {
  status: "completed" | "failed";
  output: string;
  sessionId?: string | null;
  model?: string | null;
  turns?: number | null;
  tokens?: { input: number; output: number } | null;
  costUsd?: number | null;
  /**
   * True when tokens/model were folded from a PARTIAL event stream (run ended without a terminal
   * result — timeout/kill), so the tally is cumulative-up-to-the-stop, not a final accounting
   * (docs/plans/cost-containment.md B1). Never a substitute for costUsd — a partial run with no
   * cost still reads as a cost gap.
   */
  costPartial?: boolean | null;
  error?: string | null;
  /**
   * Why the run stopped (agent-cli's classify-stop; e.g. "usage-limited"). Orthogonal to `status` —
   * a usage-limited run can be `completed` at the Dapr level yet carry stopReason "usage-limited",
   * which the watcher's fallback reads off the `run:<id>` mirror. Loosely typed (string) to avoid an
   * agent-server → agent-cli dependency; the union lives in agent-cli.
   */
  stopReason?: string | null;
};

export type RunSummary = {
  runId: string;
  agentId: string;
  workflowInstanceId: string | null;
  workspaceId: string | null;
  workspacePath: string;
  status: "completed" | "failed";
  model: string | null;
  turns: number | null;
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
  /** True when tokens were folded from a partial stream (timeout/kill) — see RunOutcome. */
  costPartial: boolean | null;
  /** null = this agent's stream shape is not one we can count; NOT a measured zero. */
  toolCalls: number | null;
  /** What this agent's event stream actually looked like — evidence, not assumption. */
  eventShape: ObservedEventShape;
  sessionId: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputPreview: string;
  error: string | null;
  /** Why the run stopped (classify-stop); mirrored to `run:<id>` for the watcher's fallback read. */
  stopReason: string | null;
};

/** Identity an activity route needs to write an activity record into the run ledger. */
export type ActivityLedgerConfig = {
  /** Shared runs root (AGENT_RUNS_DIR). */
  runsDir: string;
  agentId: string;
  /** Dapr sidecar HTTP port; when set, the record is mirrored to the statestore. */
  daprHttpPort?: string;
};

export type ActivityRecord = {
  /** The activity name, e.g. "setup", "clone", "worktree". */
  activity: string;
  workflowInstanceId?: string;
  workspaceId?: string;
  status: "completed" | "skipped" | "failed";
  /** Epoch ms the activity started, captured before the work. */
  startedAtMs: number;
  /** Short human detail, e.g. the command that failed. */
  detail?: string;
  error?: string | null;
};

/** The summary.json shape for a non-agent activity (setup/clone/worktree) record. */
export type ActivitySummary = {
  runId: string;
  kind: "activity";
  activity: string;
  agentId: string;
  workflowInstanceId: string | null;
  workspaceId: string | null;
  status: "completed" | "skipped" | "failed";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  detail: string | null;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Shared pure helpers
// ---------------------------------------------------------------------------

/**
 * Fold one event into the run's observed event SHAPE — agent-agnostic, recording what arrived
 * without interpreting it. Every agent gets this, including ones whose vocabulary nothing here
 * understands, so a real per-agent parser can be written from captured evidence.
 *
 * The richer typed version lives in agent-cli (`observeEvent`); this is the loosely-typed
 * fallback so the ledger keeps its deliberate no-agent-cli-dependency.
 */
function observeShape(shape: ObservedEventShape, event: Record<string, unknown>): void {
  shape.total += 1;
  const type = (event as { type?: unknown }).type;
  const typeKey = typeof type === "string" ? type : "(absent)";
  const keysKey = Object.keys(event).toSorted().join(",") || "(empty)";
  for (const [hist, key] of [
    [shape.byType, typeKey],
    [shape.byKeys, keysKey],
  ] as const) {
    if (hist[key] === undefined && Object.keys(hist).length >= 24) {
      hist["(other)"] = (hist["(other)"] ?? 0) + 1;
      continue;
    }
    hist[key] = (hist[key] ?? 0) + 1;
  }
}

function buildRunSummary(
  ctx: RunLedgerContext,
  runId: string,
  startedAt: string,
  startedAtMs: number,
  toolCalls: number | null,
  eventShape: ObservedEventShape,
  outcome: RunOutcome,
): RunSummary {
  const endedAt = new Date().toISOString();
  return {
    runId,
    agentId: ctx.agentId,
    workflowInstanceId: ctx.workflowInstanceId ?? null,
    workspaceId: ctx.workspaceId ?? null,
    workspacePath: ctx.workspacePath,
    status: outcome.status,
    model: outcome.model ?? null,
    turns: outcome.turns ?? null,
    tokens: outcome.tokens ?? null,
    costUsd: outcome.costUsd ?? null,
    costPartial: outcome.costPartial ?? null,
    toolCalls,
    eventShape,
    sessionId: outcome.sessionId ?? null,
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - startedAtMs,
    inputPreview: ctx.input.slice(0, 280),
    error: outcome.error ?? null,
    stopReason: outcome.stopReason ?? null,
  };
}

function buildActivitySummary(
  cfg: ActivityLedgerConfig,
  rec: ActivityRecord,
): { dir: string; runId: string; summary: ActivitySummary } {
  const group = rec.workflowInstanceId ?? rec.workspaceId ?? "adhoc";
  const ts = rec.startedAtMs;
  const dir = join(cfg.runsDir, group, `${rec.activity}-${ts}`);
  const runId = `${group}:${rec.activity}:${ts}`;
  const endedAt = new Date().toISOString();
  return {
    dir,
    runId,
    summary: {
      runId,
      kind: "activity",
      activity: rec.activity,
      agentId: cfg.agentId,
      workflowInstanceId: rec.workflowInstanceId ?? null,
      workspaceId: rec.workspaceId ?? null,
      status: rec.status,
      startedAt: new Date(ts).toISOString(),
      endedAt,
      durationMs: Date.parse(endedAt) - ts,
      detail: rec.detail ?? null,
      error: rec.error ?? null,
    },
  };
}

// Mirrors a compact run record into the Dapr statestore (`run:<runId>` + `runs:index`).
// Throws/rejects on failure; the callers own the best-effort policy.
async function mirrorRunRecord(
  daprHttpPort: string,
  runId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const base = `http://localhost:${daprHttpPort}/v1.0/state/statestore`;
  const key = `run:${runId}`;
  await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ key, value: record }]),
  });
  const res = await fetch(`${base}/runs:index`);
  const raw = res.ok ? await res.json() : [];
  const index = Array.isArray(raw) ? (raw as string[]) : [];
  if (!index.includes(key)) {
    await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ key: "runs:index", value: [...index, key] }]),
    });
  }
}

// ---------------------------------------------------------------------------
// Effect port + adapter (the RunLedger hexagon unit — see plans/effect-refactor-map.md §3)
// ---------------------------------------------------------------------------

/** A single run-ledger write failed. `op` names which of the best-effort sub-effects it was. */
export class RunLedgerError extends Data.TaggedError("RunLedgerError")<{
  readonly cause: unknown;
  readonly op:
    | "create-run-dir"
    | "append-event"
    | "write-run-files"
    | "write-activity-summary"
    | "statestore-mirror";
}> {}

/**
 * The run-ledger port: the honest write primitives, one per best-effort site. Callers
 * (`startRunLedgerEffect`, `recordActivityEffect`) apply `Effect.ignore` per call so the
 * failure paths stay independently typed and unit-testable while runs never break.
 */
export class RunLedger extends Context.Tag("RunLedger")<
  RunLedger,
  {
    /** Creates the per-run ledger directory (recursive). */
    readonly createRunDir: (dir: string) => Effect.Effect<void, RunLedgerError>;
    /** Appends one event line to events.jsonl. */
    readonly appendEvent: (
      eventsPath: string,
      event: Record<string, unknown>,
    ) => Effect.Effect<void, RunLedgerError>;
    /** Writes summary.json + output.txt for an agent run. */
    readonly writeRunFiles: (
      dir: string,
      summary: RunSummary,
      output: string,
    ) => Effect.Effect<void, RunLedgerError>;
    /** Creates the activity dir and writes its summary.json. */
    readonly writeActivitySummary: (
      dir: string,
      summary: ActivitySummary,
    ) => Effect.Effect<void, RunLedgerError>;
    /** Mirrors a compact record to the Dapr statestore; no-op without a daprHttpPort. */
    readonly mirrorToStatestore: (
      daprHttpPort: string | undefined,
      runId: string,
      record: Record<string, unknown>,
    ) => Effect.Effect<void, RunLedgerError>;
  }
>() {}

/**
 * Adapter: filesystem writes via the `FileSystem` service (captured at layer build so the
 * port methods stay `R = never`), statestore mirror over the sidecar HTTP API.
 */
export const RunLedgerLive: Layer.Layer<RunLedger, never, FileSystem.FileSystem> = Layer.effect(
  RunLedger,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const asLedgerError =
      (op: RunLedgerError["op"]) =>
      (cause: unknown): RunLedgerError =>
        new RunLedgerError({ cause, op });
    return {
      createRunDir: (dir: string) =>
        fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError(asLedgerError("create-run-dir"))),
      appendEvent: (eventsPath: string, event: Record<string, unknown>) =>
        fs
          .writeFileString(eventsPath, `${JSON.stringify(event)}\n`, { flag: "a" })
          .pipe(Effect.mapError(asLedgerError("append-event"))),
      writeRunFiles: (dir: string, summary: RunSummary, output: string) =>
        Effect.all([
          fs.writeFileString(join(dir, "summary.json"), JSON.stringify(summary, null, 2)),
          fs.writeFileString(join(dir, "output.txt"), output),
        ]).pipe(Effect.asVoid, Effect.mapError(asLedgerError("write-run-files"))),
      writeActivitySummary: (dir: string, summary: ActivitySummary) =>
        fs
          .makeDirectory(dir, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(join(dir, "summary.json"), JSON.stringify(summary, null, 2)),
            ),
            Effect.mapError(asLedgerError("write-activity-summary")),
          ),
      mirrorToStatestore: (
        daprHttpPort: string | undefined,
        runId: string,
        record: Record<string, unknown>,
      ) =>
        daprHttpPort
          ? Effect.tryPromise({
              try: () => mirrorRunRecord(daprHttpPort, runId, record),
              catch: (cause) => new RunLedgerError({ cause, op: "statestore-mirror" }),
            })
          : Effect.void,
    };
  }),
);

/** Live handle for one agent run's ledger, produced by {@link startRunLedgerEffect}. */
export type RunLedgerHandle = {
  dir: string;
  runId: string;
  /** Pass to the agent invoker's onEvent: appends each event to events.jsonl and tallies tool calls. */
  onEvent: (event: Record<string, unknown>) => void;
  /** Writes summary.json + output.txt and mirrors the record to the statestore. Returns the summary. */
  finish: (outcome: RunOutcome) => Effect.Effect<RunSummary>;
};

/**
 * Effect sibling of {@link startRunLedger}. The best-effort policy lives here, at the call
 * sites: the run-dir mkdir, each events.jsonl append, the summary+output write, and the
 * statestore mirror are each an independently `Effect.ignore`d sub-effect, so a failure in
 * one never skips the others.
 *
 * Events arrive on the invoker's SYNC `onEvent` callback, so each append runs fire-and-forget
 * on the ambient runtime — chained behind the previous append (a bare `runFork` per event
 * could interleave lines, losing today's sync-append ordering). Every link is ignored, so the
 * chain never rejects and a failed append never blocks the next; `finish` awaits the chain so
 * events.jsonl is complete before the summary lands, as it is today.
 */
export const startRunLedgerEffect = (
  ctx: RunLedgerContext,
): Effect.Effect<RunLedgerHandle, never, RunLedger> =>
  Effect.gen(function* () {
    const ledger = yield* RunLedger;
    const runtime = yield* Effect.runtime<never>();
    const group = ctx.workflowInstanceId ?? ctx.workspaceId ?? "adhoc";
    const ts = Date.now();
    const dir = join(ctx.runsDir, group, `${ctx.agentId}-${ts}`);
    const runId = `${group}:${ctx.agentId}:${ts}`;
    const startedAt = new Date(ts).toISOString();
    const eventsPath = join(dir, "events.jsonl");
    // null until this agent's own tally counts something — an un-injected (unverified) agent
    // therefore reports `null` (unknown), never a 0 that would read as a measured zero.
    const tally = ctx.tallyToolCalls;
    let toolCalls: number | null = tally ? 0 : null;
    const eventShape: ObservedEventShape = { total: 0, byType: {}, byKeys: {} };

    yield* ledger.createRunDir(dir).pipe(Effect.ignore);

    let pendingAppends: Promise<void> = Promise.resolve();
    const onEvent = (event: Record<string, unknown>): void => {
      observeShape(eventShape, event);
      if (tally) toolCalls = tally(toolCalls ?? 0, event);
      pendingAppends = pendingAppends.then(() =>
        Runtime.runPromise(runtime)(ledger.appendEvent(eventsPath, event).pipe(Effect.ignore)),
      );
    };

    const finish = (outcome: RunOutcome): Effect.Effect<RunSummary> =>
      Effect.gen(function* () {
        yield* Effect.promise(() => pendingAppends);
        const summary = buildRunSummary(ctx, runId, startedAt, ts, toolCalls, eventShape, outcome);
        yield* ledger.writeRunFiles(dir, summary, outcome.output ?? "").pipe(Effect.ignore);
        yield* ledger
          .mirrorToStatestore(ctx.daprHttpPort, runId, {
            ...summary,
            dir,
            outputPreview: (outcome.output ?? "").slice(0, 280),
          })
          .pipe(Effect.ignore);
        return summary;
      });

    return { dir, runId, onEvent, finish };
  });

/**
 * Effect sibling of {@link recordActivity}: records the outcome of a non-agent activity
 * (setup/clone/worktree) under the same `<instanceId>/` group as agent runs. The fs write
 * and the statestore mirror are independently `Effect.ignore`d, mirroring the legacy
 * function's two swallow sites.
 */
export const recordActivityEffect = (
  cfg: ActivityLedgerConfig,
  rec: ActivityRecord,
): Effect.Effect<void, never, RunLedger> =>
  Effect.gen(function* () {
    const ledger = yield* RunLedger;
    const { dir, runId, summary } = buildActivitySummary(cfg, rec);
    yield* ledger.writeActivitySummary(dir, summary).pipe(Effect.ignore);
    yield* ledger
      .mirrorToStatestore(cfg.daprHttpPort, runId, { ...summary, dir })
      .pipe(Effect.ignore);
  });
