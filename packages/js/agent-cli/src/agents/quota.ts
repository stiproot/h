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
 * Codex has no structured quota event. Its raw stream reports either `{type:"error", message}`
 * or `{type:"turn.failed", error:{message}}`; the invocation ledger normalizes those to
 * `{type:"error", result}` and `{type:"result", is_error:true, result}`. The observed message is:
 * "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit
 * https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:13 PM."
 * Codex names no window, so `five_hour` is a compatibility SLOT rather than a claimed provider
 * window. The rejected gate reads only `status`; its fence uses the earliest future exhausted
 * `resetsAt`, so this slot supplies the real reset without changing the shared decision table.
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

function codexLimitText(event: StreamEvent | Record<string, unknown>): string | undefined {
  if (event.type === "error") {
    const raw = event as { message?: unknown; result?: unknown };
    if (typeof raw.message === "string") return raw.message;
    if (typeof raw.result === "string") return raw.result;
  }
  if (event.type === "turn.failed") {
    const error = (event as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  if (event.type === "result") {
    const raw = event as { is_error?: unknown; result?: unknown };
    if (raw.is_error === true && typeof raw.result === "string") return raw.result;
  }
  return undefined;
}

function codexResetAt(
  text: string,
  observedAt: Date,
  utcOffsetMinutes: number,
): string | undefined {
  if (!/usage limit/i.test(text)) return undefined;
  const match = /try again at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3]?.toLowerCase();
  if (minute > 59) return undefined;
  if (suffix) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (suffix === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }

  const offsetMs = utcOffsetMinutes * 60_000;
  const local = new Date(observedAt.getTime() + offsetMs);
  const candidateForDay = (dayOffset: number) =>
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + dayOffset,
      hour,
      minute,
    ) - offsetMs;
  const today = candidateForDay(0);
  return new Date(today > observedAt.getTime() ? today : candidateForDay(1)).toISOString();
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
  utcOffsetMinutes: number = -observedAt.getTimezoneOffset(),
): QuotaObservation | undefined {
  const codexText = codexLimitText(event);
  if (codexText !== undefined) {
    const resetsAt = codexResetAt(codexText, observedAt, utcOffsetMinutes);
    if (resetsAt === undefined) return undefined;
    return {
      status: "rejected",
      windows: { five_hour: { utilization: 1, resetsAt } },
      observedAt: observedAt.toISOString(),
    };
  }

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
 * quota yields no report rather than an empty one. Codex reports only when its usage-limit text
 * includes a parseable reset time; pi does not report quota.
 */
export function foldQuota(observations: readonly QuotaObservation[]): QuotaReport | undefined {
  let report: QuotaReport | undefined;
  const first: Partial<Record<QuotaWindowName, QuotaWindow>> = {};
  for (const obs of observations) {
    report = {
      status: obs.status,
      windows: { ...report?.windows, ...obs.windows },
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
