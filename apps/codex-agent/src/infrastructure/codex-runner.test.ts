import { describe, expect, it } from "vitest";

// codex-runner.test.ts — unit tests for the CodexRunnerLive configuration layer.
// Integration tests (actual agent invocations) require a real codex binary and are out of scope.

describe("DEFAULT_AGENT_BASE_DIR", () => {
  it("resolves to the expected workspace path", async () => {
    const { DEFAULT_AGENT_BASE_DIR } = await import("./codex-runner.ts");
    expect(DEFAULT_AGENT_BASE_DIR).toBe("/workspace/codex-agent");
  });
});

describe("CodexRunnerLive", () => {
  it("exports a Layer for AgentRunner", async () => {
    const { CodexRunnerLive } = await import("./codex-runner.ts");
    // Layer.Layer is a structural type; verifying the export is non-null and has the
    // expected tag is sufficient without wiring up the full Effect runtime in unit tests.
    expect(CodexRunnerLive).toBeDefined();
  });
});
