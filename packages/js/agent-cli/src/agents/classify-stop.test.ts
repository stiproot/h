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
      "You've hit your session limit · resets 4:50pm (Africa/Johannesburg)",
    ]) {
      expect(classifyStop({ exitCode: 1, signal: null, stderr })).toBe("usage-limited");
    }
  });

  it("usage-limited: the Claude CLI session-limit phrasing on exit 0 via the result event", () => {
    // Observed live 2026-08-08: subscription limit mid-run, exit 0, limit text only in the stream.
    expect(
      classifyStop({
        exitCode: 0,
        signal: null,
        stderr: "",
        resultEventText: "You've hit your session limit · resets 4:50pm (Africa/Johannesburg)",
      }),
    ).toBe("usage-limited");
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
    expect(classifyStop({ exitCode: 124, signal: null, stderr: "rate limit" })).toBe("timeout");
  });

  it("usage-limited: a timeout whose stream carried >=3 rate-limit retries is a throttle, not a timeout", () => {
    // The Moonshot $20 day: 429-throttled runs stretched into
    // their 30-min budgets and finalized `timeout`, so the auto-deny fence never saw the limit.
    expect(classifyStop({ exitCode: 124, signal: null, stderr: "", rateLimitRetries: 3 })).toBe(
      "usage-limited",
    );
    expect(
      classifyStop({ exitCode: null, signal: "SIGTERM", stderr: "", rateLimitRetries: 20 }),
    ).toBe("usage-limited");
  });

  it("timeout: fewer than 3 rate-limit retries stays a timeout (one stray retry must not re-route)", () => {
    expect(classifyStop({ exitCode: 124, signal: null, stderr: "", rateLimitRetries: 2 })).toBe(
      "timeout",
    );
  });

  it("rate-limit retries do NOT affect a non-timeout stop (completed stays completed)", () => {
    expect(classifyStop({ exitCode: 0, signal: null, stderr: "", rateLimitRetries: 20 })).toBe(
      "completed",
    );
  });
});
