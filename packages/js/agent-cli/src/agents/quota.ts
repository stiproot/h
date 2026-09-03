/**
 * Quota observation — what an agent CLI tells us about the account's rate-limit WINDOWS, read off
 * its event stream. This is the pure half of h's quota-aware run: an observation is parsed here,
 * ONCE, and every consumer (the run ledger, the `quota:` registry, the pre-fire gate, `h agents
 * list`) reads the parsed shape rather than the CLI's own.
 *
 * Verified live against 161 ledgers (2026-09-02, claude CLI): every API call emits
 * `{type:"rate_limit_event", rate_limit_info:{status, resetsAt, rateLimitType, utilization?,
 * unifiedWindows?:{five_hour:{utilization,resetsAt}, seven_day:{…}}}}`. `status` is `allowed` |
 * `allowed_warning` | `rejected`; `resetsAt` is EPOCH SECONDS. Newer CLIs carry every window under
 * `unifiedWindows`; older ones carry ONE window flattened to the top level (`rateLimitType` names
 * it, `utilization` + `resetsAt` describe it). Both shapes are read, because the operator's CLI
 * version is not h's to pin. A `rejected` event is the limit itself: the five-hour window at
 * utilization 1 with `overageStatus: "rejected"` — the run then stops `usage-limited`.
 *
 * Why h cares: a run that starts at 0.95 of a five-hour window will die mid-step, paying for the
 * step and delivering nothing. Knowing the utilization BEFORE firing turns that into a refusal or
 * a wait until `resetsAt` — the thing a schedule exists for.
 */
import type { StreamEvent } from "./types.ts";

export type QuotaWindowName = "five_hour" | "seven_day";
export const QUOTA_WINDOWS: readonly QuotaWindowName[] = ["five_hour", "seven_day"];

export type QuotaStatus = "allowed" | "allowed_warning" | "rejected";

/** One rate-limit window as last observed: how much is spent (0..1) and when it resets (ISO). */
export interface QuotaWindow {
  utilization: number;
  resetsAt: string;
}

/** The parsed shape of ONE rate_limit_event. */
export interface QuotaObservation {
  status: QuotaStatus;
  windows: Partial<Record<QuotaWindowName, QuotaWindow>>;
  /** When the observation was made (ISO) — the run clock, not the CLI's. */
  observedAt: string;
}

/**
 * A whole run's quota story, folded from its event stream: the LAST observation (what the
 * account looks like now) plus what THIS run spent per window — `last − first` utilization when
 * both fell in the same window instance (same `resetsAt`), else the last utilization alone,
 * which is a floor: the window reset mid-run, and what was spent before the reset is gone.
 * `spent` is the raw material of the pre-fire estimate ("a step like this costs ~7% of the
 * window").
 */
export interface QuotaReport extends QuotaObservation {
  spent: Partial<Record<QuotaWindowName, number>>;
}

const STATUSES: ReadonlySet<string> = new Set(["allowed", "allowed_warning", "rejected"]);

function isWindowName(value: unknown): value is QuotaWindowName {
  return value === "five_hour" || value === "seven_day";
}

/** Epoch seconds (the CLI's unit) → ISO. Milliseconds are tolerated in case a CLI switches. */
function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function windowFrom(value: unknown): QuotaWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { utilization, resetsAt } = value as { utilization?: unknown; resetsAt?: unknown };
  const iso = epochToIso(resetsAt);
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || iso === undefined)
    return undefined;
  return { utilization: Math.max(0, utilization), resetsAt: iso };
}

/**
 * Whether a stream event is a rate_limit_event at all (cheap pre-check for the live path). Typed
 * over the raw record the `onEvent` callback carries — every strategy's events flow through it,
 * and only claude's are `StreamEvent`s.
 */
export function isQuotaEvent(event: StreamEvent | Record<string, unknown>): boolean {
  return event.type === "rate_limit_event";
}

/**
 * Parse one `rate_limit_event` into an observation, or `undefined` when the event is not one or
 * carries nothing readable (a null-status event was seen live — it is skipped, not a failure).
 */
export function parseRateLimitEvent(
  event: StreamEvent | Record<string, unknown>,
  observedAt: Date = new Date(),
): QuotaObservation | undefined {
  if (!isQuotaEvent(event)) return undefined;
  const info = (event as { rate_limit_info?: unknown }).rate_limit_info;
  if (typeof info !== "object" || info === null) return undefined;
  const raw = info as Record<string, unknown>;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return undefined;

  const windows: QuotaObservation["windows"] = {};
  const unified = raw.unifiedWindows;
  if (typeof unified === "object" && unified !== null) {
    for (const [name, value] of Object.entries(unified as Record<string, unknown>)) {
      if (!isWindowName(name)) continue;
      const window = windowFrom(value);
      if (window) windows[name] = window;
    }
  }
  // The legacy flattened shape: one window at the top level. Also a fallback when unifiedWindows
  // exists but omits the named window.
  if (isWindowName(raw.rateLimitType) && windows[raw.rateLimitType] === undefined) {
    const window = windowFrom({ utilization: raw.utilization, resetsAt: raw.resetsAt });
    if (window) windows[raw.rateLimitType] = window;
  }
  if (Object.keys(windows).length === 0) return undefined;
  return { status: raw.status as QuotaStatus, windows, observedAt: observedAt.toISOString() };
}

/**
 * Fold a run's observations, in stream order, into its {@link QuotaReport}. Windows accumulate
 * (a legacy event names one window; a later unified event may fill the other), `status` is the
 * last one seen, and `spent` is computed per window against the FIRST observation of that window.
 * `undefined` when the stream carried no observation at all — an agent CLI that does not report
 * quota (codex, pi) yields no report rather than an empty one.
 */
export function foldQuota(observations: readonly QuotaObservation[]): QuotaReport | undefined {
  let report: QuotaReport | undefined;
  const first: Partial<Record<QuotaWindowName, QuotaWindow>> = {};
  for (const obs of observations) {
    report = {
      status: obs.status,
      windows: { ...(report?.windows ?? {}), ...obs.windows },
      observedAt: obs.observedAt,
      spent: report?.spent ?? {},
    };
    for (const name of QUOTA_WINDOWS) {
      const window = obs.windows[name];
      if (!window) continue;
      first[name] ??= window;
    }
  }
  if (!report) return undefined;
  const spent: QuotaReport["spent"] = {};
  for (const name of QUOTA_WINDOWS) {
    const start = first[name];
    const end = report.windows[name];
    if (!start || !end) continue;
    spent[name] =
      start.resetsAt === end.resetsAt
        ? Math.max(0, end.utilization - start.utilization)
        : end.utilization;
  }
  return { ...report, spent };
}
