import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { WfRow, wfIdentityFrom, wfRunKey } from "./wf.model.ts";

describe("wfRunKey", () => {
  it("keys a row by the RUN, so a re-run never overwrites its predecessor", () => {
    expect(wfRunKey("feature-x")).toBe("wf:run:feature-x");
    expect(wfRunKey("feature-x-260817-030000")).toBe("wf:run:feature-x-260817-030000");
  });

  // The flaw the 2026-08-17 re-key removed: two members of one STAGE sharing a kind derived the
  // same artifact key and silently clobbered each other. Distinct instance ids cannot collide.
  it("gives two same-kind members of one stage distinct keys", () => {
    expect(wfRunKey("chain-x-w0")).not.toBe(wfRunKey("chain-x-w1"));
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
