import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  recordActivityEffect,
  RunLedger,
  RunLedgerError,
  RunLedgerLive,
  startRunLedgerEffect,
} from "./run-ledger.ts";

// The activity path against the real filesystem (RunLedgerLive), asserting the on-disk shape.
describe("recordActivityEffect (RunLedgerLive)", () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "run-ledger-test-"));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  const live = RunLedgerLive.pipe(Layer.provide(NodeFileSystem.layer));
  const record = (
    cfg: Parameters<typeof recordActivityEffect>[0],
    rec: Parameters<typeof recordActivityEffect>[1],
  ) => Effect.runPromise(recordActivityEffect(cfg, rec).pipe(Effect.provide(live)));

  // daprHttpPort omitted, so the statestore mirror short-circuits and the test does no network I/O.
  // Built per-call (not once) because runsDir is assigned in beforeEach.
  const cfg = () => ({ runsDir, agentId: "claude-agent" });

  it("writes a failed activity summary under the instance group with the error", async () => {
    await record(cfg(), {
      activity: "setup",
      workflowInstanceId: "triage-ABC-1",
      status: "failed",
      startedAtMs: 1_000,
      detail: "tessl install",
      error: "Command failed: tessl install … provenance_drift",
    });

    const groupDir = join(runsDir, "triage-ABC-1");
    const entries = readdirSync(groupDir);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("no activity record was written");
    expect(entry).toMatch(/^setup-/);

    const summary = JSON.parse(readFileSync(join(groupDir, entry, "summary.json"), "utf8"));
    expect(summary.kind).toBe("activity");
    expect(summary.activity).toBe("setup");
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("provenance_drift");
    expect(summary.workflowInstanceId).toBe("triage-ABC-1");
  });

  it("groups the record under the instance id, alongside agent runs", async () => {
    await record(cfg(), {
      activity: "worktree",
      workflowInstanceId: "inst-42",
      status: "completed",
      startedAtMs: 2_000,
    });
    expect(existsSync(join(runsDir, "inst-42"))).toBe(true);
  });

  it("falls back to the workspaceId, then 'adhoc', for the group", async () => {
    await record(cfg(), {
      activity: "clone",
      workspaceId: "ws-7",
      status: "completed",
      startedAtMs: 3_000,
    });
    await record(cfg(), { activity: "clone", status: "completed", startedAtMs: 4_000 });
    expect(existsSync(join(runsDir, "ws-7"))).toBe(true);
    expect(existsSync(join(runsDir, "adhoc"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Effect surface — failure-independence of the best-effort sub-effects
// ---------------------------------------------------------------------------

type LedgerImpl = Context.Tag.Service<RunLedger>;

/**
 * Stub RunLedger whose ops record their invocation and optionally fail, so the tests can
 * assert that a failing sub-effect never skips the others (each is independently ignored).
 */
function makeStubLedger(failing: ReadonlyArray<keyof LedgerImpl> = []) {
  const calls: Array<keyof LedgerImpl> = [];
  const op = (name: keyof LedgerImpl): Effect.Effect<void, RunLedgerError> =>
    Effect.suspend(() => {
      calls.push(name);
      return failing.includes(name)
        ? Effect.fail(new RunLedgerError({ cause: `${name} stub failure`, op: "write-run-files" }))
        : Effect.void;
    });
  const impl: LedgerImpl = {
    createRunDir: () => op("createRunDir"),
    appendEvent: () => op("appendEvent"),
    writeRunFiles: () => op("writeRunFiles"),
    writeActivitySummary: () => op("writeActivitySummary"),
    mirrorToStatestore: () => op("mirrorToStatestore"),
  };
  return { calls, layer: Layer.succeed(RunLedger, impl) };
}

const runCtx = {
  agentId: "claude-agent",
  runsDir: "/unused",
  workflowInstanceId: "inst-1",
  workspacePath: "/w",
  input: "do the thing",
};

describe("startRunLedgerEffect", () => {
  it("still mirrors to the statestore and returns the summary when the fs write fails", async () => {
    const { calls, layer } = makeStubLedger(["createRunDir", "writeRunFiles"]);
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* startRunLedgerEffect(runCtx);
        return yield* handle.finish({ status: "completed", output: "done" });
      }).pipe(Effect.provide(layer)),
    );
    expect(calls).toEqual(["createRunDir", "writeRunFiles", "mirrorToStatestore"]);
    expect(summary.status).toBe("completed");
    expect(summary.runId).toMatch(/^inst-1:claude-agent:/);
  });

  it("keeps appending events (and finishing) after an event append fails", async () => {
    const { calls, layer } = makeStubLedger(["appendEvent"]);
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* startRunLedgerEffect(runCtx);
        handle.onEvent({ type: "tool_use" });
        handle.onEvent({ type: "tool_use" });
        handle.onEvent({ stats: { tool_calls: 5 } });
        return yield* handle.finish({ status: "completed", output: "" });
      }).pipe(Effect.provide(layer)),
    );
    expect(calls.filter((c) => c === "appendEvent")).toHaveLength(3);
    expect(calls).toContain("writeRunFiles");
    expect(calls).toContain("mirrorToStatestore");
    // the tool-call tally is sync and unaffected by append failures
    expect(summary.toolCalls).toBe(5);
  });

  it("counts tool_use blocks nested in claude-CLI assistant events", async () => {
    const { layer } = makeStubLedger();
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* startRunLedgerEffect(runCtx);
        // The claude CLI stream shape: tool calls arrive inside assistant message content.
        handle.onEvent({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "calling the workflow tool" },
              { type: "tool_use", name: "mcp__workflows__run_workflow" },
              { type: "tool_use", name: "mcp__workflows__await_workflow" },
            ],
          },
        });
        handle.onEvent({ type: "user", message: { content: [{ type: "tool_result" }] } });
        handle.onEvent({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        });
        return yield* handle.finish({ status: "completed", output: "" });
      }).pipe(Effect.provide(layer)),
    );
    expect(summary.toolCalls).toBe(3);
  });
});

describe("recordActivityEffect", () => {
  it("still mirrors to the statestore when the activity-summary write fails", async () => {
    const { calls, layer } = makeStubLedger(["writeActivitySummary"]);
    await Effect.runPromise(
      recordActivityEffect(
        { runsDir: "/unused", agentId: "claude-agent" },
        { activity: "setup", workflowInstanceId: "inst-2", status: "failed", startedAtMs: 1_000 },
      ).pipe(Effect.provide(layer)),
    );
    expect(calls).toEqual(["writeActivitySummary", "mirrorToStatestore"]);
  });
});

describe("RunLedgerLive", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "run-ledger-live-test-"));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  // daprHttpPort omitted, so the statestore mirror short-circuits and the test does no network I/O.
  it("writes the run dir, events.jsonl, summary.json and output.txt", async () => {
    const live = RunLedgerLive.pipe(Layer.provide(NodeFileSystem.layer));
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* startRunLedgerEffect({ ...runCtx, runsDir });
        handle.onEvent({ type: "tool_use", name: "Bash" });
        handle.onEvent({ type: "text" });
        return yield* handle.finish({ status: "completed", output: "all done" });
      }).pipe(Effect.provide(live)),
    );

    const groupDir = join(runsDir, "inst-1");
    const entries = readdirSync(groupDir);
    expect(entries).toHaveLength(1);
    const runDir = join(groupDir, entries[0] as string);
    const written = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
    expect(written.runId).toBe(summary.runId);
    expect(written.toolCalls).toBe(1);
    expect(readFileSync(join(runDir, "output.txt"), "utf8")).toBe("all done");
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0] as string)).toEqual({ type: "tool_use", name: "Bash" });
  });
});
