import { describe, expect, it } from "vitest";

import { type RegisterCronInput, planCron } from "./register-cron.activity.ts";

const base: RegisterCronInput = {
  workflow: "revise",
  repo: "stiproot/h",
  slug: "issue-42",
  cadence: "0 */6 * * *",
  maxFires: 20,
};

describe("planCron (the arm-* decision)", () => {
  it("arms unconditionally when there is no PR guard", () => {
    const plan = planCron(base);
    expect(plan.armed).toBe(true);
    if (!plan.armed) throw new Error("unreachable");
    expect(plan.registration.identity).toEqual({
      repo: "stiproot/h",
      slug: "issue-42",
      workflow: "revise",
    });
    expect(plan.registration.instanceId).toBe("revise-issue-42");
    expect(plan.registration.budget).toEqual({ maxFires: 20 });
    expect(plan.registration.source).toEqual({
      mode: "saved",
      key: "revise",
      params: { repo: "stiproot/h", slug: "issue-42" },
    });
  });

  it("arms and threads the PR number when the guard output carries a /pull/<n> URL", () => {
    const plan = planCron({
      ...base,
      requirePrFrom: "did the work\n===PR===\nhttps://github.com/stiproot/h/pull/57",
    });
    expect(plan.armed).toBe(true);
    if (!plan.armed) throw new Error("unreachable");
    expect(plan.registration.source.mode).toBe("saved");
    expect((plan.registration.source as { params?: Record<string, unknown> }).params).toMatchObject(
      {
        repo: "stiproot/h",
        slug: "issue-42",
        pr: "57",
      },
    );
  });

  it("no-ops (armed:false) when the guard output has no PR — SKIPPED push", () => {
    const plan = planCron({
      ...base,
      requirePrFrom: "could not push\n===PR===\nSKIPPED: GH_TOKEN unset",
    });
    expect(plan).toEqual({ armed: false, reason: "no PR opened — revise loop not armed" });
  });

  it("no-ops when the guard output has no ===PR=== marker at all", () => {
    const plan = planCron({ ...base, requirePrFrom: "the agent said nothing about a PR" });
    expect(plan.armed).toBe(false);
  });

  it("omits budget when maxFires is unset (registration falls back to the engine default)", () => {
    const plan = planCron({ workflow: "revise", repo: "o/r", slug: "s", cadence: "* * * * *" });
    expect(plan.armed).toBe(true);
    if (!plan.armed) throw new Error("unreachable");
    expect(plan.registration.budget).toBeUndefined();
  });
});
