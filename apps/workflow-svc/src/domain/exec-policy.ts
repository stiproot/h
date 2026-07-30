import type { DeniedEntry, ExecPolicy } from "./models/exec.model.ts";

/**
 * The executor-policy decision (docs/plans/live-state-containment.md §2.3, extended by
 * docs/plans/impl/usage-limit-auto-deny.md with provenance + expiry) — the pure half of the
 * activity-registry gate and of the watcher's auto-deny, in the decide-on-a-row shape the
 * engines use. The gate wraps every `run-*` activity: nothing reaches a model without
 * passing through one, so a denial here is enforcement, not convention.
 */

const RUN_PREFIX = "run-";
const AGENT_SUFFIX = "-agent";

/**
 * How long an automatic usage-limited deny holds before expiring. Provider reset windows
 * differ (5h rolling for some, daily for others); this is the conservative single default the
 * plan chose over a per-provider table — `h agents allow X` lifts it early, `h agents deny X`
 * upgrades it to a never-expiring operator entry. NOTE the deliberate composition with the
 * usage-limit fallback (schedule-and-fallback): a SAME-agent deferred continuation fires into
 * this deny and is refused at the gate — fail-fast by design, since the limit that stopped
 * the original run almost certainly still holds; the deny's expiry is the effective retry
 * gate. A DIFFERENT-agent fallback (the primary use) is untouched.
 */
export const DEFAULT_AUTO_DENY_MS = 6 * 60 * 60 * 1000;

/**
 * The executor shortname a run activity invokes: the activity name minus `run-`
 * (`run-codex` → `codex`, `run-dapr-agent` → `dapr-agent`). Undefined for a non-run activity —
 * provisioning activities (setup, clone-repo, register-*) carry no executor and are never gated.
 */
export function executorFromActivity(activityName: string): string | undefined {
  return activityName.startsWith(RUN_PREFIX) ? activityName.slice(RUN_PREFIX.length) : undefined;
}

/**
 * The executor shortname behind an agent service id, for the watcher's auto-deny (the run
 * ledger keys carry the agentId): strip the `-agent` suffix (`codex-agent` → `codex`,
 * `langgraph-agent` → `langgraph`) — EXCEPT `dapr-agent`, whose shortname IS `dapr-agent`
 * (its activity is `run-dapr-agent`; stripping would deny a name the gate never matches).
 */
export function executorFromAgentId(agentId: string): string {
  if (agentId === "dapr-agent") return agentId;
  return agentId.endsWith(AGENT_SUFFIX) ? agentId.slice(0, -AGENT_SUFFIX.length) : agentId;
}

/**
 * The policy's denied list as entries: a bare string (the pre-provenance shape) reads as a
 * never-expiring operator entry stamped with the row's updatedAt.
 */
export function normalizeDenied(policy: ExecPolicy | undefined): DeniedEntry[] {
  if (policy === undefined) return [];
  return policy.denied.map((d) =>
    typeof d === "string"
      ? { name: d, reason: "operator" as const, deniedAt: policy.updatedAt }
      : d,
  );
}

/** The entry currently denying this executor, honouring expiry; undefined when allowed. */
export function activeDenial(
  policy: ExecPolicy | undefined,
  executor: string,
  nowIso: string,
): DeniedEntry | undefined {
  return normalizeDenied(policy).find(
    (e) => e.name === executor && (e.until === undefined || e.until > nowIso),
  );
}

/**
 * True when the policy denies this executor NOW. An absent policy (no `exec:config` row yet),
 * an empty list, or only-expired entries allow — deny is explicit, allow is the default.
 */
export function isExecutorDenied(
  policy: ExecPolicy | undefined,
  executor: string,
  nowIso: string,
): boolean {
  return activeDenial(policy, executor, nowIso) !== undefined;
}

/** The refusal text a gated activity throws — names the executor, why, and the way back out. */
export function deniedMessage(executor: string, entry?: DeniedEntry): string {
  const why =
    entry?.reason === "usage-limited"
      ? ` (auto: a run finalized usage-limited at ${entry.deniedAt}` +
        (entry.until ? `, expires ${entry.until})` : ")")
      : entry?.reason === "cost-budget"
        ? ` (auto: daily cost budget crossed at ${entry.deniedAt}` +
          (entry.until ? `, expires ${entry.until})` : ")")
        : "";
  return (
    `executor '${executor}' is denied by the exec:config policy${why} — ` +
    `re-enable with: h agents allow ${executor}`
  );
}

/**
 * The watcher's auto-deny merge (docs/plans/impl/usage-limit-auto-deny.md): fence `executor` with
 * a usage-limited entry expiring after DEFAULT_AUTO_DENY_MS. Returns the next policy to save,
 * or null when nothing should change: an operator entry for the executor exists (an auto
 * action never downgrades an operator decision — it is already denied anyway), or an ACTIVE
 * auto entry already covers it (idempotent across scan ticks). An EXPIRED auto entry for the
 * executor is replaced; other executors' entries pass through untouched.
 */
export function mergeAutoDeny(
  policy: ExecPolicy | undefined,
  executor: string,
  nowIso: string,
): ExecPolicy | null {
  const entries = normalizeDenied(policy);
  const existing = entries.find((e) => e.name === executor);
  if (existing?.reason === "operator") return null;
  if (existing && (existing.until === undefined || existing.until > nowIso)) return null;
  const until = new Date(new Date(nowIso).getTime() + DEFAULT_AUTO_DENY_MS).toISOString();
  const entry: DeniedEntry = { name: executor, reason: "usage-limited", deniedAt: nowIso, until };
  return {
    denied: [...entries.filter((e) => e.name !== executor), entry],
    updatedAt: nowIso,
    // Budgets ride along untouched — a deny merge must never drop the budget table (A1).
    ...(policy?.budgets ? { budgets: policy.budgets } : {}),
  };
}

/**
 * The end of `nowIso`'s UTC day — when a `cost-budget` deny expires: the watch ledger the
 * budget tally reads is keyed by UTC date, so the fence lifts exactly when the day's spend
 * counter resets.
 */
export function endOfUtcDayIso(nowIso: string): string {
  const day = new Date(nowIso);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1),
  ).toISOString();
}

/**
 * The watcher's daily-budget merge (docs/plans/cost-containment.md A1), sibling of
 * {@link mergeAutoDeny} with the same safety posture: fence `executor` with a `cost-budget`
 * entry expiring at the next UTC midnight (the day-ledger reset). Returns null when nothing
 * should change — an operator entry exists (never downgraded), or ANY active entry already
 * covers the executor (already fenced; idempotent across scan ticks). An expired auto entry
 * is replaced; other executors' entries pass through untouched.
 */
export function mergeBudgetDeny(
  policy: ExecPolicy | undefined,
  executor: string,
  nowIso: string,
): ExecPolicy | null {
  const entries = normalizeDenied(policy);
  const existing = entries.find((e) => e.name === executor);
  if (existing?.reason === "operator") return null;
  if (existing && (existing.until === undefined || existing.until > nowIso)) return null;
  const entry: DeniedEntry = {
    name: executor,
    reason: "cost-budget",
    deniedAt: nowIso,
    until: endOfUtcDayIso(nowIso),
  };
  return {
    denied: [...entries.filter((e) => e.name !== executor), entry],
    updatedAt: nowIso,
    ...(policy?.budgets ? { budgets: policy.budgets } : {}),
  };
}
