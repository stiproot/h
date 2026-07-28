/**
 * The workflow babysitter, post-watcher-cutover (docs/plans/impl/watcher-primitive.md): submit and
 * FORWARD, not submit-and-supervise. Supervision is durable and engine-owned in workflow-svc —
 * the submit translates the caller's policy into a `watch` field on the run body, workflow-svc
 * writes a `watch:sub:<instanceId>` row in the same handler that schedules, and its cron-tick
 * scan enforces the budget, retries, and publishes terminal `workflow-events`. The in-process
 * watch loop this class used to run (poll/terminate/publish, volatile across restarts) is
 * deleted, not wrapped: rows survive restarts by construction.
 *
 * Deliberately dependency-light (plain fetch, no Effect): it must be embeddable in any agent
 * service regardless of its HTTP stack. Everything is injectable for tests (fetchImpl).
 */

export interface BabysitPolicy {
  /** Wall-clock budget for the run; on breach the engine terminates the instance. Default 45 min. */
  maxDurationMs?: number;
  /**
   * @deprecated The engine scans on the workflow-svc cron tick (60s); there is no per-watch
   * poll cadence anymore. Accepted and ignored so existing submit bodies stay valid.
   */
  pollIntervalMs?: number;
}

/** The watcher engine's typed policy (mirrors workflow-svc's WatchPolicy schema). */
export interface WatchPolicy {
  maxDurationMs: number;
  unknownStreakLimit?: number;
  retry?: { maxAttempts: number; fresh?: boolean; onOutcome?: string[] };
  escalate?: { onOutcome: string[]; key: string; params?: Record<string, unknown> };
}

export interface WorkflowSubmit {
  /** Saved-workflow key (a published template) to fire… */
  key?: string;
  /** …or inline step definitions. Exactly one of key/steps is required. */
  steps?: unknown[];
  params?: Record<string, unknown>;
  instanceId?: string;
  workspaceId?: string;
  /** Opt-in purge-and-rerun of a terminal instance under the given instanceId (default: attach). */
  fresh?: boolean;
  /** Legacy shorthand: policy.maxDurationMs becomes watch.maxDurationMs when no watch is given. */
  policy?: BabysitPolicy;
  /** Full watcher policy, forwarded verbatim to workflow-svc; wins over `policy`. */
  watch?: WatchPolicy;
  /** Opaque passthrough stamped onto the watch row (e.g. { owner: "discover" }). */
  watchMeta?: Record<string, unknown>;
}

export interface BabysitterConfig {
  /** Identity stamped onto watch rows via watchMeta when the caller provides none. */
  agentId: string;
  /** Dapr sidecar HTTP port; defaults to DAPR_HTTP_PORT or 3500. */
  daprHttpPort?: string;
  workflowAppId?: string;
  defaultPolicy?: BabysitPolicy;
  fetchImpl?: typeof fetch;
  onLog?: (msg: string) => void;
}

const DEFAULT_BUDGET_MS = 45 * 60_000;

export class WorkflowBabysitter {
  private readonly cfg: Required<Omit<BabysitterConfig, "fetchImpl" | "onLog" | "defaultPolicy">> &
    Pick<BabysitterConfig, "defaultPolicy">;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (msg: string) => void;

  constructor(config: BabysitterConfig) {
    this.cfg = {
      agentId: config.agentId,
      daprHttpPort: config.daprHttpPort ?? process.env.DAPR_HTTP_PORT ?? "3500",
      workflowAppId: config.workflowAppId ?? "workflow-svc",
      defaultPolicy: config.defaultPolicy,
    };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.onLog = config.onLog ?? (() => {});
  }

  private invokeUrl(method: string): string {
    return `http://localhost:${this.cfg.daprHttpPort}/v1.0/invoke/${this.cfg.workflowAppId}/method/${method}`;
  }

  /**
   * Schedule the workflow with a durable watch registration; resolves as soon as the run is
   * scheduled. `watching` is workflow-svc's flag: true means the watch row is durably
   * registered (supervision survives restarts), not that a process is looping.
   */
  async submit(submit: WorkflowSubmit): Promise<{ instanceId: string; watching: boolean }> {
    if (!submit.key && !submit.steps) throw new Error("submit needs a key or steps");
    const watch: WatchPolicy = submit.watch ?? {
      maxDurationMs:
        submit.policy?.maxDurationMs ?? this.cfg.defaultPolicy?.maxDurationMs ?? DEFAULT_BUDGET_MS,
    };
    const body = {
      ...(submit.steps ? { steps: submit.steps } : {}),
      ...(submit.params ? { params: submit.params } : {}),
      ...(submit.instanceId ? { instanceId: submit.instanceId } : {}),
      ...(submit.workspaceId ? { workspaceId: submit.workspaceId } : {}),
      ...(submit.fresh !== undefined ? { fresh: submit.fresh } : {}),
      watch,
      watchMeta: submit.watchMeta ?? { owner: this.cfg.agentId },
    };
    const method = submit.key ? `workflow/run/${encodeURIComponent(submit.key)}` : "workflow/run";
    const scheduled = (await this.post(method, body)) as {
      instanceId: string;
      watching?: boolean;
    };
    const watching = scheduled.watching === true;
    if (!watching) this.onLog(`babysitter | ${scheduled.instanceId} scheduled but not watching`);
    return { instanceId: scheduled.instanceId, watching };
  }

  /**
   * The durable watch table, read from workflow-svc's registry: `{ heartbeat, watches }`.
   * Global truth — includes watches registered by any caller, and survives every restart.
   */
  async list(): Promise<unknown> {
    const res = await this.fetchImpl(this.invokeUrl("watch/list"));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`workflow-svc watch/list failed with ${res.status}: ${text}`);
    }
    return res.json();
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
}
