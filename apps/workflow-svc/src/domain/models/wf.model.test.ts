import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { WfRow, wfKey } from "./wf.model.ts";

describe("wfKey", () => {
  it("composes wf:<repo>:<slug>:<workflow> — the workflow is the leaf (its sole writer)", () => {
    expect(wfKey({ repo: "stiproot/h", slug: "pi-agent", workflow: "revise" })).toBe(
      "wf:stiproot/h:pi-agent:revise",
    );
  });

  it("keeps repo + slug as segments so targets never collide across repos", () => {
    expect(wfKey({ repo: "acme/api", slug: "dark-mode", workflow: "feature-pr" })).toBe(
      "wf:acme/api:dark-mode:feature-pr",
    );
  });
});

describe("WfRow", () => {
  const decode = Schema.decodeUnknownSync(WfRow, { onExcessProperty: "preserve" });

  it("decodes a row and carries the subject + output", () => {
    const row = decode({
      repo: "stiproot/h",
      slug: "pi-agent",
      workflow: "revise",
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
      decode({ repo: "r", slug: "s", workflow: "w", status: "bogus", instanceId: "i", updatedAt: "t" }),
    ).toThrow();
  });
});
