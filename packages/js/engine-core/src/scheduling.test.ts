import { describe, expect, it } from "vitest";

import { assertValidCron, isDue, parseDurationMs, resolveFireAt } from "./scheduling.ts";
import type { WorkflowSchedule } from "./models/workflow.model.ts";

const at = (iso: string) => new Date(iso);

describe("isDue", () => {
  it("is due when it has never run and the first fire after savedAt has passed", () => {
    const schedule: WorkflowSchedule = { cron: "0 9 * * *", savedAt: "2026-06-23T08:00:00Z" };
    // 09:00 UTC fire after the 08:00 save has elapsed by 10:00.
    expect(isDue(schedule, at("2026-06-23T10:00:00Z"))).toBe(true);
  });

  it("is not due when the next fire after savedAt is still in the future", () => {
    const schedule: WorkflowSchedule = { cron: "0 9 * * *", savedAt: "2026-06-23T08:00:00Z" };
    expect(isDue(schedule, at("2026-06-23T08:30:00Z"))).toBe(false);
  });

  it("is not due right after a run (baseline advances to lastRunAt)", () => {
    const schedule: WorkflowSchedule = {
      cron: "0 9 * * *",
      savedAt: "2026-06-20T08:00:00Z",
      lastRunAt: "2026-06-23T09:00:00Z",
    };
    expect(isDue(schedule, at("2026-06-23T09:00:30Z"))).toBe(false);
  });

  it("becomes due again on the next day", () => {
    const schedule: WorkflowSchedule = {
      cron: "0 9 * * *",
      savedAt: "2026-06-20T08:00:00Z",
      lastRunAt: "2026-06-23T09:00:00Z",
    };
    expect(isDue(schedule, at("2026-06-24T09:00:00Z"))).toBe(true);
  });

  it("fires only once after long downtime (no catch-up storm)", () => {
    // Daily job idle for a week: a single tick sees it due; after stamping lastRunAt=now it is not.
    const schedule: WorkflowSchedule = {
      cron: "0 9 * * *",
      savedAt: "2026-06-10T08:00:00Z",
      lastRunAt: "2026-06-10T09:00:00Z",
    };
    const now = at("2026-06-17T12:00:00Z");
    expect(isDue(schedule, now)).toBe(true);
    const afterStamp: WorkflowSchedule = { ...schedule, lastRunAt: now.toISOString() };
    expect(isDue(afterStamp, at("2026-06-17T12:00:30Z"))).toBe(false);
  });

  it("every-minute schedules are due a minute after the last run", () => {
    const schedule: WorkflowSchedule = {
      cron: "* * * * *",
      savedAt: "2026-06-23T08:00:00Z",
      lastRunAt: "2026-06-23T08:00:00Z",
    };
    expect(isDue(schedule, at("2026-06-23T08:01:05Z"))).toBe(true);
    expect(isDue(schedule, at("2026-06-23T08:00:30Z"))).toBe(false);
  });
});

describe("assertValidCron", () => {
  it("accepts a valid expression", () => {
    expect(() => assertValidCron("0 9 * * *")).not.toThrow();
  });

  it("throws on an invalid expression", () => {
    expect(() => assertValidCron("not a cron")).toThrow();
  });
});

describe("parseDurationMs", () => {
  it("parses each unit", () => {
    expect(parseDurationMs("45s")).toBe(45_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("throws on a missing/unknown unit or non-numeric value", () => {
    expect(() => parseDurationMs("10")).toThrow();
    expect(() => parseDurationMs("10x")).toThrow();
    expect(() => parseDurationMs("2.5h")).toThrow();
    expect(() => parseDurationMs("")).toThrow();
  });
});

describe("resolveFireAt", () => {
  const NOW = new Date("2026-07-18T12:00:00Z").getTime();

  it("resolves a relative `in` to now + duration", () => {
    expect(resolveFireAt({ in: "2h" }, NOW)).toBe("2026-07-18T14:00:00.000Z");
  });

  it("normalizes an absolute `at` instant to ISO", () => {
    expect(resolveFireAt({ at: "2026-07-20T09:00:00Z" }, NOW)).toBe("2026-07-20T09:00:00.000Z");
  });

  it("throws when neither at nor in is given", () => {
    expect(() => resolveFireAt({}, NOW)).toThrow();
  });

  it("throws when both at and in are given", () => {
    expect(() => resolveFireAt({ at: "2026-07-20T09:00:00Z", in: "2h" }, NOW)).toThrow();
  });

  it("throws on an unparseable at instant", () => {
    expect(() => resolveFireAt({ at: "not-a-date" }, NOW)).toThrow();
  });
});
