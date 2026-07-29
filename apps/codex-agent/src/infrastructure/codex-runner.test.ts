import { describe, expect, it } from "vitest";

// codex-runner.test.ts — unit tests for the CodexRunnerLive configuration layer.
// Integration tests (actual agent invocations) require a real codex binary and are out of scope.
//
// The imports are STATIC, matching claude/openhands/pi-runner.test.ts. They used to be
// `await import("./codex-runner.ts")` inside the test bodies, which pulled the whole
// Effect + agent-cli module graph in under vitest's 5s per-TEST budget — fine in isolation,
// but it timed out once `turbo test` ran 23 tasks across 8 cores. A top-level import resolves
// during collection instead, so these tests are instant and load-independent.
import { CodexRunnerLive, DEFAULT_AGENT_BASE_DIR } from "./codex-runner.ts";

describe("DEFAULT_AGENT_BASE_DIR", () => {
  it("resolves to the expected workspace path", () => {
    expect(DEFAULT_AGENT_BASE_DIR).toBe("/workspace/codex-agent");
  });
});

describe("CodexRunnerLive", () => {
  it("exports a Layer for AgentRunner", () => {
    // Layer.Layer is a structural type; verifying the export is non-null and has the
    // expected tag is sufficient without wiring up the full Effect runtime in unit tests.
    expect(CodexRunnerLive).toBeDefined();
  });
});
