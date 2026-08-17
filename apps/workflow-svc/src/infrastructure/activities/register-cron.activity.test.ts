import { describe, expect, it } from "vitest";

import { type RegisterCronInput, planCron } from "engine-core";

const base: RegisterCronInput = {
  workflow: "revise-pr",
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
      workflow: "revise-pr",
    });
    expect(plan.registration.instanceId).toBe("revise-pr-issue-42");
    expect(plan.registration.budget).toEqual({ maxFires: 20 });
    expect(plan.registration.source).toEqual({
      mode: "saved",
      key: "revise-pr",
      params: { repo: "stiproot/h", slug: "issue-42" },
    });
  });

  it("arms and threads the PR number when the guard output carries a /pull/<n> URL", () => {
    const plan = planCron({
      ...base,
      requirePrFrom:
        'did the work\n```json\n{"pr": 57, "url": "https://github.com/stiproot/h/pull/57"}\n```\n',
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
      requirePrFrom: 'could not push\n```json\n{"skipped": "GH_TOKEN unset"}\n```\n',
    });
    expect(plan).toEqual({ armed: false, reason: "no PR opened — revise-pr loop not armed" });
  });

  it("no-ops when the guard output has no structured block at all", () => {
    const plan = planCron({ ...base, requirePrFrom: "the agent said nothing about a PR" });
    expect(plan.armed).toBe(false);
  });

  it("omits budget when maxFires is unset (registration falls back to the engine default)", () => {
    const plan = planCron({ workflow: "revise-pr", repo: "o/r", slug: "s", cadence: "* * * * *" });
    expect(plan.armed).toBe(true);
    if (!plan.armed) throw new Error("unreachable");
    expect(plan.registration.budget).toBeUndefined();
  });

  it("builds an EMBEDDED source from the run's own steps when inline (no saved key)", () => {
    const steps = [{ activity: "run-claude", input: { task: "do it" } }];
    const plan = planCron({
      ...base,
      inline: true,
      steps,
      workspaceId: "ws-1",
    });
    expect(plan.armed).toBe(true);
    if (!plan.armed) throw new Error("unreachable");
    expect(plan.registration.source).toEqual({
      mode: "embedded",
      steps,
      params: { repo: "stiproot/h", slug: "issue-42" },
      workspaceId: "ws-1",
    });
    // Identity + instance still derive from the wf coords, exactly like the saved path.
    expect(plan.registration.identity.workflow).toBe("revise-pr");
    expect(plan.registration.instanceId).toBe("revise-pr-issue-42");
  });

  it("threads the PR guard into embedded-source params too", () => {
    const plan = planCron({
      ...base,
      inline: true,
      steps: [{ activity: "run-claude" }],
      requirePrFrom: '```json\n{"pr": 57}\n```',
    });
    expect(plan.armed).toBe(true);
    if (!plan.armed) throw new Error("unreachable");
    expect((plan.registration.source as { params?: Record<string, unknown> }).params).toMatchObject(
      {
        pr: "57",
      },
    );
  });

  it("fails closed (armed:false) when inline is set but there are no steps to recur", () => {
    const plan = planCron({ ...base, inline: true, steps: [] });
    expect(plan).toEqual({ armed: false, reason: "inline cron has no steps to recur" });
  });
});
