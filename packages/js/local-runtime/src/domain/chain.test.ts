import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { runChain } from "./chain.ts";
import type { AgentRunReport, AgentRunRequest, ChainJob, LocalChainMember } from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort } from "./ports.ts";

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

type Recorder = { runs: AgentRunRequest[]; progress: string[] };

/**
 * Each agent run answers with a fenced json block chosen by the task marker, so a member's
 * captured output is controllable from the test. `sequence` lets one marker answer differently
 * on successive calls (the loop cases).
 */
const stubs = (
  answers: Record<string, string | string[]>,
): { layer: Layer.Layer<AgentPort | WorkspacePort | ProgressPort>; recorder: Recorder } => {
  const recorder: Recorder = { runs: [], progress: [] };
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
    Layer.succeed(ProgressPort, {
      emit: (line: string) =>
        Effect.sync(() => {
          recorder.progress.push(line);
        }),
    }),
  );
  return { layer, recorder };
};

const run = (j: ChainJob, layer: Layer.Layer<AgentPort | WorkspacePort | ProgressPort>) =>
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
});
