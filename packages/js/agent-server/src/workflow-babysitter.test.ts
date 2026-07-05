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
  watchList?: unknown;
  calls: Call[];
}): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    script.calls.push({ url: u, init });
    if (u.includes("/method/workflow/run")) {
      return json(script.runResult ?? { instanceId: "wf-1", watching: true });
    }
    if (u.includes("/method/watch/list")) {
      return json(script.watchList ?? { heartbeat: null, watches: [] });
    }
    throw new Error(`unscripted fetch: ${u}`);
  }) as typeof fetch;
}

describe("WorkflowBabysitter (forward-with-watch-field)", () => {
  it("submits by key and translates policy.maxDurationMs into the watch field", async () => {
    const calls: Call[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls }),
    });
    const result = await sitter.submit({
      key: "feature",
      params: { slug: "x" },
      policy: { maxDurationMs: 600_000 },
    });
    expect(result).toEqual({ instanceId: "wf-1", watching: true });
    expect(calls).toHaveLength(1); // one schedule call, no polling — supervision is engine-owned
    expect(calls[0]!.url).toContain("/v1.0/invoke/workflow-svc/method/workflow/run/feature");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      params: { slug: "x" },
      watch: { maxDurationMs: 600_000 },
      watchMeta: { owner: "test-agent" },
    });
  });

  it("defaults the watch budget to 45 minutes when no policy is given", async () => {
    const calls: Call[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls }),
    });
    await sitter.submit({ steps: [{ activity: "setup", input: {} }] });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.watch).toEqual({ maxDurationMs: 45 * 60_000 });
    expect(calls[0]!.url).toContain("/method/workflow/run");
  });

  it("forwards an explicit watch policy verbatim — it wins over policy", async () => {
    const calls: Call[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls }),
    });
    const watch = {
      maxDurationMs: 2_400_000,
      retry: { maxAttempts: 2, fresh: true },
    };
    await sitter.submit({
      key: "feature",
      instanceId: "feature-issue-9",
      fresh: true,
      policy: { maxDurationMs: 1 }, // ignored: explicit watch wins
      watch,
      watchMeta: { owner: "issue-sweep", issue: "9" },
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      instanceId: "feature-issue-9",
      fresh: true,
      watch,
      watchMeta: { owner: "issue-sweep", issue: "9" },
    });
  });

  it("reports watching: false when workflow-svc did not register a watch", async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls, runResult: { instanceId: "wf-1" } }),
      onLog: (msg) => logs.push(msg),
    });
    const result = await sitter.submit({ key: "feature" });
    expect(result).toEqual({ instanceId: "wf-1", watching: false });
    expect(logs.some((l) => l.includes("not watching"))).toBe(true);
  });

  it("list() proxies workflow-svc's durable watch registry", async () => {
    const calls: Call[] = [];
    const watchList = {
      heartbeat: { at: "2026-07-05T09:00:00Z", enabled: true },
      watches: [{ instanceId: "wf-1", status: "watching" }],
    };
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      daprHttpPort: "3999",
      fetchImpl: scriptedFetch({ calls, watchList }),
    });
    expect(await sitter.list()).toEqual(watchList);
    expect(calls[0]!.url).toContain("/v1.0/invoke/workflow-svc/method/watch/list");
  });

  it("rejects a submit with neither key nor steps", async () => {
    const sitter = new WorkflowBabysitter({
      agentId: "test-agent",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(sitter.submit({})).rejects.toThrow("submit needs a key or steps");
  });

  it("surfaces a scheduling failure to the submitter", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const sitter = new WorkflowBabysitter({ agentId: "test-agent", fetchImpl });
    await expect(sitter.submit({ key: "feature" })).rejects.toThrow(
      "workflow-svc workflow/run/feature failed with 500",
    );
  });

  it("surfaces a watch-list failure (the route maps it to 502)", async () => {
    const fetchImpl = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch;
    const sitter = new WorkflowBabysitter({ agentId: "test-agent", fetchImpl });
    await expect(sitter.list()).rejects.toThrow("workflow-svc watch/list failed with 503");
  });
});
