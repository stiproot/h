import { describe, expect, it } from "vitest";

import {
  afterMarker,
  type Blackboard,
  capturePr,
  ChainThreadError,
  WORKFLOW_KINDS,
  reviewIsClean,
  stepOutputs,
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
