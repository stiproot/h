import { describe, expect, it } from "vitest";

import { buildInvocationResult } from "./parse-stream.ts";
import { foldQuota, parseRateLimitEvent } from "./quota.ts";
import type { StreamEvent } from "./types.ts";

const AT = new Date("2026-09-02T10:00:00.000Z");

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
  it("reads every window from unifiedWindows, resetsAt as ISO", () => {
    expect(parseRateLimitEvent(unified(0.42), AT)).toEqual({
      status: "allowed",
      windows: {
        five_hour: { utilization: 0.42, resetsAt: "2026-09-02T23:20:00.000Z" },
        seven_day: { utilization: 0.14, resetsAt: "2026-09-08T19:00:00.000Z" },
      },
      observedAt: AT.toISOString(),
    });
  });

  it("reads the legacy flattened shape as the one window it names", () => {
    expect(parseRateLimitEvent(legacy, AT)).toEqual({
      status: "allowed_warning",
      windows: { five_hour: { utilization: 0.91, resetsAt: "2026-09-02T23:20:00.000Z" } },
      observedAt: AT.toISOString(),
    });
  });

  it("reads a rejected event — the limit itself — with utilization 1", () => {
    const rejected = unified(1, 0.14, "rejected");
    expect(parseRateLimitEvent(rejected, AT)?.status).toBe("rejected");
    expect(parseRateLimitEvent(rejected, AT)?.windows.five_hour?.utilization).toBe(1);
  });

  it("skips events that are not quota, or carry nothing readable (a null status was seen live)", () => {
    expect(parseRateLimitEvent({ type: "assistant" }, AT)).toBeUndefined();
    expect(
      parseRateLimitEvent(
        { type: "rate_limit_event", rate_limit_info: { status: null } } as unknown as StreamEvent,
        AT,
      ),
    ).toBeUndefined();
    expect(
      parseRateLimitEvent(
        { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } as StreamEvent,
        AT,
      ),
    ).toBeUndefined();
  });
});

describe("foldQuota", () => {
  it("keeps the last state and charges the run last − first within one window instance", () => {
    const report = foldQuota([
      parseRateLimitEvent(unified(0.4, 0.1), AT)!,
      parseRateLimitEvent(unified(0.43, 0.1), AT)!,
      parseRateLimitEvent(unified(0.47, 0.11, "allowed_warning"), AT)!,
    ]);
    expect(report?.status).toBe("allowed_warning");
    expect(report?.windows.five_hour?.utilization).toBe(0.47);
    expect(report?.spent.five_hour).toBeCloseTo(0.07);
    expect(report?.spent.seven_day).toBeCloseTo(0.01);
  });

  it("charges the last utilization alone when the window reset mid-run", () => {
    const before = parseRateLimitEvent(unified(0.9), AT)!;
    const after: ReturnType<typeof parseRateLimitEvent> = {
      ...before,
      windows: { five_hour: { utilization: 0.05, resetsAt: "2026-09-02T16:20:00.000Z" } },
    };
    expect(foldQuota([before, after])?.spent.five_hour).toBe(0.05);
  });

  it("accumulates windows across shapes and yields nothing for a stream with no observation", () => {
    const report = foldQuota([
      parseRateLimitEvent(legacy, AT)!,
      parseRateLimitEvent(unified(0.92), AT)!,
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
    const without = buildInvocationResult({ events: [], stderr: "", exitCode: 0, signal: null });
    expect(without.quota).toBeUndefined();
  });
});
