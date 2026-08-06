import { Effect, Layer } from "effect";
import type { WorkflowStep } from "workflow-core";
import { describe, expect, it } from "vitest";

import { runWorkflow } from "./execute.ts";
import type { AgentRunReport, AgentRunRequest, WorkflowJob, WorktreeSpec } from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort } from "./ports.ts";

const job = (steps: WorkflowStep[], over: Partial<WorkflowJob> = {}): WorkflowJob => ({
  kind: "workflow",
  steps,
  group: "answer-260806-120000",
  runsDir: "/runs",
  timeoutMs: 1000,
  worktreeRoot: "/wt",
  repoPath: "/repo",
  ...over,
});

type Recorder = {
  agentRuns: AgentRunRequest[];
  worktrees: WorktreeSpec[];
  provisioned: { cwd: string; commands: ReadonlyArray<{ cmd: string }> }[];
  progress: string[];
};

const stubs = (
  outputs: Record<string, string> = {},
  failing: string[] = [],
): { layer: Layer.Layer<AgentPort | WorkspacePort | ProgressPort>; recorder: Recorder } => {
  const recorder: Recorder = { agentRuns: [], worktrees: [], provisioned: [], progress: [] };
  const layer = Layer.mergeAll(
    Layer.succeed(AgentPort, {
      run: (request: AgentRunRequest) =>
        Effect.sync(() => {
          recorder.agentRuns.push(request);
          const failed = failing.includes(request.agent);
          return {
            agent: request.agent,
            status: failed ? "failed" : "completed",
            cwd: request.cwd,
            output: outputs[request.task] ?? `${request.agent} answered`,
            durationMs: 5,
            ...(failed ? { error: "boom" } : {}),
          } satisfies AgentRunReport;
        }),
    }),
    Layer.succeed(WorkspacePort, {
      prepare: (spec: WorktreeSpec) =>
        Effect.sync(() => {
          recorder.worktrees.push(spec);
          return spec.worktreePath;
        }),
      provision: (cwd: string, commands: ReadonlyArray<{ cmd: string }>) =>
        Effect.sync(() => {
          recorder.provisioned.push({ cwd, commands });
        }),
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

const run = (j: WorkflowJob, layer: Layer.Layer<AgentPort | WorkspacePort | ProgressPort>) =>
  Effect.runPromise(runWorkflow(j).pipe(Effect.provide(layer)));

describe("runWorkflow", () => {
  it("runs steps in order and lands each result under its id", async () => {
    const { layer } = stubs();
    const envelope = await run(
      job([
        { id: "plan", activity: "run-claude", input: { task: "plan it" } },
        { id: "build", activity: "run-codex", input: { task: "build it" } },
      ]),
      layer,
    );

    expect(envelope.ok).toBe(true);
    expect((envelope.results.plan as { output: string }).output).toBe("claude answered");
    expect((envelope.results.build as { output: string }).output).toBe("codex answered");
  });

  // The engine seeds params under the reserved id `params`; every token form must resolve the
  // same way here or a definition means two different things on the two substrates.
  it("seeds params and resolves {{token}} and $ref against them", async () => {
    const { layer, recorder } = stubs();
    await run(
      job(
        [
          {
            id: "answer",
            activity: "{{params.runActivity}}",
            input: { task: "answer {{params.topic}}", model: { $ref: "params.modelAnswer" } },
          },
        ],
        { params: { runActivity: "run-codex", topic: "worktrees", modelAnswer: "m-9" } },
      ),
      layer,
    );

    expect(recorder.agentRuns[0]?.agent).toBe("codex");
    expect(recorder.agentRuns[0]?.task).toBe("answer worktrees");
    expect(recorder.agentRuns[0]?.model).toBe("m-9");
  });

  it("threads a previous step's result into a later step's input", async () => {
    const { layer, recorder } = stubs();
    await run(
      job([
        { id: "worktree", activity: "create-worktree", input: { branch: "feature/x" } },
        {
          id: "implement",
          activity: "run-claude",
          input: { cwd: "{{worktree.worktreePath}}", task: "go" },
        },
      ]),
      layer,
    );

    expect(recorder.worktrees[0]?.branch).toBe("feature/x");
    expect(recorder.worktrees[0]?.worktreePath).toBe("/wt/answer-260806-120000");
    // The worktree is cut from the checkout the operator invoked from, absent an explicit
    // clonePath — local execution has no pre-cloned shared workspace.
    expect(recorder.worktrees[0]?.repoPath).toBe("/repo");
    expect(recorder.agentRuns[0]?.cwd).toBe("/wt/answer-260806-120000");
  });

  it("lets a step's own clonePath override the invoking checkout", async () => {
    const { layer, recorder } = stubs();
    await run(
      job([{ id: "worktree", activity: "create-worktree", input: { clonePath: "/other/repo" } }]),
      layer,
    );
    expect(recorder.worktrees[0]?.repoPath).toBe("/other/repo");
  });

  // A blank slot means UNSET engine-side (templates emit "" for a cleared model); treating it as
  // a literal empty model would hand the CLI `--model ""`.
  it("treats a blank string slot as unset", async () => {
    const { layer, recorder } = stubs();
    await run(
      job([{ id: "a", activity: "run-claude", input: { task: "t", model: "", cwd: "" } }]),
      layer,
    );
    expect(recorder.agentRuns[0]?.model).toBeUndefined();
    expect(recorder.agentRuns[0]?.cwd).toBe("/repo");
  });

  it("fans a parallel group out and records both the branches and the group map", async () => {
    const { layer } = stubs();
    const envelope = await run(
      job([
        {
          id: "panel",
          parallel: [
            { id: "a", activity: "run-claude", input: { task: "q" } },
            { id: "b", activity: "run-codex", input: { task: "q" } },
          ],
        },
      ]),
      layer,
    );

    expect(envelope.ok).toBe(true);
    expect((envelope.results.a as { output: string }).output).toBe("claude answered");
    expect((envelope.results.b as { output: string }).output).toBe("codex answered");
    expect(Object.keys(envelope.results.panel as object)).toEqual(["a", "b"]);
  });

  it("resolves a group's branches against the results as they stood BEFORE the group", async () => {
    const { layer, recorder } = stubs();
    await run(
      job([
        { id: "seed", activity: "run-claude", input: { task: "seed" } },
        {
          id: "panel",
          parallel: [
            { id: "a", activity: "run-codex", input: { task: "{{seed.output}}" } },
            { id: "b", activity: "run-pi", input: { task: "{{seed.output}}" } },
          ],
        },
      ]),
      layer,
    );
    expect(recorder.agentRuns.slice(1).map((r) => r.task)).toEqual([
      "claude answered",
      "claude answered",
    ]);
  });

  it("skips setup by default and runs it under --with-setup", async () => {
    const steps: WorkflowStep[] = [
      { id: "setup", activity: "setup", input: { setup: [{ cmd: "install-things" }] } },
    ];

    const skipped = stubs();
    const off = await run(job(steps), skipped.layer);
    expect((off.results.setup as { skipped?: string }).skipped).toMatch(/opt-in/);
    expect(skipped.recorder.provisioned).toHaveLength(0);

    const opted = stubs();
    const on = await run(job(steps, { withSetup: true }), opted.layer);
    expect((on.results.setup as { provisioned: number }).provisioned).toBe(1);
    expect(opted.recorder.provisioned[0]?.cwd).toBe("/repo");
  });

  it("fails the step, and the run, when an agent fails", async () => {
    const { layer, recorder } = stubs({}, ["codex"]);
    const envelope = await run(
      job([
        { id: "first", activity: "run-claude", input: { task: "t" } },
        { id: "second", activity: "run-codex", input: { task: "t" } },
        { id: "third", activity: "run-pi", input: { task: "t" } },
      ]),
      layer,
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.failedStep).toBe("second");
    expect(envelope.error).toContain("boom");
    // The steps before the failure are preserved; the ones after never ran.
    expect(envelope.results.first).toBeDefined();
    expect(envelope.results.third).toBeUndefined();
    expect(recorder.agentRuns.map((r) => r.agent)).toEqual(["claude", "codex"]);
  });

  it("validates an output contract and attaches the block as `structured`", async () => {
    const answer = 'here you go\n\n```json\n{"answer": "42"}\n```\n';
    const { layer } = stubs({ q: answer });
    const envelope = await run(
      job([
        {
          id: "answer",
          activity: "run-claude",
          input: {
            task: "q",
            outputContract: {
              type: "object",
              required: ["answer"],
              properties: { answer: { type: "string" } },
            },
          },
        },
      ]),
      layer,
    );

    expect(envelope.ok).toBe(true);
    expect((envelope.results.answer as { structured: unknown }).structured).toEqual({
      answer: "42",
    });
  });

  it("fails the step when the contract is declared but unmet", async () => {
    const { layer } = stubs({ q: "no json block here" });
    const envelope = await run(
      job([
        {
          id: "answer",
          activity: "run-claude",
          input: { task: "q", outputContract: { type: "object", required: ["answer"] } },
        },
      ]),
      layer,
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.failedStep).toBe("answer");
    expect(envelope.error).toMatch(/fenced ```json block/);
  });

  // Refusing loud, not skipping: a silently-skipped register-cron would report a recurrence that
  // was never armed, and a silently-skipped run-itest a gate that never ran.
  it("refuses an engine/registry/cluster activity by name, with the reason", async () => {
    for (const [activity, expected] of [
      ["register-cron", /cron engine/],
      ["write-wf-row", /registry/],
      ["run-itest", /k8s namespace/],
      ["run-kimi", /only as a service/],
    ] as const) {
      const { layer } = stubs();
      const envelope = await run(job([{ id: "s", activity, input: {} }]), layer);
      expect(envelope.ok, activity).toBe(false);
      expect(envelope.error, activity).toMatch(expected);
    }
  });

  it("fails loud on an unresolvable activity token rather than defaulting an agent", async () => {
    const { layer } = stubs();
    const envelope = await run(
      job([{ id: "s", activity: "{{params.runActivity}}", input: { task: "t" } }]),
      layer,
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/unresolved token/);
  });

  it("fails loud on an activity no substrate knows", async () => {
    const { layer } = stubs();
    const envelope = await run(job([{ id: "s", activity: "run-nonsense", input: {} }]), layer);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/unknown activity/);
  });
});
