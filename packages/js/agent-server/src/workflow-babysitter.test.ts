import { describe, expect, it, vi } from "vitest";

import { WorkflowBabysitter } from "./workflow-babysitter.ts";

type Call = { url: string; init?: RequestInit };

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A scripted fetch: routes by URL substring, records every call. */
function scriptedFetch(script: {
  runResult?: unknown;
  statuses?: string[];
  calls: Call[];
}): typeof fetch {
  let statusIdx = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    script.calls.push({ url: u, init });
    if (u.includes("/method/workflow/run")) return json(script.runResult ?? { instanceId: "wf-1" });
    if (u.includes("/method/workflow/status/")) {
      const statuses = script.statuses ?? ["COMPLETED"];
      const status = statuses[Math.min(statusIdx, statuses.length - 1)]!;
      statusIdx += 1;
      return json({ instanceId: "wf-1", runtimeStatus: status });
    }
    if (u.includes("/method/workflow/terminate/")) return json({ instanceId: "wf-1" });
    if (u.includes("/v1.0/publish/")) return new Response(null, { status: 204 });
    throw new Error(`unscripted fetch: ${u}`);
  }) as typeof fetch;
}

const fastPolicy = { pollIntervalMs: 2, maxDurationMs: 500 };

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("WorkflowBabysitter", () => {
  it("submits by key with params and returns the instanceId immediately", async () => {
    const calls: Call[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls }),
      defaultPolicy: fastPolicy,
    });
    const { instanceId } = await sitter.submit({ key: "feature", params: { slug: "x" } });
    expect(instanceId).toBe("wf-1");
    expect(calls[0]!.url).toContain("/v1.0/invoke/workflow-svc/method/workflow/run/feature");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ params: { slug: "x" } });
    await until(() => sitter.list()[0]?.outcome !== undefined);
  });

  it("watches to a terminal status and publishes a workflow-events event", async () => {
    const calls: Call[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls, statuses: ["RUNNING", "RUNNING", "COMPLETED"] }),
      defaultPolicy: fastPolicy,
    });
    await sitter.submit({ steps: [{ activity: "setup", input: {} }] });
    await until(() => sitter.list()[0]?.outcome === "completed");
    const publish = calls.find((c) => c.url.includes("/v1.0/publish/pubsub/workflow-events"));
    expect(publish).toBeDefined();
    expect(JSON.parse(publish!.init!.body as string)).toMatchObject({
      instanceId: "wf-1",
      outcome: "completed",
      runtimeStatus: "COMPLETED",
      watcherAgentId: "test-agent",
    });
  });

  it("terminates a run that exceeds its wall-clock budget", async () => {
    const calls: Call[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls, statuses: ["RUNNING"] }), // never terminal
    });
    await sitter.submit({ key: "feature", policy: { pollIntervalMs: 2, maxDurationMs: 10 } });
    await until(() => sitter.list()[0]?.outcome === "budget-terminated");
    expect(calls.some((c) => c.url.includes("/method/workflow/terminate/wf-1"))).toBe(true);
    const publish = calls.find((c) => c.url.includes("/v1.0/publish/"));
    expect(JSON.parse(publish!.init!.body as string)).toMatchObject({
      outcome: "budget-terminated",
    });
  });

  it("keeps polling through transient status failures (UNKNOWN is not terminal)", async () => {
    const calls: Call[] = [];
    let flaky = 0;
    const inner = scriptedFetch({ calls, statuses: ["RUNNING", "COMPLETED"] });
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/method/workflow/status/") && flaky++ === 0) {
        throw new Error("sidecar hiccup");
      }
      return inner(url, init);
    }) as typeof fetch;
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl,
      defaultPolicy: fastPolicy,
    });
    await sitter.submit({ key: "feature" });
    await until(() => sitter.list()[0]?.outcome === "completed");
  });

  it("rejects a submit with neither key nor steps", async () => {
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(sitter.submit({})).rejects.toThrow("submit needs a key or steps");
  });

  it("surfaces a scheduling failure to the submitter (no watch started)", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const sitter = new WorkflowBabysitter({ agentId: "test-agent", fetchImpl });
    await expect(sitter.submit({ key: "feature" })).rejects.toThrow(
      "workflow-svc workflow/run/feature failed with 500",
    );
    expect(sitter.list()).toEqual([]);
  });
});
