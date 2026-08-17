import { WorkflowError } from "core";
import type { WatchPolicy } from "./models/watch.model.ts";
import { Effect, Option } from "effect";

import { decideDiscover as decide } from "./internal.ts";
import { cronLedgerDate } from "./internal.ts";
import {
  type DiscoverGates,
  type DiscoverRow,
  type DiscoverSource,
  type DiscoverTemplate,
  discoverId,
  discoverTrigger,
  issueInstanceId,
  issueSlug,
} from "./internal.ts";
import { toRequest } from "./internal.ts";
import { CronStore } from "./internal.ts";
import { SourceReader } from "./internal.ts";
import { WatchStore } from "./internal.ts";
import { WfStore } from "./internal.ts";
import { WorkflowInvoker } from "./internal.ts";
import { WorkflowStore } from "./internal.ts";
import { invokeWithWatch } from "./watch-scan.ts";

/**
 * The effectful half of the DISCOVERY cron, the fan-out
 * sibling of cron-scan.ts: registration on the CLI/route path, and the per-tick scan that reads each
 * active discovery row, asks the pure engine (discover-engine.ts) whether to enumerate, and — when it
 * says discover — reads the SOURCE (open issues, oldest-first), dedups each candidate against the
 * `wf:*` keys by exact read, and fires the OLDEST eligible under a fixed per-issue instance. Where a
 * recur cron RE-FIRES one workflow until its goal resolves, a discovery cron FANS OUT one fire per
 * newly-discovered issue, serialized (one in flight at a time) and bounded by a daily cap.
 *
 * Dedup is the duplicate-dispatch fix: the fired feature-pr writes `wf:<repo>:issue-<N>:feature-pr`
 * at its start (bracketing), so the next tick's exact-key read skips it — an issue with a row (running
 * OR done) is never re-dispatched.
 *
 * Read budget (Open Q3): the source is read ONLY after the in-flight + cadence + daily-cap gates, and
 * the scan stamps `lastRunAt` BEFORE reading (mark-scanned-before-read), so even a failing source read
 * doesn't re-hit the API until the next cadence. Every row-mutating action is epoch-fenced.
 * Single-writer: workflow-svc.
 */

const DEFAULT_MAX_FIRES_PER_DAY = 5;

export type DiscoverScanEnv =
  | CronStore
  | WorkflowInvoker
  | WorkflowStore
  | WfStore
  | SourceReader
  | WatchStore;

export type DiscoverScanReport = {
  scanned: number;
  fired: string[];
  skipped: string[];
  errors: string[];
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Registration (writes the cron:discover row; does NOT itself fire)
// ---------------------------------------------------------------------------

export type DiscoverRegistration = {
  readonly repo: string;
  readonly label: string;
  /** The fire-descriptor template fired per discovered issue (key required; params/watch optional —
   *  the per-issue identity is instantiated by the engine, see DiscoverTemplate). */
  readonly trigger: DiscoverTemplate;
  readonly cadence: string;
  readonly source?: DiscoverSource;
  readonly gates?: DiscoverGates;
};

/**
 * Registers (or epoch-refreshes) a discovery cron row. A re-registration of the same `<repo>:<label>`
 * coord refreshes the config (cadence/gates/params) and bumps the epoch (fencing any in-flight scan),
 * preserving the runtime state (lifetime `fires`, `lastRunAt`, the in-flight `currentInstanceId`).
 */
export const registerDiscover = (
  reg: DiscoverRegistration,
): Effect.Effect<{ discoverId: string; active: boolean }, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const id = discoverId(reg);
    const existing = yield* cs.getDiscoverRow(id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const prior = Option.getOrUndefined(existing);
    const row: DiscoverRow = {
      repo: reg.repo,
      label: reg.label,
      status: "active",
      cadence: reg.cadence,
      source: reg.source ?? { mode: "github-issues" },
      gates: reg.gates ?? { maxFiresPerDay: DEFAULT_MAX_FIRES_PER_DAY },
      trigger: reg.trigger,
      epoch: (prior?.epoch ?? 0) + 1,
      fires: prior?.fires ?? 0,
      ...(prior?.currentInstanceId ? { currentInstanceId: prior.currentInstanceId } : {}),
      ...(prior?.lastFiredIssue !== undefined ? { lastFiredIssue: prior.lastFiredIssue } : {}),
      ...(prior?.lastRunAt ? { lastRunAt: prior.lastRunAt } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    yield* cs.saveDiscoverRow(row);
    return { discoverId: id, active: true };
  });

// ---------------------------------------------------------------------------
// The scan (one per cron tick, beside the recur/chain/watch scans)
// ---------------------------------------------------------------------------

export const scanDiscoverEffect = (
  traceparent: string | undefined,
): Effect.Effect<DiscoverScanReport, WorkflowError, DiscoverScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const nowMs = Date.now();
    // Kill switch is shared across the cron siblings (cron:config); the heartbeat is beaten by the recur
    // scan (scanCronsEffect), which always runs on the same tick — no double-beat here.
    const config = yield* cs.getConfig();
    const enabled = Option.isNone(config) || config.value.enabled !== false;

    const report: DiscoverScanReport = { scanned: 0, fired: [], skipped: [], errors: [] };
    if (!enabled) return { ...report, disabled: true };

    const rows = (yield* cs.listDiscoverRows()).filter((row) => row.status === "active");
    report.scanned = rows.length;
    for (const row of rows) {
      // One discovery cron's failure never starves the rest.
      yield* processRow(row, nowMs, traceparent, report).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            report.errors.push(`${discoverId(row)}: ${messageOf(err)}`);
          }),
        ),
      );
    }
    return report;
  });

const processRow = (
  row: DiscoverRow,
  nowMs: number,
  traceparent: string | undefined,
  report: DiscoverScanReport,
): Effect.Effect<void, WorkflowError, DiscoverScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const cs = yield* CronStore;
    // In-flight guard: the last-fired instance's live status (UNKNOWN on transport failure — the engine
    // treats that as still-live, never double-firing).
    const runtimeStatus = row.currentInstanceId
      ? yield* invoker.getStatus(row.currentInstanceId).pipe(
          Effect.map((s) => s.runtimeStatus),
          Effect.catchAll(() => Effect.succeed("UNKNOWN")),
        )
      : undefined;
    const todayFires = (yield* cs.getLedger(cronLedgerDate(nowMs))).discoveryFires ?? 0;

    const decision = decide(row, runtimeStatus, todayFires, nowMs);
    if (decision.kind === "wait") return;
    return yield* executeDiscover(row, nowMs, traceparent, report);
  });

// ---------------------------------------------------------------------------
// Actions (each epoch-fenced)
// ---------------------------------------------------------------------------

/** Writes `next` only if the stored discovery row still carries `expectEpoch`; false when stale. */
const saveFenced = (
  expectEpoch: number,
  next: DiscoverRow,
): Effect.Effect<boolean, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const current = yield* cs.getDiscoverRow(discoverId(next));
    if (Option.isNone(current) || current.value.epoch !== expectEpoch) return false;
    yield* cs.saveDiscoverRow(next);
    return true;
  });

/**
 * Mark-scanned-before-read (stamp `lastRunAt` + bump epoch, fenced on the OLD epoch) so even a failing
 * source read doesn't re-hit the API until the next cadence — the read budget. Then read the source,
 * dedup each candidate vs its `wf:` row, and fire the OLDEST eligible.
 */
const executeDiscover = (
  row: DiscoverRow,
  nowMs: number,
  traceparent: string | undefined,
  report: DiscoverScanReport,
): Effect.Effect<void, WorkflowError, DiscoverScanEnv> =>
  Effect.gen(function* () {
    const now = new Date(nowMs).toISOString();
    const scanned: DiscoverRow = {
      ...row,
      epoch: row.epoch + 1,
      lastRunAt: now,
      note: "scanning source",
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, scanned);
    if (!saved) return;

    const sr = yield* SourceReader;
    const wfStore = yield* WfStore;
    const issues = yield* sr.listOpenIssues({ repo: row.repo, label: row.label });
    for (const issue of issues) {
      // Dedup by the run's OWN key. This read looks like it needs an artifact key — "have I ever
      // dispatched work for issue #123?" is asked with no instance id in hand — and it does not:
      // `issueInstanceId` is a pure function of the issue number, and it is the very id
      // `discoverTrigger` fires with. The asker's forgetting which run it was is irrelevant, because
      // the id is derived rather than remembered. That is the observation the 2026-08-17 re-key
      // turned on.
      const existing = yield* wfStore
        .getRun(issueInstanceId(issue.number))
        .pipe(Effect.catchAll(() => Effect.succeed(Option.none())));
      if (Option.isSome(existing)) continue; // dedup — already dispatched (running or done)
      return yield* fireDiscovered(scanned, issue.number, nowMs, traceparent, report);
    }
    // Nothing eligible this pass — lastRunAt already advanced, so the cadence throttles the next read.
    report.skipped.push(`${discoverId(row)}: nothing eligible`);
  });

/** Instantiate the row's per-issue fire descriptor (discoverTrigger), resolve its key, and fire it
 *  through the choke point (fresh, supervised when the descriptor carries a watch); then stamp the
 *  fired state. */
const fireDiscovered = (
  scanned: DiscoverRow,
  issueNumber: number,
  nowMs: number,
  traceparent: string | undefined,
  report: DiscoverScanReport,
): Effect.Effect<void, WorkflowError, DiscoverScanEnv> =>
  Effect.gen(function* () {
    const trigger = discoverTrigger(scanned, issueNumber);
    const store = yield* WorkflowStore;
    const stored = yield* store.get(trigger.key);
    if (Option.isNone(stored) || stored.value.disabled) {
      return yield* Effect.fail(
        new WorkflowError({
          cause: `discovery workflow key '${trigger.key}' missing or disabled`,
          instanceId: discoverId(scanned),
        }),
      );
    }
    const req = toRequest(stored.value, traceparent, trigger.params);
    yield* invokeWithWatch({
      ...req,
      instanceId: trigger.instanceId,
      workspaceId: trigger.workspaceId,
      fresh: true,
      wf: { repo: scanned.repo, slug: issueSlug(issueNumber), workflow: trigger.key },
      ...(trigger.watch
        ? {
            watch: trigger.watch,
            watchMeta: {
              owner: "discover",
              repo: scanned.repo,
              label: scanned.label,
              issue: String(issueNumber),
            },
          }
        : {}),
    });

    const now = new Date(nowMs).toISOString();
    const fired: DiscoverRow = {
      ...scanned,
      currentInstanceId: trigger.instanceId,
      fires: scanned.fires + 1,
      lastFiredIssue: issueNumber,
      note: `fired #${issueNumber}`,
      updatedAt: now,
    };
    // Fence on the scanned epoch (a re-registration between mark and fire no-ops this stamp).
    yield* saveFenced(scanned.epoch, fired);
    report.fired.push(`${discoverId(scanned)}#${issueNumber}`);
    yield* (yield* CronStore).bumpLedger(cronLedgerDate(nowMs), { discoveryFires: 1 });
  });

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string") return cause;
  return String(err);
}

/**
 * The CLI wire (`h cron discover add`) → a `DiscoverRegistration`.
 *
 * Small, and shared for the same reason `planCron` is: both engine hosts arm discovery crons from
 * the same operator command, and a row whose trigger template differed between them would fan out
 * differently for identical input. Pure, so it is testable without a store.
 */
export type DiscoverArmInput = {
  readonly repo: string;
  readonly label: string;
  /** The saved key fired per discovered issue. */
  readonly workflow: string;
  readonly cadence: string;
  readonly maxFiresPerDay?: number;
  /** Extra params merged into every fired run (e.g. fire-time identity). */
  readonly fireParams?: Record<string, unknown>;
  /** Watch policy attached to every fired run, so a hung one is terminated rather than stalling
   *  the discovery cron's one-in-flight serialize. */
  readonly watch?: WatchPolicy;
};

export const discoverRegistrationFrom = (input: DiscoverArmInput): DiscoverRegistration => ({
  repo: input.repo,
  label: input.label,
  cadence: input.cadence,
  ...(input.maxFiresPerDay !== undefined
    ? { gates: { maxFiresPerDay: input.maxFiresPerDay } }
    : {}),
  // The row embeds the wire as its fire-descriptor TEMPLATE: workflow → key, fireParams → params.
  trigger: {
    key: input.workflow,
    ...(input.fireParams ? { params: input.fireParams } : {}),
    ...(input.watch ? { watch: input.watch } : {}),
  },
});
