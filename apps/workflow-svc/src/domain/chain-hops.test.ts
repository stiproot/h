import { describe, expect, it } from "vitest";

import {
  afterMarker,
  type Blackboard,
  capturePr,
  ChainThreadError,
  HOP_KINDS,
  reviewIsClean,
  stepOutputs,
} from "./chain-hops.ts";

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

describe("HOP_KINDS.feature-pr", () => {
  it("builds slug/spec params and passes issueNumber through when present", () => {
    const params = HOP_KINDS["feature-pr"].buildParams({
      slug: "x",
      spec: "do it",
      issueNumber: "7",
    });
    expect(params).toEqual({ slug: "x", spec: "do it", issueNumber: "7" });
  });

  it("omits issueNumber when absent", () => {
    expect(HOP_KINDS["feature-pr"].buildParams({ slug: "x", spec: "do it" })).toEqual({
      slug: "x",
      spec: "do it",
    });
  });

  it("throws when a required input is missing", () => {
    expect(() => HOP_KINDS["feature-pr"].buildParams({ slug: "x" })).toThrow(ChainThreadError);
  });
});

describe("HOP_KINDS.pr-review", () => {
  it("maps the captured prNumber to the pr param", () => {
    expect(HOP_KINDS["pr-review"].buildParams({ prNumber: "22" })).toEqual({ pr: "22" });
  });

  it("throws a clear error when the previous hop produced no PR number", () => {
    expect(() => HOP_KINDS["pr-review"].buildParams({})).toThrow(/needs a PR number/);
  });
});

describe("HOP_KINDS.revise", () => {
  it("folds the review findings into the spec preamble", () => {
    const params = HOP_KINDS.revise.buildParams({ slug: "x", reviewFindings: "file.ts:12 — bug" });
    expect(params.slug).toBe("x");
    expect(String(params.spec)).toContain("===REVIEW SUMMARY===");
    expect(String(params.spec)).toContain("file.ts:12 — bug");
  });

  it("uses a placeholder when there were no findings (a CLEAN review)", () => {
    const params = HOP_KINDS.revise.buildParams({ slug: "x", reviewFindings: "" });
    expect(String(params.spec)).toContain("(no findings reported)");
  });
});
