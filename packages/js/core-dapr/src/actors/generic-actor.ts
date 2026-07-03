import { AbstractActor } from "@dapr/dapr";

// Reserved internal state keys. record/increment maintain these; the actor_state_*
// surface operates on the remaining (user) keys and hides these from listings.
const LOG_KEY = "__log__";
const COUNTERS_KEY = "__counters__";
const RESERVED = new Set([LOG_KEY, COUNTERS_KEY]);
const LOG_CAP = 1000;

export interface ActorStateResult {
  key: string;
  value: unknown;
  exists: boolean;
}

export interface IGenericActor {
  setState(key: string, value: unknown): Promise<{ key: string }>;
  getState(key: string): Promise<ActorStateResult>;
  removeState(key: string): Promise<{ key: string; removed: boolean }>;
  listStateKeys(): Promise<string[]>;
  invokeCommand(method: string, payload: unknown): Promise<unknown>;
  onTimerFire(data: unknown): Promise<void>;
}

interface IncrementPayload {
  name?: string;
  by?: number;
}

/**
 * A single generic actor type, hosted once and addressed by id. It offers a durable
 * per-id key/value scratchpad plus a small set of built-in commands (record, increment,
 * merge, snapshot, clear). State is owned by the instance and persisted by the runtime
 * after each method call — so reads and writes go through these methods, not the client.
 */
export class GenericActor extends AbstractActor implements IGenericActor {
  private stateOf<T = unknown>() {
    return this.getStateManager<T>();
  }

  private async appendLog(entry: Record<string, unknown>): Promise<number> {
    const sm = this.stateOf<unknown[]>();
    const [found, current] = await sm.tryGetState(LOG_KEY);
    const log = found && Array.isArray(current) ? current : [];
    log.push({ ts: new Date().toISOString(), ...entry });
    const capped = log.length > LOG_CAP ? log.slice(log.length - LOG_CAP) : log;
    await sm.setState(LOG_KEY, capped);
    return capped.length;
  }

  async setState(key: string, value: unknown): Promise<{ key: string }> {
    await this.stateOf().setState(key, value);
    return { key };
  }

  async getState(key: string): Promise<ActorStateResult> {
    const [found, value] = await this.stateOf().tryGetState(key);
    return { key, value: found ? value : null, exists: found };
  }

  async removeState(key: string): Promise<{ key: string; removed: boolean }> {
    const removed = await this.stateOf().tryRemoveState(key);
    return { key, removed };
  }

  async listStateKeys(): Promise<string[]> {
    const names = await this.stateOf().getStateNames();
    return names.filter((n) => !RESERVED.has(n));
  }

  async invokeCommand(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case "record": {
        const logLength = await this.appendLog({ kind: "record", payload: payload ?? null });
        return { method, logLength };
      }
      case "increment": {
        const p = (payload ?? {}) as IncrementPayload;
        const name = p.name ?? "default";
        const by = typeof p.by === "number" ? p.by : 1;
        const sm = this.stateOf<Record<string, number>>();
        const [, current] = await sm.tryGetState(COUNTERS_KEY);
        const counters = current ?? {};
        const value = (counters[name] ?? 0) + by;
        counters[name] = value;
        await sm.setState(COUNTERS_KEY, counters);
        return { method, name, value };
      }
      case "merge": {
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("merge payload must be a JSON object");
        }
        const sm = this.stateOf();
        const keys = Object.keys(payload as Record<string, unknown>);
        for (const key of keys) {
          await sm.setState(key, (payload as Record<string, unknown>)[key]);
        }
        return { method, merged: keys };
      }
      case "snapshot": {
        const sm = this.stateOf();
        const names = await sm.getStateNames();
        const state: Record<string, unknown> = {};
        for (const name of names) {
          if (RESERVED.has(name)) continue;
          const [, value] = await sm.tryGetState(name);
          state[name] = value;
        }
        const [, counters] = await this.stateOf<Record<string, number>>().tryGetState(COUNTERS_KEY);
        const [, log] = await this.stateOf<unknown[]>().tryGetState(LOG_KEY);
        return {
          method,
          state,
          counters: counters ?? {},
          logLength: Array.isArray(log) ? log.length : 0,
        };
      }
      case "clear": {
        const sm = this.stateOf();
        const names = await sm.getStateNames();
        for (const name of names) {
          await sm.tryRemoveState(name);
        }
        return { method, cleared: true };
      }
      default:
        throw new Error(
          `Unknown actor method: ${method}. Valid methods: record, increment, merge, snapshot, clear`,
        );
    }
  }

  // Timer callback — the registered timer names this method. The fired data is recorded
  // to the log so an agent can discover that the timer ran on its next interaction.
  async onTimerFire(data: unknown): Promise<void> {
    await this.appendLog({ kind: "timer", data: data ?? null });
  }

  // Reminder callback — fired durably across restarts. Records a trace to the log.
  override async receiveReminder(data: string): Promise<void> {
    let parsed: unknown = data;
    if (typeof data === "string") {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
    }
    await this.appendLog({ kind: "reminder", data: parsed ?? null });
  }
}
