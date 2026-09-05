import { Effect, Layer, TestClock, TestContext } from "effect";
import type { QuotaRow } from "engine-core";
import type { WorkflowStep } from "workflow-core";
import { describe, expect, it } from "vitest";

import { runWorkflow } from "./execute.ts";
import {
  AllowAllExecPolicy,
  memoryArmStores,
  memoryQuotaStore,
  memoryWfStore,
} from "./policy.test-layer.ts";
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
  toolCalls: number | null = 7,
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
            toolCalls,
            ...(failed ? { error: "boom" } : {}),
          } satisfies AgentRunReport;
        }),
    }),
    Layer.succeed(WorkspacePort, {
      prepare: (spec: WorktreeSpec) =>
        Effect.sync(() => {
          recorder.worktrees.push(spec);
          return { worktreePath: spec.worktreePath, seeded: { copied: [], kept: [], missing: [] } };
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
  Effect.runPromise(
    runWorkflow(j).pipe(
      Effect.provide(layer),
      Effect.provide(AllowAllExecPolicy),
      Effect.provide(memoryWfStore().layer),
      Effect.provide(memoryArmStores().layer),
    ),
  );

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
    expect((envelope.results.plan as { toolCalls: number | null }).toolCalls).toBe(7);
  });

  it("preserves an unknown tool-call count as null", async () => {
    const { layer } = stubs({}, [], null);
    const envelope = await run(
      job([{ id: "answer", activity: "run-codex", input: { task: "answer" } }]),
      layer,
    );

    expect((envelope.results.answer as { toolCalls: number | null }).toolCalls).toBeNull();
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
        {
          id: "worktree",
          activity: "create-worktree",
          input: { checkout: { kind: "branch", branch: "feature/x" } },
        },
        {
          id: "implement",
          activity: "run-claude",
          input: { cwd: "{{worktree.worktreePath}}", task: "go" },
        },
      ]),
      layer,
    );

    const cut = recorder.worktrees[0]?.checkout;
    expect(cut?.kind === "branch" ? cut.branch : undefined).toBe("feature/x");
    expect(recorder.worktrees[0]?.worktreePath).toBe("/wt/answer-260806-120000");
    // The worktree is cut from the checkout the operator invoked from, absent an explicit
    // clonePath — local execution has no pre-cloned shared workspace.
    expect(recorder.worktrees[0]?.repoPath).toBe("/repo");
    expect(recorder.agentRuns[0]?.cwd).toBe("/wt/answer-260806-120000");
  });

  // Substrate parity: a review template's detached checkout must mean the same thing here as it
  // does through the agent service's /worktree — including that no origin/main default is invented
  // for it, which would be the branch strategy's behaviour and would review the wrong commit.
  it("passes a detached checkout through, inventing no branch defaults", async () => {
    const { layer, recorder } = stubs();
    await run(
      job([
        {
          id: "worktree",
          activity: "create-worktree",
          input: {
            checkout: {
              kind: "detached",
              ref: "refs/remotes/origin/pr/42/head",
              fetch: { remoteRef: "refs/pull/42/head", depth: 1 },
            },
          },
        },
      ]),
      layer,
    );
    expect(recorder.worktrees[0]?.checkout).toEqual({
      kind: "detached",
      ref: "refs/remotes/origin/pr/42/head",
      fetch: { remoteRef: "refs/pull/42/head", depth: 1 },
    });
  });

  // The counterpart default: a create-worktree step with no checkout at all still means the branch
  // strategy refreshed from origin/main, exactly as /worktree defaults it.
  it("defaults an absent checkout to the branch strategy off origin/main", async () => {
    const { layer, recorder } = stubs();
    await run(job([{ id: "worktree", activity: "create-worktree", input: {} }]), layer);
    expect(recorder.worktrees[0]?.checkout).toEqual({
      kind: "branch",
      branch: undefined,
      baseRef: undefined,
      remoteBase: "main",
    });
  });

  // The seed list — gitignored files a checkout cannot carry — reaches the WorkspacePort as
  // declared, and what seeding did lands in the step result beside worktreePath, so a later
  // step (or the driver reading the envelope) can see that `.env` was copied, kept, or missing.
  it("forwards a seed list and surfaces the seed report in the step result", async () => {
    const { layer, recorder } = stubs();
    const envelope = await run(
      job([
        {
          id: "worktree",
          activity: "create-worktree",
          input: { seed: ["apps/svc/.env", ".env.local", 42] },
        },
      ]),
      layer,
    );
    expect(recorder.worktrees[0]?.seed).toEqual(["apps/svc/.env", ".env.local"]);
    expect(envelope.results.worktree).toMatchObject({
      worktreePath: "/wt/answer-260806-120000",
      seeded: { copied: [], kept: [], missing: [] },
    });
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
      // Both are engine BRACKETS, implemented here yet unnameable as steps on either substrate —
      // a template naming one is a composition error, so the message says so rather than
      // pretending the capability is missing.
      ["register-cron", /never\s+by a step/],
      ["write-wf-row", /never by a step/],
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

describe("runWorkflow — the wf:run bracket", () => {
  const wfIdentity = { repo: "o/r", slug: "x", workflow: "implement-pr" };

  /** Runs with a real (in-memory) wf registry so the bracket's writes can be asserted. */
  const runBracketed = async (j: WorkflowJob) => {
    const { layer } = stubs();
    const wf = memoryWfStore();
    const envelope = await Effect.runPromise(
      runWorkflow(j).pipe(
        Effect.provide(layer),
        Effect.provide(AllowAllExecPolicy),
        Effect.provide(wf.layer),
        Effect.provide(memoryArmStores().layer),
      ),
    );
    return { envelope, rows: wf.rows };
  };

  it("writes done + the results as output, keyed by the run's own instanceId", async () => {
    const { envelope, rows } = await runBracketed(
      job([{ id: "s", activity: "run-claude", input: { task: "go" } }], {
        group: "feature-x",
        wf: wfIdentity,
      }),
    );

    expect(envelope.ok).toBe(true);
    // The group IS the instanceId — the same key that names the workspace, the ledger entry and
    // the worktree — so an engine that fired under a chosen id reads back with no mapping.
    const row = rows.get("feature-x");
    expect(row?.status).toBe("done");
    expect(row?.repo).toBe("o/r");
    // The output is what makes this a status SOURCE rather than an audit trail: a chain captures
    // from it, and the invoker returns it alongside the status.
    expect(row?.output).toContain("s");
  });

  it("writes failed when a step fails, so a dead run is not indistinguishable from a live one", async () => {
    const { layer } = stubs({}, ["claude"]);
    const wf = memoryWfStore();
    await Effect.runPromise(
      runWorkflow(
        job([{ id: "s", activity: "run-claude", input: { task: "go" } }], {
          group: "feature-y",
          wf: wfIdentity,
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provide(AllowAllExecPolicy),
        Effect.provide(wf.layer),
        Effect.provide(memoryArmStores().layer),
      ),
    );
    expect(wf.rows.get("feature-y")?.status).toBe("failed");
  });

  it("records the goal handshake from the structured output, not from run success", async () => {
    // `done` (the steps finished) and `resolved` (the SUBJECT is finished) are different facts —
    // the whole reason a cron keeps recurring after a successful run.
    const { rows } = await runBracketed(
      job([{ id: "s", activity: "run-claude", input: { task: "go" } }], {
        group: "feature-z",
        wf: wfIdentity,
      }),
    );
    expect(rows.get("feature-z")?.resolved).toBeUndefined();
  });

  it("stamps the parent primitive so a run traces back without an index", async () => {
    const { rows } = await runBracketed(
      job([{ id: "s", activity: "run-claude", input: { task: "go" } }], {
        group: "chain-x-w0",
        wf: wfIdentity,
        parent: { chainId: "chain-x", memberIndex: 0 },
      }),
    );
    expect(rows.get("chain-x-w0")).toMatchObject({ chainId: "chain-x", memberIndex: 0 });
  });

  it("writes NO row when the job carries no wf block", async () => {
    // A plain `h workflow run --local` has no engine waiting on it, and a row nobody reads is
    // just growth.
    const { rows } = await runBracketed(
      job([{ id: "s", activity: "run-claude", input: { task: "go" } }], { group: "adhoc" }),
    );
    expect(rows.size).toBe(0);
  });
});

describe("runWorkflow — the armCron closing bracket (§10)", () => {
  const armed = (job_: WorkflowJob) => {
    const { layer } = stubs();
    const arms = memoryArmStores();
    return Effect.runPromise(
      runWorkflow(job_).pipe(
        Effect.provide(layer),
        Effect.provide(AllowAllExecPolicy),
        Effect.provide(memoryWfStore().layer),
        Effect.provide(arms.layer),
      ),
    ).then((envelope) => ({ envelope, rows: arms.armed }));
  };

  const withCron = (over: Partial<WorkflowJob> = {}) =>
    job([{ id: "s", activity: "run-claude", input: { task: "go" } }], {
      group: "feature-x",
      params: { repo: "o/r", slug: "x" },
      armCron: { cadence: "0 3 * * *", workflow: "revise-pr" },
      ...over,
    });

  it("arms AFTER the work, under the run's own identity", async () => {
    const { envelope, rows } = await armed(withCron());
    expect(envelope.ok).toBe(true);
    // §10: the RUN registers its own recurrence; the engine acts on the row. Keyed by the coord
    // tuple both substrates derive.
    expect([...rows.keys()]).toEqual(["o/r:x:revise-pr"]);
  });

  it("does NOT arm when the run failed — a loop off failed work has nothing to recur", async () => {
    const { layer } = stubs({}, ["claude"]);
    const arms = memoryArmStores();
    await Effect.runPromise(
      runWorkflow(withCron()).pipe(
        Effect.provide(layer),
        Effect.provide(AllowAllExecPolicy),
        Effect.provide(memoryWfStore().layer),
        Effect.provide(arms.layer),
      ),
    );
    expect(arms.armed.size).toBe(0);
  });

  it("honours planCron's arm-at-birth guard as a valid NO-OP, not a failure", async () => {
    // Shared with the Dapr engine: arming a revise-pr loop for a PR that never opened is wrong,
    // and declining is an outcome rather than an error.
    const { envelope, rows } = await armed(
      withCron({
        armCron: { cadence: "0 3 * * *", workflow: "revise-pr" },
        params: {
          repo: "o/r",
          slug: "x",
          requirePrFrom: "no fenced block here",
        },
      }),
    );
    expect(envelope.ok).toBe(true);
    expect(rows.size).toBe(1); // the guard only applies when the input carries requirePrFrom
  });

  it("arms nothing when the job carries no armCron", async () => {
    const { rows } = await armed(
      job([{ id: "s", activity: "run-claude", input: { task: "go" } }], { group: "plain" }),
    );
    expect(rows.size).toBe(0);
  });
});

describe("runWorkflow — reformat retry on contract violation", () => {
  const contract = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
  };
  const validOut = '```json\n{"answer": "42"}\n```';
  const badOut = "no fenced json block here";

  /**
   * A stub layer where AgentPort returns responses from a sequence — one per invocation.
   * Remaining invocations beyond the sequence replay the last entry.
   */
  const sequenceStub = (
    responses: Array<{ output: string; toolCalls: number | null; status?: "completed" | "failed" }>,
  ): { layer: Layer.Layer<Ports>; recorder: Recorder } => {
    const recorder: Recorder = {
      agentRuns: [],
      worktrees: [],
      provisioned: [],
      progress: [],
      journal: new Map(),
    };
    let callIndex = 0;
    const layer = Layer.mergeAll(
      Layer.succeed(AgentPort, {
        run: (request: AgentRunRequest) =>
          Effect.sync(() => {
            recorder.agentRuns.push(request);
            const resp = responses[Math.min(callIndex, responses.length - 1)]!;
            callIndex++;
            return {
              agent: request.agent,
              status: resp.status ?? "completed",
              cwd: request.cwd,
              output: resp.output,
              durationMs: 5,
              toolCalls: resp.toolCalls,
            } satisfies AgentRunReport;
          }),
      }),
      Layer.succeed(WorkspacePort, {
        prepare: (spec: WorktreeSpec) =>
          Effect.sync(() => {
            recorder.worktrees.push(spec);
            return {
              worktreePath: spec.worktreePath,
              seeded: { copied: [], kept: [], missing: [] },
            };
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

  const contractStep = (): WorkflowStep => ({
    id: "answer",
    activity: "run-claude",
    input: { task: "q", outputContract: contract },
  });

  it("succeeds with the reformat block when the first block violates but the second is valid", async () => {
    // Demonstration 1: first block violates, second is valid — step must succeed.
    const { layer, recorder } = sequenceStub([
      { output: badOut, toolCalls: 7 },
      { output: validOut, toolCalls: 0 },
    ]);
    const envelope = await run(job([contractStep()]), layer);

    expect(envelope.ok).toBe(true);
    expect(recorder.agentRuns).toHaveLength(2);
    // The reformat result's toolCalls comes from the second report (zero tool calls assertion).
    // agentRuns stores requests; the toolCalls on the step result comes from the reformat report.
    expect((envelope.results.answer as { toolCalls: number | null }).toolCalls).toBe(0);
    expect((envelope.results.answer as { structured: unknown }).structured).toEqual({
      answer: "42",
    });
    // The reformat progress line must be visible in the run ledger.
    expect(recorder.progress.some((l) => l.includes("↻ answer:") && l.includes("reformat"))).toBe(
      true,
    );
  });

  it("fails with SECOND block's violations and states a reformat was attempted when both blocks fail", async () => {
    // Demonstration 2: both blocks violate — step must fail, error names the second violation.
    const { layer, recorder } = sequenceStub([
      { output: badOut, toolCalls: 7 },
      { output: "still no json", toolCalls: 0 },
    ]);
    const envelope = await run(job([contractStep()]), layer);

    expect(envelope.ok).toBe(false);
    expect(recorder.agentRuns).toHaveLength(2);
    expect(envelope.error).toContain("Reformat was attempted.");
    // The error must describe the SECOND block's problems (not merely echo the first).
    expect(envelope.error).toContain("fenced");
  });

  it("does NOT retry on a non-contract failure — only one invocation, no reformat message", async () => {
    // Demonstration 3: agent returns status:failed — no retry, single invocation.
    const { layer, recorder } = sequenceStub([{ output: "", toolCalls: null, status: "failed" }]);
    const envelope = await run(job([contractStep()]), layer);

    expect(envelope.ok).toBe(false);
    expect(recorder.agentRuns).toHaveLength(1);
    expect(envelope.error).not.toContain("reformat");
    expect(envelope.error).not.toContain("Reformat");
  });
});

describe("runWorkflow — the quota gate", () => {
  /** What claude's CLI reported last time: the 5h window nearly spent, resetting in an hour. */
  const hot = (
    nowMs: number,
    utilization: number,
    status: QuotaRow["status"] = "allowed_warning",
  ) =>
    new Map<string, QuotaRow>([
      [
        "claude",
        {
          executor: "claude",
          status,
          windows: {
            five_hour: { utilization, resetsAt: new Date(nowMs + 3_600_000).toISOString() },
          },
          observedAt: new Date(nowMs).toISOString(),
          runId: "g:claude:1",
          history: [],
          updatedAt: new Date(nowMs).toISOString(),
        },
      ],
    ]);

  const step: WorkflowStep = { id: "s", activity: "run-claude", input: { task: "go" } };

  /** Runs on the TEST clock (epoch 0), so a wait can be driven rather than slept. */
  const runGated = (j: WorkflowJob, rows: Map<string, QuotaRow>, drive?: Effect.Effect<void>) => {
    const { layer, recorder } = stubs();
    const program = runWorkflow(j).pipe(
      Effect.provide(layer),
      Effect.provide(memoryQuotaStore(rows).layer),
      Effect.provide(AllowAllExecPolicy),
      Effect.provide(memoryWfStore().layer),
      Effect.provide(memoryArmStores().layer),
    );
    const driven = drive
      ? Effect.gen(function* () {
          const fiber = yield* Effect.fork(program);
          yield* drive;
          return yield* fiber;
        })
      : program;
    return Effect.runPromise(driven.pipe(Effect.provide(TestContext.TestContext))).then(
      (envelope) => ({ envelope, recorder }),
    );
  };

  it("refuses a step that would not fit the window, naming every way past it", async () => {
    const { envelope, recorder } = await runGated(job([step]), hot(0, 0.95));
    expect(envelope.ok).toBe(false);
    expect(envelope.failedStep).toBe("s");
    expect(envelope.error).toContain("claude's 5h window is at 95%");
    expect(envelope.error).toContain("--on-quota wait");
    expect(envelope.error).toContain("--ignore-quota");
    // Nothing was spent: the refusal is BEFORE the agent runs.
    expect(recorder.agentRuns).toHaveLength(0);
  });

  it("proceeds when the window has room for the estimated step", async () => {
    const { envelope, recorder } = await runGated(job([step]), hot(0, 0.5));
    expect(envelope.ok).toBe(true);
    expect(recorder.agentRuns).toHaveLength(1);
  });

  it("--ignore-quota fires regardless", async () => {
    const { envelope, recorder } = await runGated(
      job([step], { quota: { onQuota: "fail", ignore: true } }),
      hot(0, 0.95, "rejected"),
    );
    expect(envelope.ok).toBe(true);
    expect(recorder.agentRuns).toHaveLength(1);
  });

  it("--on-quota wait sleeps until the window resets, then fires", async () => {
    const { envelope, recorder } = await runGated(
      job([step], { quota: { onQuota: "wait" } }),
      hot(0, 0.95),
      // 1h to the reset + the 60s slack. Two adjusts: the first proves it is still waiting.
      Effect.gen(function* () {
        yield* TestClock.adjust("30 minutes");
        yield* TestClock.adjust("31 minutes");
      }),
    );
    expect(envelope.ok).toBe(true);
    expect(recorder.agentRuns).toHaveLength(1);
    expect(
      recorder.progress.some((line) => line.includes("⏳ s:") && line.includes("waiting until")),
    ).toBe(true);
  });
});
