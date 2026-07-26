import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { WfRow, wfIdentityFrom, wfKey } from "./wf.model.ts";

describe("wfKey", () => {
  it("composes wf:<repo>:<slug>:<workflow> — the workflow is the leaf (its sole writer)", () => {
    expect(wfKey({ repo: "stiproot/h", slug: "pi-agent", workflow: "revise-pr" })).toBe(
      "wf:stiproot/h:pi-agent:revise-pr",
    );
  });

  it("keeps repo + slug as segments so targets never collide across repos", () => {
    expect(wfKey({ repo: "acme/api", slug: "dark-mode", workflow: "implement-pr" })).toBe(
      "wf:acme/api:dark-mode:implement-pr",
    );
  });
});

describe("wfIdentityFrom", () => {
  it("builds an identity when repo + slug are present (workflow name = the leaf)", () => {
    expect(wfIdentityFrom({ repo: "stiproot/h", slug: "pi-agent", pr: "30" }, "revise-pr")).toEqual(
      {
        repo: "stiproot/h",
        slug: "pi-agent",
        workflow: "revise-pr",
      },
    );
  });

  it("is opt-in — undefined when repo or slug is missing or blank", () => {
    expect(wfIdentityFrom({ slug: "x" }, "implement-pr")).toBeUndefined(); // no repo
    expect(wfIdentityFrom({ repo: "o/r" }, "implement-pr")).toBeUndefined(); // no slug
    expect(wfIdentityFrom({ repo: "  ", slug: "x" }, "implement-pr")).toBeUndefined(); // blank repo
    expect(wfIdentityFrom(undefined, "implement-pr")).toBeUndefined();
    expect(wfIdentityFrom({ repo: "o/r", slug: "x" }, "")).toBeUndefined(); // no workflow name
  });

  it("trims whitespace off the segments", () => {
    expect(wfIdentityFrom({ repo: " o/r ", slug: " x " }, "review-pr")).toEqual({
      repo: "o/r",
      slug: "x",
      workflow: "review-pr",
    });
  });
});

describe("WfRow", () => {
  const decode = Schema.decodeUnknownSync(WfRow, { onExcessProperty: "preserve" });

  it("decodes a row and carries the subject + output", () => {
    const row = decode({
      repo: "stiproot/h",
      slug: "pi-agent",
      workflow: "revise-pr",
      status: "running",
      instanceId: "feature-pi-agent",
      subject: { pr: "30" },
      updatedAt: "2026-07-11T00:00:00Z",
    });
    expect(row.status).toBe("running");
    expect(row.subject).toEqual({ pr: "30" });
  });

  it("rejects an unknown status (closed literal)", () => {
    expect(() =>
      decode({
        repo: "r",
        slug: "s",
        workflow: "w",
        status: "bogus",
        instanceId: "i",
        updatedAt: "t",
      }),
    ).toThrow();
  });
});
