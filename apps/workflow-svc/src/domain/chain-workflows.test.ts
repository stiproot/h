import { describe, expect, it } from "vitest";

import {
  afterMarker,
  type Blackboard,
  capturePr,
  captureReview,
  ChainThreadError,
  contractFor,
  loopIsClean,
  WORKFLOW_KINDS,
  reviewIsClean,
  stepOutputs,
  stepStructured,
} from "./chain-workflows.ts";

// A workflow result as the generic workflow returns it: { <stepId>: { output: "..." }, ... }.
function result(outputs: Record<string, string>): string {
  const obj: Record<string, { output: string }> = {};
  for (const [k, v] of Object.entries(outputs)) obj[k] = { output: v };
  return JSON.stringify(obj);
}

describe("stepOutputs: unwraps the Dapr double-encoding", () => {
  const single = result({ implement: "did the work\n===PR===\nhttps://github.com/o/r/pull/42" });

  it("reads a single-encoded result", () => {
    expect(stepOutputs(single)).toEqual(["did the work\n===PR===\nhttps://github.com/o/r/pull/42"]);
  });

  it("reads a DOUBLE-encoded result (Dapr re-serializes the workflow's own JSON string)", () => {
    // The bug Phase 1's mocks hid and the live run caught: output is a JSON string of a JSON string.
    expect(stepOutputs(JSON.stringify(single))).toEqual([
      "did the work\n===PR===\nhttps://github.com/o/r/pull/42",
    ]);
  });

  it("returns [] on non-JSON or non-object payloads", () => {
    expect(stepOutputs(undefined)).toEqual([]);
    expect(stepOutputs("not json{")).toEqual([]);
    expect(stepOutputs(JSON.stringify("just a string"))).toEqual([]);
  });
});

describe("afterMarker", () => {
  it("returns the trimmed text after the marker in whichever step carries it", () => {
    const out = result({ plan: "no marker here", review: "===REVIEW===\nfile.ts:12 — bug" });
    expect(afterMarker(out, "===REVIEW===")).toBe("file.ts:12 — bug");
  });

  it("returns undefined when no step carries the marker", () => {
    expect(afterMarker(result({ plan: "nothing" }), "===PR===")).toBeUndefined();
  });
});

describe("capturePr", () => {
  it("threads prUrl and the prNumber parsed from /pull/<n>", () => {
    const data: Blackboard = {};
    capturePr(result({ implement: "===PR===\nhttps://github.com/stiproot/h/pull/22\nmore" }), data);
    expect(data.prUrl).toBe("https://github.com/stiproot/h/pull/22");
    expect(data.prNumber).toBe("22");
  });

  it("threads a SKIPPED tail as prUrl with no prNumber (no /pull/ match)", () => {
    const data: Blackboard = {};
    capturePr(result({ implement: "===PR===\nSKIPPED — GH_TOKEN unset" }), data);
    expect(data.prUrl).toBe("SKIPPED — GH_TOKEN unset");
    expect(data.prNumber).toBeUndefined();
  });
});

describe("reviewIsClean (loop-until-clean predicate)", () => {
  it("is clean when the review reports CLEAN", () => {
    expect(reviewIsClean(result({ review: "reviewed\n===REVIEW===\nCLEAN" }))).toBe(true);
    expect(reviewIsClean(result({ review: "===REVIEW===\n  clean  " }))).toBe(true);
  });

  it("is clean when there is no marker or an empty tail (nothing to address)", () => {
    expect(reviewIsClean(result({ review: "no marker" }))).toBe(true);
    expect(reviewIsClean(result({ review: "===REVIEW===\n" }))).toBe(true);
    expect(reviewIsClean(undefined)).toBe(true);
  });

  it("is NOT clean when the review lists findings", () => {
    expect(reviewIsClean(result({ review: "===REVIEW===\nsrc/x.ts:9 — missing guard" }))).toBe(
      false,
    );
  });
});

describe("WORKFLOW_KINDS.feature-pr", () => {
  it("builds slug/spec params and passes issueNumber through when present", () => {
    const params = WORKFLOW_KINDS["feature-pr"].buildParams({
      slug: "x",
      spec: "do it",
      issueNumber: "7",
    });
    expect(params).toEqual({ slug: "x", spec: "do it", issueNumber: "7" });
  });

  it("omits issueNumber when absent", () => {
    expect(WORKFLOW_KINDS["feature-pr"].buildParams({ slug: "x", spec: "do it" })).toEqual({
      slug: "x",
      spec: "do it",
    });
  });

  it("throws when a required input is missing", () => {
    expect(() => WORKFLOW_KINDS["feature-pr"].buildParams({ slug: "x" })).toThrow(ChainThreadError);
  });
});

describe("WORKFLOW_KINDS.pr-review", () => {
  it("maps the captured prNumber to the pr param", () => {
    expect(WORKFLOW_KINDS["pr-review"].buildParams({ prNumber: "22" })).toEqual({ pr: "22" });
  });

  it("throws a clear error when the previous workflow produced no PR number", () => {
    expect(() => WORKFLOW_KINDS["pr-review"].buildParams({})).toThrow(/needs a PR number/);
  });
});

describe("WORKFLOW_KINDS.revise", () => {
  it("threads only the durable references — the PR number + slug (revise reads the review itself)", () => {
    const params = WORKFLOW_KINDS.revise.buildParams({
      slug: "x",
      prNumber: "22",
      reviewFindings: "file.ts:12 — bug", // present on the blackboard, but revise does NOT use it
    });
    expect(params).toEqual({ pr: "22", slug: "x" });
  });

  it("throws when there is no PR number on the blackboard", () => {
    expect(() => WORKFLOW_KINDS.revise.buildParams({ slug: "x" })).toThrow(/needs a PR number/);
  });
});

describe("WORKFLOW_KINDS: repo threading (the wf-identity segment + pr-review's review target)", () => {
  it("threads a chain-level repo into every member's params when the blackboard carries it", () => {
    expect(WORKFLOW_KINDS["feature-pr"].buildParams({ slug: "x", spec: "s", repo: "o/r" })).toEqual(
      {
        slug: "x",
        spec: "s",
        repo: "o/r",
      },
    );
    expect(WORKFLOW_KINDS["pr-review"].buildParams({ prNumber: "22", repo: "o/r" })).toEqual({
      pr: "22",
      repo: "o/r",
    });
    expect(WORKFLOW_KINDS.revise.buildParams({ prNumber: "22", slug: "x", repo: "o/r" })).toEqual({
      pr: "22",
      slug: "x",
      repo: "o/r",
    });
  });

  it("omits repo when the blackboard has none (opt-in)", () => {
    expect(WORKFLOW_KINDS["pr-review"].buildParams({ prNumber: "22" })).toEqual({ pr: "22" });
  });
});

// A workflow result whose steps carry validated `structured` envelopes (the rung-2 seam's output).
function structuredResult(
  steps: Record<string, { output?: string; structured?: unknown }>,
): string {
  return JSON.stringify(steps);
}

describe("stepStructured: merges validated structured envelopes", () => {
  const single = structuredResult({
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
    const out = structuredResult({
      review: { structured: { verdict: "FINDINGS", summary: "old" } },
      revise: { structured: { summary: "new" } },
    });
    expect(stepStructured(out)).toEqual({ verdict: "FINDINGS", summary: "new" });
  });

  it("returns undefined when no step carries structured output (a marker-era run)", () => {
    expect(stepStructured(result({ implement: "===PR===\nhttps://x/pull/1" }))).toBeUndefined();
    expect(stepStructured(undefined)).toBeUndefined();
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
      structuredResult({ "create-pr": { structured: { pr: 42, url: "https://x/pull/42" } } }),
      data,
    );
    expect(data).toEqual({ prNumber: 42, prUrl: "https://x/pull/42" });
  });

  it("generic capture fails loud when the run emitted no structured output", () => {
    const data: Blackboard = {};
    expect(() => contractFor(member).capture(result({ implement: "prose" }), data)).toThrow(
      ChainThreadError,
    );
  });

  it("generic capture fails loud when a mapped field is absent (e.g. the PR was skipped)", () => {
    expect(() =>
      contractFor(member).capture(
        structuredResult({ "create-pr": { structured: { skipped: "no auth" } } }),
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
    const markerHalf = contractFor({ kind: "pr-review", inputs: { pr: "prNumber" } });
    const data: Blackboard = {};
    // capture half undeclared → the coded captureReview marker parser still runs.
    markerHalf.capture(result({ review: "===REVIEW===\nfindings here" }), data);
    expect(data.reviewFindings).toBe("findings here");
    // inputs half declared → generic mapping.
    expect(markerHalf.buildParams({ prNumber: "7" })).toEqual({ pr: "7" });
  });

  it("no mappings at all → exactly the kind contract (markers, D1 fallback)", () => {
    const data: Blackboard = {};
    contractFor({ kind: "feature-pr" }).capture(
      result({ implement: "===PR===\nhttps://github.com/o/r/pull/9" }),
      data,
    );
    expect(data.prNumber).toBe("9");
  });
});

describe("loopIsClean", () => {
  const untilMember = {
    kind: "pr-review" as const,
    until: { path: "verdict", equals: "CLEAN" },
  };

  it("declared until: satisfied when the structured field matches", () => {
    const out = structuredResult({ review: { structured: { verdict: "CLEAN" } } });
    expect(loopIsClean(untilMember, out)).toBe(true);
  });

  it("declared until: NOT satisfied on a mismatch or missing structured output (budget backstop)", () => {
    expect(
      loopIsClean(
        untilMember,
        structuredResult({ review: { structured: { verdict: "FINDINGS" } } }),
      ),
    ).toBe(false);
    expect(loopIsClean(untilMember, result({ review: "===REVIEW===\nCLEAN" }))).toBe(false);
  });

  it("undeclared until falls back to the coded reviewIsClean marker sniff", () => {
    expect(loopIsClean({ kind: "pr-review" }, result({ review: "===REVIEW===\nCLEAN" }))).toBe(
      true,
    );
    expect(loopIsClean({ kind: "pr-review" }, result({ review: "===REVIEW===\nbug at x" }))).toBe(
      false,
    );
  });
});

describe("kind contracts are structured-first with marker fallback (D1)", () => {
  it("capturePr prefers the validated structured block over the marker", () => {
    const data: Blackboard = {};
    capturePr(
      structuredResult({
        "create-pr": {
          output: "===PR===\nhttps://stale/pull/1", // a lying marker must NOT win
          structured: { pr: 42, url: "https://x/pull/42" },
        },
      }),
      data,
    );
    expect(data.prNumber).toBe("42"); // blackboard convention: prNumber is a string
    expect(data.prUrl).toBe("https://x/pull/42");
  });

  it("capturePr on a structured skip sets nothing — downstream fails loud, like a SKIPPED tail", () => {
    const data: Blackboard = {};
    capturePr(
      structuredResult({ "create-pr": { structured: { skipped: "GH_TOKEN unset" } } }),
      data,
    );
    expect(data.prNumber).toBeUndefined();
    expect(data.prUrl).toBeUndefined();
  });

  it("capturePr ignores an unrelated structured block and falls back to the marker", () => {
    const data: Blackboard = {};
    capturePr(
      structuredResult({
        verify: { output: "===PR===\nhttps://github.com/o/r/pull/7", structured: { other: 1 } },
      }),
      data,
    );
    expect(data.prNumber).toBe("7");
  });

  it("captureReview threads the structured summary; CLEAN means empty findings", () => {
    const clean: Blackboard = {};
    captureReview(
      structuredResult({ review: { structured: { verdict: "CLEAN", summary: "ignored" } } }),
      clean,
    );
    expect(clean.reviewFindings).toBe("");
    const findings: Blackboard = {};
    captureReview(
      structuredResult({
        review: { structured: { verdict: "FINDINGS", summary: "a.ts:1 — bug" } },
      }),
      findings,
    );
    expect(findings.reviewFindings).toBe("a.ts:1 — bug");
  });

  it("reviewIsClean trusts the structured verdict over a contradicting marker", () => {
    const out = structuredResult({
      review: { output: "===REVIEW===\nCLEAN", structured: { verdict: "FINDINGS" } },
    });
    expect(reviewIsClean(out)).toBe(false);
  });
});
