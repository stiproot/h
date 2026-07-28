import { describe, expect, it } from "vitest";

import type { WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { getActivity } from "../activity-registry.ts";
import { genericWorkflow } from "./generic.workflow.ts";

// A recording WorkflowContext: callActivity logs { activity, input } and returns a placeholder Task.
type Call = { activity: unknown; input: Record<string, unknown> };

async function run(
  input: WorkflowRequest,
  opts: { failAtCall?: number; stepResult?: unknown } = {},
) {
  const calls: Call[] = [];
  const ctx = {
    getWorkflowInstanceId: () => "inst-1",
    callActivity: (activity: unknown, actInput: unknown) => {
      calls.push({ activity, input: actInput as Record<string, unknown> });
      return { call: calls.length - 1 };
    },
  };
  const gen = genericWorkflow(ctx as never, input);
  let sent: unknown;
  let error: unknown;
  try {
    for (;;) {
      const step = await gen.next(sent);
      if (step.done) return { calls, output: step.value as string, error };
      const idx = (step.value as unknown as { call: number }).call;
      if (opts.failAtCall === idx) {
        // Simulate the yielded activity Task failing: the catch yields the failed-bracket, then rethrows.
        await gen.throw(new Error("step boom"));
        await gen.next("ok").catch((e: unknown) => {
          error = e;
        });
        return { calls, output: undefined, error };
      }
      sent = opts.stepResult ?? "ok";
    }
  } catch (e) {
    error = e;
    return { calls, output: undefined, error };
  }
}

const writeWfRow = getActivity("write-wf-row");
const step = (activity: string, id?: string) => ({ activity, id, input: {} });

describe("genericWorkflow — wf: bracketing", () => {
  it("brackets a wf-identified run: running → steps → done", async () => {
    const input: WorkflowRequest = {
      steps: [step("copy-session", "s1")],
      params: { pr: "30" },
      wf: { repo: "stiproot/h", slug: "pi-agent", workflow: "revise-pr" },
    } as WorkflowRequest;
    const { calls } = await run(input);

    expect(calls[0].activity).toBe(writeWfRow);
    expect(calls[0].input).toMatchObject({ status: "running", instanceId: "inst-1" });
    expect(calls[0].input.wf).toEqual({
      repo: "stiproot/h",
      slug: "pi-agent",
      workflow: "revise-pr",
    });
    // the real step fires in the middle
    expect(calls[1].activity).toBe(getActivity("copy-session"));
    // done bracket last, carrying the output
    expect(calls[2].activity).toBe(writeWfRow);
    expect(calls[2].input).toMatchObject({ status: "done" });
    expect(typeof calls[2].input.output).toBe("string");
  });

  it("sets resolved on the done row when a step's structured output reports goal RESOLVED", async () => {
    const input: WorkflowRequest = {
      steps: [step("run-claude", "revise-pr")],
      wf: { repo: "stiproot/h", slug: "pi-agent", workflow: "revise-pr" },
    } as WorkflowRequest;
    const { calls } = await run(input, {
      stepResult: { output: "addressed comments", structured: { pr: 57, goal: "RESOLVED" } },
    });
    const done = calls.find((c) => c.activity === writeWfRow && c.input.status === "done");
    expect(done?.input.resolved).toBe(true);
  });

  it("leaves resolved false when the structured goal is PENDING (or absent)", async () => {
    const input: WorkflowRequest = {
      steps: [step("run-claude", "revise-pr")],
      wf: { repo: "r", slug: "s", workflow: "revise-pr" },
    } as WorkflowRequest;
    const { calls } = await run(input, {
      stepResult: { output: "addressed", structured: { pr: 57, goal: "PENDING" } },
    });
    const done = calls.find((c) => c.activity === writeWfRow && c.input.status === "done");
    expect(done?.input.resolved).toBe(false);
  });

  it("does NOT bracket a run with no wf identity (opt-in)", async () => {
    const { calls } = await run({ steps: [step("copy-session", "s1")] } as WorkflowRequest);
    expect(calls).toHaveLength(1);
    expect(calls[0].activity).toBe(getActivity("copy-session"));
  });

  it("writes a failed row and rethrows when a step fails", async () => {
    const input: WorkflowRequest = {
      steps: [step("copy-session", "s1")],
      wf: { repo: "r", slug: "s", workflow: "implement-pr" },
    } as WorkflowRequest;
    // call 0 = running bracket; call 1 = the step — fail it.
    const { calls, error } = await run(input, { failAtCall: 1 });
    expect(error).toBeInstanceOf(Error);
    const statuses = calls.filter((c) => c.activity === writeWfRow).map((c) => c.input.status);
    expect(statuses).toEqual(["running", "failed"]);
  });
});

describe("genericWorkflow — --cron closing bracket (§10)", () => {
  const registerCron = getActivity("register-cron");

  it("arms a recur cron via register-cron AFTER the work, before the done bracket", async () => {
    const input: WorkflowRequest = {
      steps: [step("copy-session", "s1")],
      params: { repo: "stiproot/h", slug: "issue-5" },
      wf: { repo: "stiproot/h", slug: "issue-5", workflow: "implement-pr" },
      armCron: { cadence: "0 */6 * * *", workflow: "implement-pr", budget: { maxFires: 20 } },
    } as WorkflowRequest;
    const { calls } = await run(input);

    const armIdx = calls.findIndex((c) => c.activity === registerCron);
    expect(armIdx).toBeGreaterThan(-1);
    expect(calls[armIdx].input).toMatchObject({
      workflow: "implement-pr",
      repo: "stiproot/h",
      slug: "issue-5",
      cadence: "0 */6 * * *",
      maxFires: 20,
      instanceId: "inst-1", // recurs under THIS run's instance
    });
    const stepIdx = calls.findIndex((c) => c.activity === getActivity("copy-session"));
    const doneIdx = calls.findIndex((c) => c.activity === writeWfRow && c.input.status === "done");
    expect(stepIdx).toBeLessThan(armIdx);
    expect(armIdx).toBeLessThan(doneIdx);
  });

  it("does not arm when armCron is absent", async () => {
    const input = { steps: [step("copy-session", "s1")], params: {} } as WorkflowRequest;
    const { calls } = await run(input);
    expect(calls.some((c) => c.activity === registerCron)).toBe(false);
  });

  it("a failed arm records wf:failed (LOUD)", async () => {
    const input: WorkflowRequest = {
      steps: [step("copy-session", "s1")],
      params: { repo: "stiproot/h", slug: "issue-5" },
      wf: { repo: "stiproot/h", slug: "issue-5", workflow: "implement-pr" },
      armCron: { cadence: "0 */6 * * *", workflow: "implement-pr" },
    } as WorkflowRequest;
    // calls: 0 running, 1 step, 2 register-cron — fail the arm.
    const { calls, error } = await run(input, { failAtCall: 2 });
    expect(error).toBeInstanceOf(Error);
    const statuses = calls.filter((c) => c.activity === writeWfRow).map((c) => c.input.status);
    expect(statuses).toEqual(["running", "failed"]);
  });
});

describe("genericWorkflow — parallel step groups (docs/plans/impl/multi-agent-panel.md)", () => {
  // Its own driver: the shared `run` doesn't model whenAll. callActivity records the call and
  // returns its index; whenAll records which call-indices were grouped. The loop feeds each
  // yield's result back in: an array for a whenAll yield, a scalar for a plain activity yield.
  async function runParallel(input: WorkflowRequest, branchResult: (call: Call) => unknown) {
    const calls: Call[] = [];
    const groups: number[][] = [];
    const ctx = {
      getWorkflowInstanceId: () => "inst-1",
      callActivity: (activity: unknown, actInput: unknown) => {
        calls.push({ activity, input: actInput as Record<string, unknown> });
        return { call: calls.length - 1 };
      },
      whenAll: (tasks: { call: number }[]) => {
        groups.push(tasks.map((t) => t.call));
        return { group: groups.length - 1 };
      },
    };
    const gen = genericWorkflow(ctx as never, input);
    let sent: unknown;
    for (;;) {
      const stepped = await gen.next(sent);
      if (stepped.done) {
        return { calls, groups, results: JSON.parse(stepped.value) as Record<string, unknown> };
      }
      const value = stepped.value as unknown as { call?: number; group?: number };
      sent =
        value.group !== undefined
          ? groups[value.group].map((i) => branchResult(calls[i]))
          : branchResult(calls[value.call as number]);
    }
  }

  it("fans a group out through ONE whenAll and records branch + group results", async () => {
    const input: WorkflowRequest = {
      params: { task: "T" },
      steps: [
        {
          id: "panel",
          parallel: [
            { id: "a", activity: "run-claude", input: { task: "{{params.task}}-a" } },
            { id: "b", activity: "run-openhands", input: { task: "{{params.task}}-b" } },
          ],
        },
        { id: "synth", activity: "run-claude", input: { task: "{{a.output}}|{{b.output}}" } },
      ],
    } as WorkflowRequest;

    const { calls, groups, results } = await runParallel(input, (call) => ({
      output: `out:${call.input.task as string}`,
    }));

    // Branch inputs resolved against pre-group results only, each branch to its own activity.
    expect(groups).toEqual([[0, 1]]);
    expect(calls[0].activity).toBe(getActivity("run-claude"));
    expect(calls[0].input.task).toBe("T-a");
    expect(calls[1].activity).toBe(getActivity("run-openhands"));
    expect(calls[1].input.task).toBe("T-b");
    // Branch results land under branch ids; the group id gets the {branchId: result} map.
    expect(results.a).toEqual({ output: "out:T-a" });
    expect(results.panel).toEqual({
      a: { output: "out:T-a" },
      b: { output: "out:T-b" },
    });
    // The sequential synthesis step sees both branch results.
    expect(calls[2].input.task).toBe("out:T-a|out:T-b");
    expect(results.synth).toEqual({ output: "out:out:T-a|out:T-b" });
  });

  it("defaults a branch's results key to its activity name when id is absent", async () => {
    const input: WorkflowRequest = {
      params: {},
      steps: [{ parallel: [{ activity: "run-pi", input: { task: "t" } }] }],
    } as WorkflowRequest;
    const { results } = await runParallel(input, () => ({ output: "P" }));
    expect(results["run-pi"]).toEqual({ output: "P" });
  });
});
