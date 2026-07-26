import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CronRow, cronId } from "./cron.model.ts";

describe("cronId", () => {
  it("is the coord tuple <repo>:<slug>:<workflow> — mirroring the wf: coords it recurs", () => {
    expect(cronId({ repo: "stiproot/h", slug: "pi-agent", workflow: "revise-pr" })).toBe(
      "stiproot/h:pi-agent:revise-pr",
    );
  });
});

describe("CronRow", () => {
  const decode = Schema.decodeUnknownSync(CronRow, { onExcessProperty: "preserve" });
  const base = {
    repo: "stiproot/h",
    slug: "pi-agent",
    workflow: "revise-pr",
    status: "active",
    cadence: "*/30 * * * *",
    budget: { maxFires: 100 },
    instanceId: "revise-pi-agent",
    epoch: 1,
    fires: 0,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:00:00Z",
  };

  it("decodes a saved-source cron (mode 1: key + fixed params)", () => {
    const row = decode({ ...base, source: { mode: "saved", key: "revise-pr", params: { pr: "30" } } });
    expect(row.status).toBe("active");
    expect(row.source.mode).toBe("saved");
    expect(row.budget.maxFires).toBe(100);
  });

  it("decodes an embedded-source cron (mode 2: hydrated steps, no publish)", () => {
    const row = decode({
      ...base,
      source: { mode: "embedded", steps: [{ activity: "run-claude", input: {} }], params: {} },
    });
    expect(row.source.mode).toBe("embedded");
  });

  it("rejects an unknown status (closed literal)", () => {
    expect(() =>
      decode({ ...base, status: "paused", source: { mode: "saved", key: "revise-pr" } }),
    ).toThrow();
  });

  it("rejects an unknown source mode (dynamic is deferred, not in the union)", () => {
    expect(() => decode({ ...base, source: { mode: "dynamic", rule: "x" } })).toThrow();
  });
});
