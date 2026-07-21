import { describe, expect, it } from "vitest";

import {
  type Blackboard,
  capturePanel,
  capturePr,
  captureReview,
  ChainThreadError,
  contractFor,
  loopIsClean,
  reviewIsClean,
  stepStructured,
  WORKFLOW_KINDS,
} from "./chain-workflows.ts";

// A workflow result as the generic workflow returns it: { <stepId>: { output, structured? } }.
// Structured values are the rung-2 seam's code-validated blocks (structured-workflow-outputs).
function result(steps: Record<string, { output?: string; structured?: unknown }>): string {
  return JSON.stringify(steps);
}

describe("stepStructured: merges validated structured envelopes", () => {
  const single = result({
    plan: { output: "prose only" },
    "create-pr": { output: "opened it", structured: { pr: 42, url: "https://x/pull/42" } },
  });

  it("reads a single-encoded result", () => {
    expect(stepStructured(single)).toEqual({ pr: 42, url: "https://x/pull/42" });
  });

  it("reads the DOUBLE-encoded result (Dapr re-serializes the workflow's own JSON string)", () => {
    expect(stepStructured(JSON.stringify(single))).toEqual({ pr: 42, url: "https://x/pull/42" });
  });

  it("merges in step order — later steps win", () => {
    const out = result({
      review: { structured: { verdict: "FINDINGS", summary: "old" } },
      revise: { structured: { summary: "new" } },
    });
    expect(stepStructured(out)).toEqual({ verdict: "FINDINGS", summary: "new" });
  });

  it("returns undefined when no step carries structured output", () => {
    expect(stepStructured(result({ implement: { output: "prose only" } }))).toBeUndefined();
    expect(stepStructured(undefined)).toBeUndefined();
    expect(stepStructured("not json{")).toBeUndefined();
  });
});

describe("capturePr (structured only)", () => {
  it("threads pr + url onto the blackboard; prNumber lands as a string", () => {
    const data: Blackboard = {};
    capturePr(
      result({ "create-pr": { structured: { pr: 22, url: "https://github.com/o/r/pull/22" } } }),
      data,
    );
    expect(data.prNumber).toBe("22");
    expect(data.prUrl).toBe("https://github.com/o/r/pull/22");
  });

  it("a structured skip sets nothing — the next workflow's buildParams fails loud instead", () => {
    const data: Blackboard = {};
    capturePr(result({ "create-pr": { structured: { skipped: "GH_TOKEN unset" } } }), data);
    expect(data.prNumber).toBeUndefined();
    expect(data.prUrl).toBeUndefined();
    expect(() => WORKFLOW_KINDS["pr-review"].buildParams(data)).toThrow(ChainThreadError);
  });

  it("fails loud when the run emitted NO structured output (undeclared template)", () => {
    expect(() => capturePr(result({ implement: { output: "just prose" } }), {})).toThrow(
      /no structured output.*outputs contract/,
    );
  });
});

describe("captureReview (structured only)", () => {
  it("CLEAN means empty findings; FINDINGS threads the summary", () => {
    const clean: Blackboard = {};
    captureReview(result({ review: { structured: { verdict: "CLEAN" } } }), clean);
    expect(clean.reviewFindings).toBe("");
    const findings: Blackboard = {};
    captureReview(
      result({ review: { structured: { verdict: "FINDINGS", summary: "a.ts:1 — bug" } } }),
      findings,
    );
    expect(findings.reviewFindings).toBe("a.ts:1 — bug");
  });

  it("fails loud on a missing verdict or missing structured output", () => {
    expect(() =>
      captureReview(result({ review: { structured: { summary: "no verdict" } } }), {}),
    ).toThrow(/no 'verdict'/);
    expect(() => captureReview(result({ review: { output: "prose" } }), {})).toThrow(
      ChainThreadError,
    );
  });
});

describe("reviewIsClean (structured only)", () => {
  it("CLEAN verdict is clean; FINDINGS is not", () => {
    expect(reviewIsClean(result({ review: { structured: { verdict: "CLEAN" } } }))).toBe(true);
    expect(reviewIsClean(result({ review: { structured: { verdict: "FINDINGS" } } }))).toBe(false);
  });

  it("absence is NOT clean — a loop must never stop as if the review passed", () => {
    // (Inverted from the marker era, where an absent ===REVIEW=== read as clean.)
    expect(reviewIsClean(result({ review: { output: "prose, no block" } }))).toBe(false);
    expect(reviewIsClean(undefined)).toBe(false);
  });
});

describe("WORKFLOW_KINDS buildParams (blackboard → fire params)", () => {
  it("feature-pr needs slug + spec, threads optional issueNumber and repo", () => {
    const params = WORKFLOW_KINDS["feature-pr"].buildParams({
      slug: "dark-mode",
      spec: "the spec",
      issueNumber: "7",
      repo: "o/r",
    });
    expect(params).toEqual({ slug: "dark-mode", spec: "the spec", issueNumber: "7", repo: "o/r" });
    expect(() => WORKFLOW_KINDS["feature-pr"].buildParams({ slug: "s" })).toThrow(ChainThreadError);
  });

  it("pr-review needs the captured prNumber", () => {
    expect(WORKFLOW_KINDS["pr-review"].buildParams({ prNumber: "22" })).toEqual({ pr: "22" });
    expect(() => WORKFLOW_KINDS["pr-review"].buildParams({})).toThrow(/structured output/);
  });

  it("revise needs prNumber + slug", () => {
    expect(WORKFLOW_KINDS.revise.buildParams({ prNumber: "22", slug: "s" })).toEqual({
      pr: "22",
      slug: "s",
    });
  });
});

describe("contractFor: declared mappings replace their half of the kind contract", () => {
  const member = {
    kind: "feature-pr" as const,
    captures: { prNumber: "pr", prUrl: "url" },
    inputs: { slug: "slug", spec: "spec" },
  };

  it("generic capture threads mapped structured fields onto the blackboard", () => {
    const data: Blackboard = {};
    contractFor(member).capture(
      result({ "create-pr": { structured: { pr: 42, url: "https://x/pull/42" } } }),
      data,
    );
    expect(data).toEqual({ prNumber: 42, prUrl: "https://x/pull/42" });
  });

  it("generic capture fails loud when the run emitted no structured output", () => {
    expect(() =>
      contractFor(member).capture(result({ implement: { output: "prose" } }), {}),
    ).toThrow(ChainThreadError);
  });

  it("generic capture fails loud when a mapped field is absent (e.g. the PR was skipped)", () => {
    expect(() =>
      contractFor(member).capture(
        result({ "create-pr": { structured: { skipped: "no auth" } } }),
        {},
      ),
    ).toThrow(/no field 'pr'/);
  });

  it("generic buildParams maps blackboard keys to params and threads repo", () => {
    const params = contractFor(member).buildParams({
      slug: "dark-mode",
      spec: "the spec",
      repo: "o/r",
    });
    expect(params).toEqual({ slug: "dark-mode", spec: "the spec", repo: "o/r" });
  });

  it("generic buildParams fails loud on a missing blackboard key", () => {
    expect(() => contractFor(member).buildParams({ slug: "s" })).toThrow(
      /needs 'spec' on the blackboard/,
    );
  });

  it("an undeclared half falls back to the kind's coded contract", () => {
    const half = contractFor({ kind: "pr-review", inputs: { pr: "prNumber" } });
    const data: Blackboard = {};
    half.capture(result({ review: { structured: { verdict: "FINDINGS", summary: "f" } } }), data);
    expect(data.reviewFindings).toBe("f");
    expect(half.buildParams({ prNumber: "7" })).toEqual({ pr: "7" });
  });
});

describe("contractFor: namespaced blackboard (D5)", () => {
  it("namespace-implicit capture writes under the member's own id", () => {
    const member = { kind: "feature-pr" as const, id: "research", captures: { findings: "summary" } };
    const data: Blackboard = { slug: "x" };
    contractFor(member).capture(result({ s: { structured: { summary: "the findings" } } }), data);
    // Written under data.research, NOT flat — the seeded slug is untouched.
    expect(data).toEqual({ slug: "x", research: { findings: "the findings" } });
  });

  it("concurrent members with distinct ids never clobber (both capture the same bbKey)", () => {
    const a = { kind: "feature-pr" as const, id: "a", captures: { val: "n" } };
    const b = { kind: "feature-pr" as const, id: "b", captures: { val: "n" } };
    const data: Blackboard = {};
    contractFor(a).capture(result({ s: { structured: { n: 1 } } }), data);
    contractFor(b).capture(result({ s: { structured: { n: 2 } } }), data);
    expect(data).toEqual({ a: { val: 1 }, b: { val: 2 } });
  });

  it("without an id, declared captures still thread FLAT (degenerate one-member-per-stage)", () => {
    const member = { kind: "feature-pr" as const, captures: { findings: "summary" } };
    const data: Blackboard = {};
    contractFor(member).capture(result({ s: { structured: { summary: "flat" } } }), data);
    expect(data).toEqual({ findings: "flat" });
  });

  it("namespace-explicit input reads a dotted member.field path", () => {
    const reader = {
      kind: "feature-pr" as const,
      inputs: { slug: "slug", spec: "research.findings" },
    };
    const data: Blackboard = { slug: "x", research: { findings: "the findings" } };
    // spec resolves the two-hop namespaced path; slug is a flat one-hop (chain seed).
    expect(contractFor(reader).buildParams(data)).toEqual({ slug: "x", spec: "the findings" });
  });

  it("a dotted input fails loud when the referenced member.field is absent", () => {
    const reader = { kind: "feature-pr" as const, inputs: { spec: "research.findings" } };
    expect(() => contractFor(reader).buildParams({ research: {} })).toThrow(
      /needs 'research.findings'/,
    );
  });
});

describe("loopIsClean", () => {
  const untilMember = {
    kind: "pr-review" as const,
    until: { path: "verdict", equals: "CLEAN" },
  };

  it("declared until: satisfied when the structured field matches", () => {
    expect(loopIsClean(untilMember, result({ review: { structured: { verdict: "CLEAN" } } }))).toBe(
      true,
    );
  });

  it("declared until: NOT satisfied on mismatch or missing structured output (budget backstop)", () => {
    expect(
      loopIsClean(untilMember, result({ review: { structured: { verdict: "FINDINGS" } } })),
    ).toBe(false);
    expect(loopIsClean(untilMember, result({ review: { output: "prose" } }))).toBe(false);
  });

  it("undeclared until falls back to the kind's reviewIsClean verdict check", () => {
    expect(
      loopIsClean({ kind: "pr-review" }, result({ review: { structured: { verdict: "CLEAN" } } })),
    ).toBe(true);
    expect(
      loopIsClean(
        { kind: "pr-review" },
        result({ review: { structured: { verdict: "FINDINGS" } } }),
      ),
    ).toBe(false);
  });
});

describe("agent-panel kind (multi-agent panel as a chain member)", () => {
  it("buildParams reads a task off the blackboard", () => {
    expect(WORKFLOW_KINDS["agent-panel"].buildParams({ task: "design the codex integration" })).toEqual({
      task: "design the codex integration",
    });
  });

  it("buildParams fails loud when no task is on the blackboard", () => {
    expect(() => WORKFLOW_KINDS["agent-panel"].buildParams({})).toThrow(ChainThreadError);
  });

  it("capturePanel threads consensus + best onto the blackboard", () => {
    const data: Blackboard = {};
    capturePanel(
      result({
        synthesize: { structured: { consensus: "use exec --json", best: "claude", disagreements: "" } },
      }),
      data,
    );
    expect(data.consensus).toBe("use exec --json");
    expect(data.best).toBe("claude");
  });

  it("capturePanel fails loud when the synthesis emitted no consensus", () => {
    expect(() =>
      capturePanel(result({ synthesize: { structured: { best: "merged" } } }), {}),
    ).toThrow(ChainThreadError);
  });

  it("a parallel panel's explicit captures + id namespace under data[id] (no clobber of the flat consensus)", () => {
    const data: Blackboard = { consensus: "flat-from-a-lone-member" };
    const contract = contractFor({
      kind: "agent-panel",
      id: "design",
      captures: { consensus: "consensus", best: "best" },
    });
    contract.capture(
      result({ synthesize: { structured: { consensus: "namespaced answer", best: "pi" } } }),
      data,
    );
    expect(data.design).toEqual({ consensus: "namespaced answer", best: "pi" });
    expect(data.consensus).toBe("flat-from-a-lone-member"); // untouched
  });
});
