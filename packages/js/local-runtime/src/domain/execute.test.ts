import { Effect, Layer } from "effect";
import type { WorkflowStep } from "workflow-core";
import { describe, expect, it } from "vitest";

import { runWorkflow } from "./execute.ts";
import type {
  AgentRunReport,
  AgentRunRequest,
  JournalRecord,
  WorkflowJob,
  WorktreeSpec,
} from "./models.ts";
import { AgentPort, JournalPort, ProgressPort, WorkspacePort } from "./ports.ts";

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
  journal: Map<string, JournalRecord[]>;
};

type Ports = AgentPort | WorkspacePort | ProgressPort | JournalPort;

const stubs = (
  outputs: Record<string, string> = {},
  failing: string[] = [],
): { layer: Layer.Layer<Ports>; recorder: Recorder } => {
  const recorder: Recorder = {
    agentRuns: [],
    worktrees: [],
    provisioned: [],
    progress: [],
    journal: new Map(),
  };
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
    // In-memory journal shared across run() calls on one stub set (the resume tests' seam);
    // seq-dedup mirrors the stream's msgID identity.
    Layer.succeed(JournalPort, {
      replay: (_url, group) => Effect.succeed(recorder.journal.get(group) ?? []),
      append: (_url, group, record) =>
        Effect.sync(() => {
          const list = recorder.journal.get(group) ?? [];
          if (!list.some((existing) => existing.seq === record.seq)) list.push(record);
          recorder.journal.set(group, list);
        }),
    }),
  );
  return { layer, recorder };
};

const run = (j: WorkflowJob, layer: Layer.Layer<Ports>) =>
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

  // Step-granularity journal + resume. The fake journal lives on the RECORDER, so a "second
  // life" is a fresh stub set with the first life's journal copied over — different agent
  // behavior, same durable records, which is exactly the crash-and-retry shape.
  describe("journal + resume", () => {
    const journaled = { url: "nats://test:4222" };
    const contract = { type: "object", required: ["a"] };
    const okOut = 'prose\n\n```json\n{"a": 1}\n```\n';

    const twoSteps = (over: Partial<WorkflowJob> = {}): WorkflowJob =>
      job(
        [
          { id: "first", activity: "run-claude", input: { task: "t1", outputContract: contract } },
          { id: "second", activity: "run-claude", input: { task: "t2", outputContract: contract } },
        ],
        { journal: journaled, ...over },
      );

    const adopt = (from: Recorder, to: Recorder) => {
      for (const [group, records] of from.journal) to.journal.set(group, [...records]);
    };

    it("journals meta, each completed step, and a terminal", async () => {
      const { layer, recorder } = stubs({ t1: okOut, t2: okOut });
      const envelope = await run(twoSteps(), layer);

      expect(envelope.ok).toBe(true);
      const records = recorder.journal.get(envelope.group)!;
      expect(records.map((r) => r.type)).toEqual(["meta", "step", "step", "terminal"]);
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    });

    it("resumes after a failed step, replaying the paid one", async () => {
      // First life: step one passes (journaled), step two fails its output contract.
      const first = stubs({ t1: okOut, t2: "no fenced block" });
      const life1 = await run(twoSteps(), first.layer);
      expect(life1.ok).toBe(false);
      expect(life1.failedStep).toBe("second");
      expect(first.recorder.journal.get(life1.group)!.map((r) => r.type)).toEqual(["meta", "step"]);

      // Second life: the agent behaves; the journal says step one is done.
      const second = stubs({ t1: okOut, t2: okOut });
      adopt(first.recorder, second.recorder);
      const life2 = await run(twoSteps({ journal: { ...journaled, resume: true } }), second.layer);

      expect(life2.ok).toBe(true);
      expect(second.recorder.agentRuns.map((r) => r.task)).toEqual(["t2"]);
      expect(second.recorder.progress).toContain("↟ first: from journal");
      expect(second.recorder.journal.get(life2.group)!.map((r) => r.type)).toEqual([
        "meta",
        "step",
        "step",
        "terminal",
      ]);
    });

    it("re-runs only the unfinished branches of a parallel group", async () => {
      const group: WorkflowStep = {
        id: "panel",
        parallel: [
          { id: "a", activity: "run-claude", input: { task: "ta", outputContract: contract } },
          { id: "b", activity: "run-claude", input: { task: "tb", outputContract: contract } },
        ],
      };
      const first = stubs({ ta: okOut, tb: "no fenced block" });
      const life1 = await run(job([group], { journal: journaled }), first.layer);
      expect(life1.ok).toBe(false);
      // Branch a completed and journaled before the group failed.
      const journaledIds = first.recorder.journal
        .get(life1.group)!
        .filter((r): r is Extract<JournalRecord, { type: "step" }> => r.type === "step")
        .map((r) => r.stepId);
      expect(journaledIds).toEqual(["a"]);

      const second = stubs({ ta: okOut, tb: okOut });
      adopt(first.recorder, second.recorder);
      const life2 = await run(
        job([group], { journal: { ...journaled, resume: true } }),
        second.layer,
      );

      expect(life2.ok).toBe(true);
      expect(second.recorder.agentRuns.map((r) => r.task)).toEqual(["tb"]);
      // The group map is reconstructed from the replayed branch + the live one.
      expect(Object.keys(life2.results.panel as Record<string, unknown>).sort()).toEqual([
        "a",
        "b",
      ]);
    });

    it("refuses to resume a changed composition, and an unjournaled group", async () => {
      const first = stubs({ t1: okOut, t2: "no fenced block" });
      const life1 = await run(twoSteps(), first.layer);
      expect(life1.ok).toBe(false);

      const second = stubs({ t1: okOut, t2: okOut });
      adopt(first.recorder, second.recorder);
      const changed = twoSteps({ journal: { ...journaled, resume: true } });
      const tampered = {
        ...changed,
        steps: [...changed.steps.slice(0, 1), { id: "other", activity: "run-claude", input: {} }],
      } as WorkflowJob;
      const refused = await run(tampered, second.layer);
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/differs from the journaled run/);

      const fresh = stubs({});
      const missing = await run(twoSteps({ journal: { ...journaled, resume: true } }), fresh.layer);
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/no journal for group/);
      expect(fresh.recorder.agentRuns).toHaveLength(0);
    });

    it("resuming a completed run replays everything and runs nothing", async () => {
      const first = stubs({ t1: okOut, t2: okOut });
      const life1 = await run(twoSteps(), first.layer);
      expect(life1.ok).toBe(true);

      const second = stubs({ t1: okOut, t2: okOut });
      adopt(first.recorder, second.recorder);
      const life2 = await run(twoSteps({ journal: { ...journaled, resume: true } }), second.layer);

      expect(life2.ok).toBe(true);
      expect(life2.note).toMatch(/already completed/);
      expect(second.recorder.agentRuns).toHaveLength(0);
      // No second terminal: the journal is not extended by a no-op resume.
      expect(
        second.recorder.journal.get(life2.group)!.filter((r) => r.type === "terminal"),
      ).toHaveLength(1);
    });

    it("journals under the override key when the config names one (the relay's seam)", async () => {
      const { layer, recorder } = stubs({ t1: okOut, t2: okOut });
      const envelope = await run(
        twoSteps({ journal: { ...journaled, group: "loop-g-s3" } }),
        layer,
      );
      expect(envelope.ok).toBe(true);
      expect(recorder.journal.has(envelope.group)).toBe(false);
      expect(recorder.journal.get("loop-g-s3")!.map((r) => r.type)).toEqual([
        "meta",
        "step",
        "step",
        "terminal",
      ]);
    });

    it("writes nothing when the job carries no journal", async () => {
      const { layer, recorder } = stubs({ t1: okOut, t2: okOut });
      await run(twoSteps({ journal: undefined }), layer);
      expect(recorder.journal.size).toBe(0);
    });
  });
});
