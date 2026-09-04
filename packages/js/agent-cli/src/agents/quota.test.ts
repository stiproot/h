import { describe, expect, it } from "vitest";

import { buildInvocationResult } from "./parse-stream.ts";
import { foldQuota, parseRateLimitEvent } from "./quota.ts";
import type { StreamEvent } from "./types.ts";

const AT = new Date("2026-09-02T10:00:00.000Z");
const UTC_OFFSET = 0;
const SAST_OFFSET = 120;
const CODEX_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:13 PM.";
const codexLimitAt = (time: string) => ({
  type: "error",
  message: `You've hit your usage limit. Try again at ${time}.`,
});

// The two shapes verified live in the run ledger (2026-09-02): the unified one newer claude CLIs
// emit, and the flattened single-window one older CLIs emit.
const unified = (five: number, seven = 0.14, status = "allowed"): StreamEvent =>
  ({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt: 1788391200,
      rateLimitType: "five_hour",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: five, resetsAt: 1788391200 },
        seven_day: { utilization: seven, resetsAt: 1788894000 },
      },
    },
  }) as unknown as StreamEvent;

const legacy: StreamEvent = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    resetsAt: 1788391200,
    rateLimitType: "five_hour",
    utilization: 0.91,
    surpassedThreshold: 0.9,
  },
} as unknown as StreamEvent;

describe("parseRateLimitEvent", () => {
  it.each([
    { type: "error", message: CODEX_LIMIT },
    { type: "turn.failed", error: { message: CODEX_LIMIT } },
    { type: "error", result: CODEX_LIMIT },
    { type: "result", is_error: true, result: CODEX_LIMIT },
  ])("reads the same reset from Codex raw and normalized shape %#", (event) => {
    const observedAt = new Date("2026-09-04T09:50:00.000Z"); // 11:50 SAST
    expect(parseRateLimitEvent(event, observedAt, SAST_OFFSET)).toEqual({
      status: "rejected",
      windows: {
        five_hour: { utilization: 1, resetsAt: "2026-09-04T10:13:00.000Z" },
      },
      observedAt: observedAt.toISOString(),
    });
  });

  it("rolls an already-passed Codex wall-clock reset into the next local day", () => {
    const observedAt = new Date("2026-09-04T10:30:00.000Z"); // 12:30 SAST
    expect(
      parseRateLimitEvent({ type: "error", message: CODEX_LIMIT }, observedAt, SAST_OFFSET),
    ).toEqual({
      status: "rejected",
      windows: {
        five_hour: { utilization: 1, resetsAt: "2026-09-05T10:13:00.000Z" },
      },
      observedAt: observedAt.toISOString(),
    });
  });

  it("parses 12 AM and 24-hour reset times", () => {
    const observedAt = new Date("2026-09-04T09:50:00.000Z"); // 11:50 SAST
    expect(
      parseRateLimitEvent(codexLimitAt("12:05am"), observedAt, SAST_OFFSET)?.windows.five_hour,
    ).toEqual({ utilization: 1, resetsAt: "2026-09-04T22:05:00.000Z" });
    expect(
      parseRateLimitEvent(codexLimitAt("13:07"), observedAt, SAST_OFFSET)?.windows.five_hour,
    ).toEqual({ utilization: 1, resetsAt: "2026-09-04T11:07:00.000Z" });
  });

  it("skips Codex limit text without a time and non-limit Codex events", () => {
    expect(
      parseRateLimitEvent({ type: "error", message: "You've hit your usage limit." }, AT, 0),
    ).toBeUndefined();
    expect(
      parseRateLimitEvent({ type: "error", message: "Connection reset by peer." }, AT, 0),
    ).toBeUndefined();
    expect(parseRateLimitEvent({ type: "item.completed" }, AT, 0)).toBeUndefined();
    expect(parseRateLimitEvent(codexLimitAt("13:05 PM"), AT, UTC_OFFSET)).toBeUndefined();
    expect(parseRateLimitEvent(codexLimitAt("24:00"), AT, UTC_OFFSET)).toBeUndefined();
  });

  it("reads every window from unifiedWindows, resetsAt as ISO", () => {
    expect(parseRateLimitEvent(unified(0.42), AT, UTC_OFFSET)).toEqual({
      status: "allowed",
      windows: {
        five_hour: { utilization: 0.42, resetsAt: "2026-09-02T23:20:00.000Z" },
        seven_day: { utilization: 0.14, resetsAt: "2026-09-08T19:00:00.000Z" },
      },
      observedAt: AT.toISOString(),
    });
  });

  it("reads the legacy flattened shape as the one window it names", () => {
    expect(parseRateLimitEvent(legacy, AT, UTC_OFFSET)).toEqual({
      status: "allowed_warning",
      windows: { five_hour: { utilization: 0.91, resetsAt: "2026-09-02T23:20:00.000Z" } },
      observedAt: AT.toISOString(),
    });
  });

  it("reads a rejected event — the limit itself — with utilization 1", () => {
    const rejected = unified(1, 0.14, "rejected");
    expect(parseRateLimitEvent(rejected, AT, UTC_OFFSET)?.status).toBe("rejected");
    expect(parseRateLimitEvent(rejected, AT, UTC_OFFSET)?.windows.five_hour?.utilization).toBe(1);
  });

  it("skips events that are not quota, or carry nothing readable (a null status was seen live)", () => {
    expect(parseRateLimitEvent({ type: "assistant" }, AT, UTC_OFFSET)).toBeUndefined();
    expect(
      parseRateLimitEvent(
        { type: "rate_limit_event", rate_limit_info: { status: null } } as unknown as StreamEvent,
        AT,
        UTC_OFFSET,
      ),
    ).toBeUndefined();
    expect(
      parseRateLimitEvent(
        { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } as StreamEvent,
        AT,
        UTC_OFFSET,
      ),
    ).toBeUndefined();
  });
});

describe("foldQuota", () => {
  it("keeps the last state and charges the run last − first within one window instance", () => {
    const report = foldQuota([
      parseRateLimitEvent(unified(0.4, 0.1), AT, UTC_OFFSET)!,
      parseRateLimitEvent(unified(0.43, 0.1), AT, UTC_OFFSET)!,
      parseRateLimitEvent(unified(0.47, 0.11, "allowed_warning"), AT, UTC_OFFSET)!,
    ]);
    expect(report?.status).toBe("allowed_warning");
    expect(report?.windows.five_hour?.utilization).toBe(0.47);
    expect(report?.spent.five_hour).toBeCloseTo(0.07);
    expect(report?.spent.seven_day).toBeCloseTo(0.01);
  });

  it("charges the last utilization alone when the window reset mid-run", () => {
    const before = parseRateLimitEvent(unified(0.9), AT, UTC_OFFSET)!;
    const after: ReturnType<typeof parseRateLimitEvent> = {
      ...before,
      windows: { five_hour: { utilization: 0.05, resetsAt: "2026-09-02T16:20:00.000Z" } },
    };
    expect(foldQuota([before, after])?.spent.five_hour).toBe(0.05);
  });

  it("accumulates windows across shapes and yields nothing for a stream with no observation", () => {
    const report = foldQuota([
      parseRateLimitEvent(legacy, AT, UTC_OFFSET)!,
      parseRateLimitEvent(unified(0.92), AT, UTC_OFFSET)!,
    ]);
    expect(Object.keys(report?.windows ?? {}).sort()).toEqual(["five_hour", "seven_day"]);
    expect(foldQuota([])).toBeUndefined();
  });
});

describe("buildInvocationResult carries the folded quota", () => {
  it("attaches `quota` when the stream reported it, omits it otherwise", () => {
    const withQuota = buildInvocationResult({
      events: [
        unified(0.4),
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        unified(0.45),
      ],
      stderr: "",
      exitCode: 0,
      signal: null,
    });
    expect(withQuota.quota?.windows.five_hour?.utilization).toBe(0.45);
    expect(withQuota.quota?.spent.five_hour).toBeCloseTo(0.05);
    const codex = buildInvocationResult({
      events: [{ type: "result", is_error: true, result: CODEX_LIMIT }],
      stderr: "",
      exitCode: 1,
      signal: null,
    });
    expect(codex.quota?.status).toBe("rejected");
    const without = buildInvocationResult({ events: [], stderr: "", exitCode: 0, signal: null });
    expect(without.quota).toBeUndefined();
  });
});
