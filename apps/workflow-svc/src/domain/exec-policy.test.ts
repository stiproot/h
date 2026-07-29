import { describe, expect, it } from "vitest";

import { deniedMessage, executorFromActivity, isExecutorDenied } from "./exec-policy.ts";

describe("executorFromActivity", () => {
  it("strips the run- prefix to the executor shortname", () => {
    expect(executorFromActivity("run-codex")).toBe("codex");
    expect(executorFromActivity("run-claude")).toBe("claude");
    expect(executorFromActivity("run-dapr-agent")).toBe("dapr-agent");
    expect(executorFromActivity("run-claude-managed")).toBe("claude-managed");
  });

  it("returns undefined for non-run activities (provisioning is never gated)", () => {
    for (const name of ["setup", "clone-repo", "create-worktree", "write-wf-row", "register-cron"])
      expect(executorFromActivity(name)).toBeUndefined();
  });
});

describe("isExecutorDenied", () => {
  const policy = { denied: ["codex"], updatedAt: "2026-07-29T00:00:00Z" };

  it("denies exactly the listed executors", () => {
    expect(isExecutorDenied(policy, "codex")).toBe(true);
    expect(isExecutorDenied(policy, "claude")).toBe(false);
  });

  it("allows everything when the row is absent or the list is empty (deny is explicit)", () => {
    expect(isExecutorDenied(undefined, "codex")).toBe(false);
    expect(isExecutorDenied({ denied: [], updatedAt: "" }, "codex")).toBe(false);
  });
});

describe("deniedMessage", () => {
  it("names the executor and the way back out", () => {
    expect(deniedMessage("codex")).toContain("'codex'");
    expect(deniedMessage("codex")).toContain("h agents allow codex");
  });
});
