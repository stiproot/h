import { Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { runChain } from "./chain.ts";
import type {
  AgentRunReport,
  AgentRunRequest,
  ChainJob,
  JournalRecord,
  LocalChainMember,
} from "./models.ts";
import { AgentPort, JournalPort, ProgressPort, WorkspacePort } from "./ports.ts";

/**
 * A member whose single step echoes a canned structured block, keyed by the member's marker.
 *
 * The step carries an `outputContract` because a CHAINED member must: threading reads the
 * validated `structured` block, so a template with no declared contract produces nothing to
 * capture and the chain fails loud rather than firing the next member on prose.
 */
const member = (over: Partial<LocalChainMember> & { kind: LocalChainMember["kind"] }) =>
  ({
    steps: [
      {
        id: "work",
        activity: "run-claude",
        input: { task: "{{params.marker}}", outputContract: { type: "object" } },
      },
    ],
    ...over,
  }) as LocalChainMember;

const job = (members: LocalChainMember[], over: Partial<ChainJob> = {}): ChainJob => ({
  kind: "chain",
  members,
  strategy: "sequential",
  group: "chain-260806-120000",
  runsDir: "/runs",
  timeoutMs: 1000,
  worktreeRoot: "/wt",
  repoPath: "/repo",
  ...over,
});

type Recorder = {
  runs: AgentRunRequest[];
  progress: string[];
  journal: Map<string, JournalRecord[]>;
};

/**
 * Each agent run answers with a fenced json block chosen by the task marker, so a member's
 * captured output is controllable from the test. `sequence` lets one marker answer differently
 * on successive calls (the loop cases).
 */
type Ports = AgentPort | WorkspacePort | ProgressPort | JournalPort;

const stubs = (
  answers: Record<string, string | string[]>,
): { layer: Layer.Layer<Ports>; recorder: Recorder } => {
  const recorder: Recorder = { runs: [], progress: [], journal: new Map() };
  const seen = new Map<string, number>();
  const layer = Layer.mergeAll(
    Layer.succeed(AgentPort, {
      run: (request: AgentRunRequest) =>
        Effect.sync(() => {
          recorder.runs.push(request);
          const answer = answers[request.task];
          const nth = seen.get(request.task) ?? 0;
          seen.set(request.task, nth + 1);
          const body = Array.isArray(answer)
            ? (answer[Math.min(nth, answer.length - 1)] ?? "{}")
            : (answer ?? "{}");
          return {
            agent: request.agent,
            status: body === "FAIL" ? "failed" : "completed",
            cwd: request.cwd,
            output: body === "FAIL" ? "" : "prose\n\n```json\n" + body + "\n```\n",
            durationMs: 1,
            ...(body === "FAIL" ? { error: "member blew up" } : {}),
          } satisfies AgentRunReport;
        }),
    }),
    Layer.succeed(WorkspacePort, {
      prepare: (spec) => Effect.succeed(spec.worktreePath),
      provision: () => Effect.void,
    }),
    // An in-memory journal shared across run() calls on ONE stub set, so a resume test can
    // die and continue against the same records. Seq-dedup mirrors the stream's msgID identity.
    Layer.succeed(JournalPort, {
      replay: (_url, group) => Effect.succeed(recorder.journal.get(group) ?? []),
      append: (_url, group, record) =>
        Effect.sync(() => {
          const list = recorder.journal.get(group) ?? [];
          if (!list.some((existing) => existing.seq === record.seq)) list.push(record);
          recorder.journal.set(group, list);
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

const run = (j: ChainJob, layer: Layer.Layer<Ports>) =>
  Effect.runPromise(runChain(j).pipe(Effect.provide(layer)));

describe("runChain", () => {
  // The coded contracts: implement-pr reads slug+spec and captures the PR it opened; review-pr
  // needs that PR number. This is the threading, shared with the durable engine.
  it("threads a member's captured output into the next member's params", async () => {
    const { layer, recorder } = stubs({
      implement: '{"pr": 42, "url": "https://example/pr/42"}',
      review: '{"verdict": "CLEAN", "summary": ""}',
    });
    const envelope = await run(
      job(
        [
          member({ kind: "implement-pr", params: { marker: "implement" } }),
          member({ kind: "review-pr", params: { marker: "review" } }),
        ],
        { data: { slug: "my-feature", spec: "do the thing" } },
      ),
      layer,
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.data.prNumber).toBe("42");
    expect(envelope.data.prUrl).toBe("https://example/pr/42");
    expect(envelope.runs.map((r) => r.stage)).toEqual([0, 1]);
    expect(recorder.runs).toHaveLength(2);
  });

  it("fails loud when a member's required input is missing, before firing it", async () => {
    const { layer, recorder } = stubs({ review: '{"verdict": "CLEAN"}' });
    // review-pr needs a prNumber on the chain data; nothing produced one.
    const envelope = await run(
      job([member({ kind: "review-pr", params: { marker: "review" } })]),
      layer,
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe("failed");
    expect(envelope.note).toMatch(/PR number/);
    expect(recorder.runs).toHaveLength(0);
  });

  it("runs a stage's members concurrently and namespaces their declared captures", async () => {
    const { layer } = stubs({ a: '{"answer": "from a"}', b: '{"answer": "from b"}' });
    const envelope = await run(
      job(
        [
          member({
            kind: "answer",
            id: "a",
            stage: 0,
            params: { marker: "a" },
            captures: { answer: "answer" },
          }),
          member({
            kind: "answer",
            id: "b",
            stage: 0,
            params: { marker: "b" },
            captures: { answer: "answer" },
          }),
        ],
        { data: { task: "q" } },
      ),
      layer,
    );

    expect(envelope.ok).toBe(true);
    // Namespaced under each member's id, so concurrent members never clobber a flat key.
    expect(envelope.data.a).toEqual({ answer: "from a" });
    expect(envelope.data.b).toEqual({ answer: "from b" });
    expect(envelope.runs.every((r) => r.stage === 0)).toBe(true);
  });

  it("reads a dotted input path back out of another member's namespace", async () => {
    const { layer, recorder } = stubs({
      first: '{"answer": "the seed"}',
      second: '{"answer": "ok"}',
    });
    await run(
      job(
        [
          member({
            kind: "answer",
            id: "first",
            params: { marker: "first" },
            captures: { answer: "answer" },
          }),
          member({
            kind: "answer",
            id: "second",
            params: { marker: "second" },
            inputs: { task: "first.answer" },
          }),
        ],
        { data: { task: "q" } },
      ),
      layer,
    );
    // The second member's `task` param came from the first member's namespaced capture.
    expect(recorder.runs).toHaveLength(2);
  });

  it("fails the chain when a member fails, without running the next stage", async () => {
    const { layer, recorder } = stubs({ one: "FAIL", two: '{"answer": "never"}' });
    const envelope = await run(
      job(
        [
          member({ kind: "answer", id: "one", params: { marker: "one" } }),
          member({ kind: "answer", id: "two", params: { marker: "two" } }),
        ],
        { data: { task: "q" } },
      ),
      layer,
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe("failed");
    expect(envelope.note).toMatch(/member 'one' failed/);
    expect(recorder.runs.map((r) => r.task)).toEqual(["one"]);
  });

  describe("loop-until-clean", () => {
    /** implement → review → revise, where the review verdict changes per iteration. */
    const loopStubs = (reviews: string[]) =>
      stubs({
        implement: '{"pr": 7, "url": "u"}',
        review: reviews,
        revise: '{"pr": 7, "url": "u"}',
      });

    const loopJob = (maxIterations: number) =>
      job(
        [
          member({ kind: "implement-pr", params: { marker: "implement" } }),
          member({ kind: "review-pr", params: { marker: "review" } }),
          member({ kind: "revise-pr", params: { marker: "revise" } }),
        ],
        {
          data: { slug: "s", spec: "x" },
          strategy: "loop-until-clean",
          // startCursor is the review STAGE, not a member index.
          loop: { startCursor: 1, maxIterations },
        },
      );

    it("stops as soon as the review stage reports CLEAN", async () => {
      const { layer, recorder } = loopStubs(['{"verdict": "CLEAN", "summary": ""}']);
      const envelope = await run(loopJob(3), layer);

      expect(envelope.ok).toBe(true);
      expect(envelope.note).toMatch(/clean after 0/);
      // revise never ran: the review was clean on the first pass.
      expect(recorder.runs.map((r) => r.task)).toEqual(["implement", "review"]);
    });

    it("loops review→revise until clean, then finishes", async () => {
      const { layer, recorder } = loopStubs([
        '{"verdict": "FINDINGS", "summary": "fix it"}',
        '{"verdict": "CLEAN", "summary": ""}',
      ]);
      const envelope = await run(loopJob(3), layer);

      expect(envelope.ok).toBe(true);
      expect(recorder.runs.map((r) => r.task)).toEqual(["implement", "review", "revise", "review"]);
      // A loop re-run gets its own ledger group, so an iteration never overwrites the previous.
      const reviewRuns = envelope.runs.filter((r) => r.member === "review-pr");
      expect(new Set(reviewRuns.map((r) => r.group)).size).toBe(2);
    });

    // The budget is the backstop for an implementer/reviewer disagreement that never converges.
    it("stops at the iteration budget and says findings may remain", async () => {
      const { layer, recorder } = loopStubs(['{"verdict": "FINDINGS", "summary": "still bad"}']);
      const envelope = await run(loopJob(2), layer);

      expect(envelope.ok).toBe(false);
      expect(envelope.status).toBe("exhausted");
      expect(envelope.note).toMatch(/stopped after 2 iteration/);
      expect(recorder.runs.filter((r) => r.task === "review")).toHaveLength(2);
    });
  });

  // The whole-chain wall clock — the ONE branch of the durable engine's `decide` this driver
  // mirrors, because it needs a deadline rather than durability.
  describe("chain budget", () => {
    it("runs the whole chain when the budget has room", async () => {
      const { layer, recorder } = stubs({
        implement: '{"pr": 42, "url": "https://example/pr/42"}',
        review: '{"verdict": "CLEAN", "summary": ""}',
      });
      const envelope = await run(
        job(
          [
            member({ kind: "implement-pr", params: { marker: "implement" } }),
            member({ kind: "review-pr", params: { marker: "review" } }),
          ],
          { data: { slug: "s", spec: "x" }, budgetMs: 60 * 60_000 },
        ),
        layer,
      );

      expect(envelope.status).toBe("completed");
      expect(recorder.runs).toHaveLength(2);
    });

    it("starts no work at all when the budget is already spent", async () => {
      const { layer, recorder } = stubs({ implement: "{}" });
      const envelope = await run(
        job([member({ kind: "implement-pr", params: { marker: "implement" } })], {
          data: { slug: "s", spec: "x" },
          budgetMs: 0,
        }),
        layer,
      );

      expect(envelope.ok).toBe(false);
      expect(envelope.status).toBe("exhausted");
      expect(envelope.note).toMatch(/chain budget 0ms exceeded/);
      // Checking BEFORE the stage is the point: no agent ran, so no cost was incurred.
      expect(recorder.runs).toHaveLength(0);
    });

    it("stops mid-chain once time spent in earlier stages has eaten the budget", async () => {
      // Each agent run advances a TEST clock, so "time passed while the agent worked" is
      // deterministic: 40m per stage against a 60m budget means stage 0 runs, stage 1 runs
      // (t=40m), and stage 2 is declined (t=80m) — the deadline is ABSOLUTE, not per stage.
      const ran: string[] = [];
      const layer = Layer.mergeAll(
        Layer.succeed(AgentPort, {
          run: (request: AgentRunRequest) =>
            TestClock.adjust("40 minutes").pipe(
              Effect.as({
                agent: request.agent,
                status: "completed",
                cwd: request.cwd,
                output:
                  'prose\n\n```json\n{"pr": 1, "url": "u", "verdict": "FINDINGS", "summary": "s"}\n```\n',
                durationMs: 1,
              } satisfies AgentRunReport),
              Effect.tap(() => Effect.sync(() => ran.push(request.task))),
            ),
        }),
        Layer.succeed(WorkspacePort, {
          prepare: (spec) => Effect.succeed(spec.worktreePath),
          provision: () => Effect.void,
        }),
        Layer.succeed(ProgressPort, { emit: () => Effect.void }),
        Layer.succeed(JournalPort, {
          replay: () => Effect.succeed([]),
          append: () => Effect.void,
        }),
      );

      const envelope = await Effect.runPromise(
        runChain(
          job(
            [
              member({ kind: "implement-pr", params: { marker: "implement" } }),
              member({ kind: "review-pr", params: { marker: "review" } }),
              member({ kind: "revise-pr", params: { marker: "revise" } }),
            ],
            { data: { slug: "s", spec: "x" }, budgetMs: 60 * 60_000 },
          ),
        ).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)),
      );

      expect(envelope.status).toBe("exhausted");
      expect(envelope.note).toMatch(/stopped before stage 2 of 2/);
      expect(ran).toEqual(["implement", "review"]);
    });
  });

  // The journal: what survives the driver. These run against the in-memory fake — the NATS
  // adapter is wire plumbing; the RECORDS and the resume semantics are the domain under test.
  describe("journal + resume", () => {
    const journaled = { url: "nats://test:4222" };

    const twoStage = (over: Partial<ChainJob> = {}) =>
      job(
        [
          member({
            kind: "answer",
            id: "one",
            params: { marker: "one" },
            captures: { answer: "answer" },
          }),
          member({
            kind: "answer",
            id: "two",
            params: { marker: "two" },
            captures: { answer: "answer" },
          }),
        ],
        { data: { task: "q" }, journal: journaled, ...over },
      );

    it("writes meta, one record per stage, and a terminal on completion", async () => {
      const { layer, recorder } = stubs({ one: '{"answer": "a1"}', two: '{"answer": "a2"}' });
      const envelope = await run(twoStage(), layer);

      expect(envelope.ok).toBe(true);
      const records = recorder.journal.get(envelope.chain)!;
      expect(records.map((r) => r.type)).toEqual(["meta", "stage", "stage", "terminal"]);
      const stage0 = records[1]! as Extract<JournalRecord, { type: "stage" }>;
      expect(stage0.cursor).toBe(0);
      // The record snapshots POST-capture data: resume reads one record, not a replay of work.
      expect(stage0.data.one).toEqual({ answer: "a1" });
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    });

    it("writes nothing when the job carries no journal", async () => {
      const { layer, recorder } = stubs({ one: '{"answer": "a1"}', two: '{"answer": "a2"}' });
      await run(twoStage({ journal: undefined }), layer);
      expect(recorder.journal.size).toBe(0);
    });

    it("resumes a failed run at its cursor without re-paying finished stages", async () => {
      // First run: stage 0 succeeds (journaled), stage 1 fails — the scout-chain shape.
      const { layer, recorder } = stubs({
        one: '{"answer": "a1"}',
        two: ["FAIL", '{"answer": "a2"}'],
      });
      const first = await run(twoStage(), layer);
      expect(first.status).toBe("failed");
      expect(recorder.journal.get(first.chain)!.map((r) => r.type)).toEqual(["meta", "stage"]);

      const resumed = await run(twoStage({ journal: { ...journaled, resume: true } }), layer);
      expect(resumed.ok).toBe(true);
      // Member one ran ONCE across both lives; its capture came back off the journal.
      expect(recorder.runs.map((r) => r.task)).toEqual(["one", "two", "two"]);
      expect(resumed.data.one).toEqual({ answer: "a1" });
      expect(resumed.data.two).toEqual({ answer: "a2" });
      // The resumed life journals its stage and the terminal under continued seqs.
      expect(recorder.journal.get(first.chain)!.map((r) => r.type)).toEqual([
        "meta",
        "stage",
        "stage",
        "terminal",
      ]);
    });

    it("refuses to resume under a changed composition", async () => {
      const { layer } = stubs({ one: '{"answer": "a1"}', two: ["FAIL", '{"answer": "a2"}'] });
      const first = await run(twoStage(), layer);
      expect(first.status).toBe("failed");

      const changed = twoStage({ journal: { ...journaled, resume: true } });
      const tampered = {
        ...changed,
        members: changed.members.map((m, i) =>
          i === 1 ? { ...m, params: { ...m.params, marker: "different" } } : m,
        ),
      };
      const resumed = await run(tampered as ChainJob, layer);
      expect(resumed.status).toBe("failed");
      expect(resumed.note).toMatch(/differs from the journaled run/);
    });

    it("refuses to resume a group that was never journaled", async () => {
      const { layer, recorder } = stubs({ one: '{"answer": "a1"}' });
      const envelope = await run(twoStage({ journal: { ...journaled, resume: true } }), layer);
      expect(envelope.status).toBe("failed");
      expect(envelope.note).toMatch(/no journal for group/);
      expect(recorder.runs).toHaveLength(0);
    });

    it("resuming a completed run is a loud no-op", async () => {
      const { layer, recorder } = stubs({ one: '{"answer": "a1"}', two: '{"answer": "a2"}' });
      const first = await run(twoStage(), layer);
      expect(first.ok).toBe(true);

      const resumed = await run(twoStage({ journal: { ...journaled, resume: true } }), layer);
      expect(resumed.ok).toBe(true);
      expect(resumed.note).toMatch(/already completed/);
      // Nothing re-ran, and no second terminal was written.
      expect(recorder.runs.map((r) => r.task)).toEqual(["one", "two"]);
      expect(recorder.journal.get(first.chain)!.filter((r) => r.type === "terminal")).toHaveLength(
        1,
      );
    });
  });
});
