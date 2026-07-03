import { describe, expect, it } from "vitest";

import { assertValidCron, isDue } from "./scheduling.ts";
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
