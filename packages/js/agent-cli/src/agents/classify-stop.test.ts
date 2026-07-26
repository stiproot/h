import { describe, expect, it } from "vitest";

import { classifyStop } from "./classify-stop.ts";

describe("classifyStop", () => {
  it("completed: clean exit 0 with no limit markers", () => {
    expect(classifyStop({ exitCode: 0, signal: null, stderr: "" })).toBe("completed");
  });

  it("failed: non-zero exit with no limit markers", () => {
    expect(classifyStop({ exitCode: 1, signal: null, stderr: "TypeError: boom" })).toBe("failed");
  });

  it("timeout: killed by signal, or the synthetic exit 124", () => {
    expect(classifyStop({ exitCode: null, signal: "SIGTERM", stderr: "" })).toBe("timeout");
    expect(classifyStop({ exitCode: 124, signal: null, stderr: "Task timed out" })).toBe("timeout");
  });

  it("usage-limited: rate-limit / 429 / quota / overloaded in stderr", () => {
    for (const stderr of [
      "Error: 429 Too Many Requests",
      "anthropic rate_limit_error",
      "overloaded_error: server busy",
      "OpenAI insufficient_quota",
      "RateLimitError: retry later",
      "You have hit your usage limit",
    ]) {
      expect(classifyStop({ exitCode: 1, signal: null, stderr })).toBe("usage-limited");
    }
  });

  it("usage-limited even on exit 0 when the terminal result event carries the limit (Claude CLI)", () => {
    // The claude CLI can emit {type:"result", is_error:true} with the limit text while exiting 0.
    expect(
      classifyStop({
        exitCode: 0,
        signal: null,
        stderr: "",
        resultEventText: "Claude AI usage limit reached — try again later",
      }),
    ).toBe("usage-limited");
  });

  it("NOT usage-limited: a context-window overflow (a different agent would overflow too)", () => {
    expect(
      classifyStop({
        exitCode: 1,
        signal: null,
        stderr: "prompt is too long: maximum context length exceeded (ContextWindowExceeded)",
      }),
    ).toBe("failed");
  });

  it("timeout wins over a usage marker (a killed process is a timeout, not a limit)", () => {
    expect(
      classifyStop({ exitCode: 124, signal: null, stderr: "rate limit" }),
    ).toBe("timeout");
  });
});
