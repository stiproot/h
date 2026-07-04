/**
 * The workflow babysitter: submit-and-supervise, non-blocking. `submit` schedules a workflow on
 * workflow-svc (via the Dapr sidecar) and returns the instanceId immediately; a background watch
 * loop then polls the instance on a cadence and enforces a deterministic policy — terminal
 * status → publish a `workflow-events` event and stop; wall-clock budget exceeded → terminate
 * the instance, publish, stop. Machines run the loop; agents are only consulted at decision
 * points (a future escalation hook) — never blocked holding a connection for the workflow's
 * lifetime.
 *
 * Deliberately dependency-light (plain fetch, no Effect): it must be embeddable in any agent
 * service regardless of its HTTP stack. Everything is injectable for tests (fetchImpl, cadences).
 */

export interface BabysitPolicy {
  /** Wall-clock budget for the run; on breach the instance is terminated. Default 45 min. */
  maxDurationMs?: number;
  /** Status poll cadence. Default 10s. */
  pollIntervalMs?: number;
}

export interface WorkflowSubmit {
  /** Saved-workflow key (a published family) to fire… */
  key?: string;
  /** …or inline step definitions. Exactly one of key/steps is required. */
  steps?: unknown[];
  params?: Record<string, unknown>;
  instanceId?: string;
  workspaceId?: string;
  policy?: BabysitPolicy;
}

export type WatchOutcome = "completed" | "failed" | "terminated" | "budget-terminated";

export interface WatchState {
  instanceId: string;
  startedAt: string;
  lastStatus: string;
  outcome?: WatchOutcome;
  endedAt?: string;
}

export interface BabysitterConfig {
  /** Identity stamped on published events (which agent service was watching). */
  agentId: string;
  /** Dapr sidecar HTTP port; defaults to DAPR_HTTP_PORT or 3500. */
  daprHttpPort?: string;
  workflowAppId?: string;
  pubsubName?: string;
  /** Topic terminal/escalation events are published to. */
  eventsTopic?: string;
  defaultPolicy?: BabysitPolicy;
  fetchImpl?: typeof fetch;
  onLog?: (msg: string) => void;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

export class WorkflowBabysitter {
  private readonly watches = new Map<string, WatchState>();
  private readonly cfg: Required<Omit<BabysitterConfig, "fetchImpl" | "onLog" | "defaultPolicy">> &
    Pick<BabysitterConfig, "defaultPolicy">;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (msg: string) => void;

  constructor(config: BabysitterConfig) {
    this.cfg = {
      agentId: config.agentId,
      daprHttpPort: config.daprHttpPort ?? process.env.DAPR_HTTP_PORT ?? "3500",
      workflowAppId: config.workflowAppId ?? "workflow-svc",
      pubsubName: config.pubsubName ?? "pubsub",
      eventsTopic: config.eventsTopic ?? "workflow-events",
      defaultPolicy: config.defaultPolicy,
    };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.onLog = config.onLog ?? (() => {});
  }

  private invokeUrl(method: string): string {
    return `http://localhost:${this.cfg.daprHttpPort}/v1.0/invoke/${this.cfg.workflowAppId}/method/${method}`;
  }

  /** Schedule the workflow and start the watch loop; resolves as soon as the run is scheduled. */
  async submit(submit: WorkflowSubmit): Promise<{ instanceId: string }> {
    if (!submit.key && !submit.steps) throw new Error("submit needs a key or steps");
    const scheduled = submit.key
      ? await this.post(
          `workflow/run/${encodeURIComponent(submit.key)}`,
          submit.params ? { params: submit.params } : {},
        )
      : await this.post("workflow/run", {
          steps: submit.steps,
          ...(submit.params ? { params: submit.params } : {}),
          ...(submit.instanceId ? { instanceId: submit.instanceId } : {}),
          ...(submit.workspaceId ? { workspaceId: submit.workspaceId } : {}),
        });
    const { instanceId } = scheduled as { instanceId: string };
    const state: WatchState = {
      instanceId,
      startedAt: new Date().toISOString(),
      lastStatus: "SCHEDULED",
    };
    this.watches.set(instanceId, state);
    // Fire-and-forget: the watch loop owns its own lifetime; a watch failure must never
    // propagate into the submitting request.
    void this.watch(state, { ...this.cfg.defaultPolicy, ...submit.policy }).catch((err) => {
      this.onLog(`babysitter | watch ${instanceId} died: ${String(err)}`);
    });
    return { instanceId };
  }

  /** Current watch states (in-process; restarts forget past watches — MVP). */
  list(): WatchState[] {
    return [...this.watches.values()];
  }

  private async watch(state: WatchState, policy: BabysitPolicy): Promise<void> {
    const pollMs = policy.pollIntervalMs ?? 10_000;
    const budgetMs = policy.maxDurationMs ?? 45 * 60_000;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      const status = await this.getStatus(state.instanceId);
      state.lastStatus = status;
      if (TERMINAL.has(status)) {
        state.outcome = status.toLowerCase() as WatchOutcome;
        state.endedAt = new Date().toISOString();
        await this.publishEvent(state, status);
        return;
      }
      if (Date.now() >= deadline) {
        this.onLog(`babysitter | ${state.instanceId} exceeded ${budgetMs}ms budget — terminating`);
        await this.post(`workflow/terminate/${encodeURIComponent(state.instanceId)}`, {}).catch(
          () => {},
        );
        state.outcome = "budget-terminated";
        state.endedAt = new Date().toISOString();
        await this.publishEvent(state, "TERMINATED");
        return;
      }
    }
  }

  private async getStatus(instanceId: string): Promise<string> {
    try {
      const res = await this.fetchImpl(
        this.invokeUrl(`workflow/status/${encodeURIComponent(instanceId)}`),
      );
      if (!res.ok) return "UNKNOWN";
      const body = (await res.json()) as { runtimeStatus?: string };
      return body.runtimeStatus ?? "UNKNOWN";
    } catch {
      // A transient sidecar/svc outage reads as UNKNOWN and the loop keeps polling —
      // supervision must outlive the infra hiccups it exists to catch.
      return "UNKNOWN";
    }
  }

  private async post(method: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.invokeUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`workflow-svc ${method} failed with ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async publishEvent(state: WatchState, status: string): Promise<void> {
    const url = `http://localhost:${this.cfg.daprHttpPort}/v1.0/publish/${this.cfg.pubsubName}/${this.cfg.eventsTopic}`;
    await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: state.instanceId,
        outcome: state.outcome,
        runtimeStatus: status,
        watcherAgentId: this.cfg.agentId,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
      }),
    }).catch((err: unknown) => {
      // Event emission is best-effort observability — never fail the watch over it.
      this.onLog(`babysitter | publish for ${state.instanceId} failed: ${String(err)}`);
    });
  }
}
