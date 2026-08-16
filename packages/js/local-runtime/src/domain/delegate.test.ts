import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { UnknownAgentError } from "./agents.ts";
import { branchNames, EmptyRosterError, failureDetail, runDelegate } from "./delegate.ts";
import type { AgentRunReport, AgentRunRequest, DelegateJob, WorktreeSpec } from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort } from "./ports.ts";

const job = (over: Partial<DelegateJob> = {}): DelegateJob => ({
  kind: "delegate",
  task: "why is the sky blue?",
  agents: ["claude"],
  cwd: "/work/repo",
  timeoutMs: 1000,
  runsDir: "/runs",
  group: "local-260806-101500",
  ...over,
});

type Recorder = {
  requests: AgentRunRequest[];
  worktrees: WorktreeSpec[];
  progress: string[];
};

/** Stub ports: the agent records what it was asked and answers per-agent, never failing. */
const stubs = (
  outcomes: Partial<Record<string, Partial<AgentRunReport>>> = {},
): { layer: Layer.Layer<AgentPort | WorkspacePort | ProgressPort>; recorder: Recorder } => {
  const recorder: Recorder = { requests: [], worktrees: [], progress: [] };
  const layer = Layer.mergeAll(
    Layer.succeed(AgentPort, {
      run: (request: AgentRunRequest) =>
        Effect.sync(() => {
          recorder.requests.push(request);
          return {
            agent: request.agent,
            status: "completed",
            cwd: request.cwd,
            output: `${request.agent} says hi`,
            durationMs: 5,
            ...outcomes[request.agent],
          } satisfies AgentRunReport;
        }),
    }),
    Layer.succeed(WorkspacePort, {
      prepare: (spec: WorktreeSpec) =>
        Effect.sync(() => {
          recorder.worktrees.push(spec);
          return spec.worktreePath;
        }),
      // `h delegate` never provisions — setup steps belong to a workflow definition, not the atom.
      // So the stub DIES rather than no-ops: a silent stub would let a future call through
      // unnoticed, which is the failure mode a test double exists to prevent.
      provision: () => Effect.die(new Error("delegate must not provision a workspace")),
    }),
    Layer.succeed(ProgressPort, {
      emit: (line: string) =>
        Effect.sync(() => {
          recorder.progress.push(line);
        }),
    }),
  );
  return { layer, recorder };
};

const run = (j: DelegateJob, layer: Layer.Layer<AgentPort | WorkspacePort | ProgressPort>) =>
  Effect.runPromiseExit(runDelegate(j).pipe(Effect.provide(layer)));

describe("branchNames", () => {
  it("uses the bare prefix for a single agent", () => {
    expect(branchNames("local/x", ["codex"])).toEqual(["local/x"]);
  });

  // A branch lives in at most one worktree, so a collision would hand two agents the SAME
  // directory and let them overwrite each other's work.
  it("gives every roster slot a distinct branch, including repeats of one agent", () => {
    expect(branchNames("local/x", ["codex", "pi", "codex"])).toEqual([
      "local/x-codex",
      "local/x-pi",
      "local/x-codex-2",
    ]);
  });
});

describe("failureDetail", () => {
  it("prefers the terminal result-event text over stderr (the CLI's own account of the stop)", () => {
    // The live h#112 case: a benign trust warning opened stderr while the real cause — the
    // session limit — arrived only in the result event.
    expect(
      failureDetail({
        resultEventText: "You've hit your session limit · resets 4:50pm (Africa/Johannesburg)",
        stderr: "Ignoring 19 permissions.allow entries from .claude/settings.json: not trusted",
        exitCode: 1,
      }),
    ).toBe("You've hit your session limit · resets 4:50pm (Africa/Johannesburg)");
  });

  it("falls back to stderr's TAIL, never its first line", () => {
    expect(
      failureDetail({
        stderr: "Ignoring permissions warning\n\nTypeError: boom\n  at main.ts:1\n",
        exitCode: 1,
      }),
    ).toBe("Ignoring permissions warning\nTypeError: boom\nat main.ts:1");
    const long = ["warning: a", "b", "c", "d", "real error: e"].join("\n");
    expect(failureDetail({ stderr: long, exitCode: 1 })).toBe("c\nd\nreal error: e");
  });

  it("falls back to the exit code when there is nothing else", () => {
    expect(failureDetail({ stderr: "  \n ", exitCode: 127 })).toBe("agent exited with code 127");
    expect(failureDetail({ exitCode: 1 })).toBe("agent exited with code 1");
  });
});

describe("runDelegate", () => {
  it("runs every roster slot and reports each one", async () => {
    const { layer, recorder } = stubs();
    const exit = await run(job({ agents: ["claude", "codex", "pi"] }), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.ok).toBe(true);
    expect(exit.value.runs.map((r) => r.agent)).toEqual(["claude", "codex", "pi"]);
    expect(recorder.requests.map((r) => r.cwd)).toEqual(["/work/repo", "/work/repo", "/work/repo"]);
  });

  // The whole point of a roster: one missing CLI must not cost the other answers.
  it("keeps a failed agent's siblings, and reports the job as not ok", async () => {
    const { layer } = stubs({ codex: { status: "failed", error: "codex: not found", output: "" } });
    const exit = await run(job({ agents: ["claude", "codex"] }), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.ok).toBe(false);
    expect(exit.value.runs).toHaveLength(2);
    expect(exit.value.runs.find((r) => r.agent === "claude")?.output).toBe("claude says hi");
  });

  it("threads model, timeout and permission mode into every request", async () => {
    const { layer, recorder } = stubs();
    await run(
      job({ agents: ["claude", "codex"], model: "m-1", timeoutMs: 42, permissionMode: "plan" }),
      layer,
    );

    for (const request of recorder.requests) {
      expect(request.model).toBe("m-1");
      expect(request.timeoutMs).toBe(42);
      expect(request.permissionMode).toBe("plan");
    }
  });

  it("gives each agent its own worktree when one is planned", async () => {
    const { layer, recorder } = stubs();
    const exit = await run(
      job({
        agents: ["codex", "pi"],
        worktree: {
          repoPath: "/work/repo",
          root: "/work/.h-worktrees",
          branchPrefix: "local/job",
          remoteBase: "main",
        },
      }),
      layer,
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(
      recorder.worktrees.map((w) => (w.checkout.kind === "branch" ? w.checkout.branch : undefined)),
    ).toEqual(["local/job-codex", "local/job-pi"]);
    expect(recorder.worktrees.map((w) => w.worktreePath)).toEqual([
      "/work/.h-worktrees/local-job-codex",
      "/work/.h-worktrees/local-job-pi",
    ]);
    expect(
      recorder.worktrees.every(
        (w) => w.checkout.kind === "branch" && w.checkout.remoteBase === "main",
      ),
    ).toBe(true);
    expect(recorder.requests.map((r) => r.cwd)).toEqual([
      "/work/.h-worktrees/local-job-codex",
      "/work/.h-worktrees/local-job-pi",
    ]);
  });

  it("refuses an unknown agent before running anything", async () => {
    const { layer, recorder } = stubs();
    const exit = await run(job({ agents: ["claude", "gpt"] }), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exit.cause.toString()).toContain(new UnknownAgentError("gpt").message);
    expect(recorder.requests).toHaveLength(0);
  });

  it("refuses an empty roster rather than succeeding with no runs", async () => {
    const { layer } = stubs();
    const exit = await run(job({ agents: [] }), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exit.cause.toString()).toContain(new EmptyRosterError().message);
  });
});
