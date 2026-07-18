**Status:** IN PROGRESS (started 2026-07-18). Phase 1 (the `cron:sched` variant) building now;
Features 3/2/1 phased behind it. **Living doc** — update the Decisions + Progress log as increments
land.

# Schedule at a time, pause/resume, and usage-limit fallback — the `cron:sched` variant

## Context

We can kick off a workflow (today, predominantly Claude-based) but we cannot yet:
1. **Continue the work with a different agent/model when we hit LLM usage limits** (Feature 1).
2. **Pause a run and resume it after a configurable delay** — wait out a rate-limit refresh window
   (Feature 2).
3. **Schedule a workflow to run at a certain time** (Feature 3).

All three want the same missing capability: **fire a workflow ONCE at a future time.** h has the
recurring cron family (`cron:sub:*` recur, `cron:discover:*` fan-out) but nothing that fires once at
an absolute time. That one-shot is the spine; the three features are its consumers.

What exists today (grounded in exploration):
- **Every engine shares one shape** — a durable registry row (single-writer prefix) + a pure
  `decide()` + a scan on the 60s `workflow-cron-tick` + a closed action vocabulary, epoch-fenced:
  the watcher (retry/supervise), the chain (sequence), and the cron family.
- **The cron family already has two variants** under the `cron:` umbrella, both riding the same tick
  and served by the same store, each with its **own row schema + own pure decide + own scan**:
  **recur** (`cron:sub:*`, `cron-engine.ts`) and **discover/fan-out** (`cron:discover:*`,
  `discover-engine.ts`). They share only the tick, the `cron:` store adapter, the `cron:config`
  kill-switch, and the `cron:ledger:<date>` tally. This is the exact precedent the one-shot follows.
- **Executor-swap already works**: chains run member-1-as-Claude, member-2-as-openhands/pi with
  different `--model`s (`cli/h/src/h_cli/config.py` `AGENT_IDENTITY` → `{runActivity, agentId}`,
  resolved by `generic.workflow.ts` `getActivity(resolveTokenString(step.activity, results))`). The
  watcher's `escalate` fires a *different* saved workflow.
- **Usage-limit detection does not exist**: agent success is `exitCode === 0`
  (`packages/js/agent-cli/src/agents/parse-stream.ts` `buildInvocationResult`); a rate-limit is
  indistinguishable from a crash, and a limited Claude run can even **exit 0** (reporting `COMPLETED`
  at the Dapr level).

Why we do NOT reuse the existing "schedule" footprint: `WorkflowSchedule = {cron, savedAt,
lastRunAt?}` on `StoredWorkflow.schedule` + `scheduling.ts` (`isDue`/`assertValidCron`) +
`store.listScheduled()`/`markRun()` + `scanAndFire()` is a **recurring cron string** on a saved
workflow — cadence-only, no per-fire state (no identity override, no workspaceId, no budget), saved
workflows only. Neither it nor the cron primitive does one-shot. So one-shot is genuinely new
machinery — housed as the **third cron-family variant** (`cron:sched:*`), not a new top-level
primitive and not a mode fused into the recurring row.

## Decisions (locked with the user, 2026-07-18)

1. **One-shot lives as the cron-family variant `cron:sched:*`** — its own row schema + pure decide +
   scan, riding the cron tick and served by the cron store, exactly like `cron:discover:*`. **Not
   bound to recurring cron logic** (no cadence, no `maxFires` budget, no goal-resolution, no
   in-flight guard). Rationale: "the goal is a one-shot firing of a workflow — this is clean."
   Preserves the schedule/cron wording, adds no parallel top-level primitive, avoids fusing
   mode-branches into `CronRow`/`cron-engine.decide`.
2. **Pause = stop-and-continue, not freeze-the-fiber.** On pause the run ends; a `cron:sched:` row
   waits, then re-fires a continuation reusing the same `workspaceId` (worktree/state carry over).
   No held-open orchestration instance. Trade-off accepted: the continuation re-enters the workflow
   from the top — mid-step progress rides the persisted worktree + the agent's own session resume,
   not a frozen fiber. (In-fiber `ctx.createTimer` is the deferred escape hatch if a true mid-step
   freeze is ever needed — not built now.)
3. **Usage-limit detection = both, passive first.** A heuristic classifier over CLI
   stderr/exit/result-event (catches the exit-0-with-error-result case), AND a cooperating agent
   self-reporting `USAGE_LIMITED` in structured output. The watcher reads whichever surfaces.
4. **Phased, spine first.** Build the variant, then schedule (F3), then pause/resume (F2), then
   detection, then fallback (F1). Detection is independent (parallelizable).

## The spine: the `cron:sched` one-shot variant (mirror the discover variant)

Modeled on the `cron:discover:*` precedent: distinct schema, distinct engine, distinct scan, shared
cron store + tick + kill-switch + ledger. Essence: fire a `source` under an `instanceId` **once**
when `now >= fireAt`, then deactivate.

### `apps/workflow-svc/src/domain/models/schedule.model.ts` (sibling of `discover.model.ts`)
```
SchedStatus  = Literal("armed","fired","expired","disarmed")
SchedOutcome = Literal("fired","expired","disarmed")
SchedRow = {                       // persisted at cron:sched:<id>
  id, status: SchedStatus,
  fireAt: string,                  // absolute ISO — fire once when now >= fireAt
  notAfter?: string,               // optional deadline → expire if missed
  source: CronSource,              // REUSE saved|embedded; params carry identity override + workspaceId
  instanceId: string,              // the instance the fire runs under
  epoch: number,                   // fence, bumped on fire/disarm
  watch?: WatchPolicy,             // the fired continuation is itself supervised
  wf?: WfIdentity,
  origin?: string,                 // "at" | "pause" | "fallback:usage-limited"
  handoffsRemaining?: number,      // F1 budget across a fallback chain
  firedInstanceId?, outcome?, note?, createdAt, updatedAt, firedAt?
}
```
No cadence/budget/resolved/in-flight fields — deliberately none of the recurring row's machinery.
Import-light (Schema + cron/watch/wf models). Identity override is just `source.params`
(`runActivity/agentId/modelPlan…`), resolved by `generic.workflow.ts` as a normal run. Shares
`cron:config`, `cron:__tick__`, and `cron:ledger:<date>` (new `scheduledFires` counter, mirroring
discover's `discoveryFires`).

### `apps/workflow-svc/src/domain/schedule-engine.ts` (pure, sibling of `discover-engine.ts`)
```
decide(row, nowMs): { kind: "wait" | "fire" | "expire" }
  status !== "armed"                     → wait
  notAfter && Date.parse(notAfter) < now → expire
  Date.parse(fireAt) <= now              → fire   // self-healing: fires late after an outage
  else                                   → wait
```

### `apps/workflow-svc/src/domain/schedule-scan.ts` (sibling of `discover-scan.ts`)
- `registerSchedForFire(reg)` — idempotent ensure-exists (an already `armed`/`fired` row is a
  no-op; epoch continues from prior).
- `disarmSched(id)` — epoch-fenced (mirror `disarmCron`).
- `scanSchedEffect(traceparent)` — kill-switch gate (`cron:config`), list `armed` rows, per-row
  `Effect.catchAll` isolation, `decide`, execute.
- `executeFire` — mark-before-fire (bump epoch, `status:"fired"`, stamp `firedInstanceId`,
  `saveFenced` on the OLD epoch) so a crashed fire still burns the row; then fire the continuation
  **through `invokeWithWatch`** so it lands a `watch:` row. Build the request from `source` like
  `fireCron`, stamping `instanceId`/`wf`/`workspaceId`, merging `source.params`. Ledger bump.
- `executeExpire` — deactivate `status:"expired"`, fenced, no fire.
- Env: `CronStore | WorkflowInvoker | WorkflowStore | WatchStore | DaprPublisherTag`.

### Store + tick + router (reuse cron infrastructure, as discover does)
- `ICronStore` / `dapr-cron-store.ts` — extend to serve `cron:sched:*` exactly as it serves
  `cron:discover:*`: `getSchedRow/listSchedRows/saveSchedRow/deleteSchedRow`, index
  `cron:sched-index`. Only workflow-svc writes `cron:*`.
- `cron.router.ts` `tickEffect` — add `scanSchedEffect` as the fifth scan, `catchAll`'d so its
  failure never fails the tick. `GET /cron/list` — include the `cron:sched:*` rows.

## Feature 3 — schedule at a time (`--at` / `--in`)
`RunSavedBody` gains `at?`/`in?`; when present the `/workflow/run/:key` handler computes `fireAt` and
`registerSchedForFire`s instead of `invokeWithWatch`, returning `{ scheduled, fireAt }`. Fail-fast on
a bad ISO/duration. CLI `workflow.py run`: `--at`/`--in` (machinery). Duration parser generalizes
`_parse_budget` → `_parse_duration` (`s/m/h/d`). New `h schedule list|rm` (thin view over
`cron:sched:*`; also visible in `h cron list`).

## Feature 2 — pause / resume (reuses the sched arm)
`h workflow pause <instanceId> --in <dur>` = terminate + arm a `cron:sched:` row re-firing the saved
key with the same `workspaceId` at `now + dur`, `origin:"pause"`. `h workflow resume <schedId>` =
fire now. No new engine. (Limitation: stop-and-continue, re-enters from step 1.)

## Feature 1 — usage-limit → fallback agent/model
- **Detection (passive)** — `packages/js/agent-cli/src/agents/classify-stop.ts`:
  `classifyStop(...) → "completed"|"usage-limited"|"timeout"|"failed"`, positive-match-only patterns
  (rate-limit/429/quota/overloaded/RateLimitError), **excluding** context-window overflow. Wired into
  `buildInvocationResult` (`parse-stream.ts`). The Claude CLI can emit `{type:"result",
  is_error:true}` while exiting 0 — extend `StreamEvent` (`types.ts`) with `is_error?`/result-text.
  Add `stopReason?` to `InvocationResult`; `success` stays `exitCode === 0` (orthogonal).
- **Detection (active)** — a template's `outputs:` declares `status: {enum:[COMPLETE, STOPPED_EARLY,
  USAGE_LIMITED]}`; a new `stoppedEarly(results)` in `generic.workflow.ts` reads it like
  `goalResolved`.
- **Propagation** — a usage-limited run may be Dapr-`COMPLETED`, so `watch-engine.decide()` must NOT
  change. Add `stopReason` to the `run:<id>:*` ledger mirror; `getRunStopReason` on `IWatchStore`;
  in `executeFinalize` refine `completed → usage-limited` from the mirror; add `"usage-limited"` to
  `WatchOutcome`.
- **Fallback** — `WatchFallbackPolicy {onOutcome, after?, identity, maxHandoffs}` on `WatchPolicy`;
  `executeFallback` (dispatched from `executeFinalize`) arms a `cron:sched:` row with `source =
  embedded(resubmit.steps, params ⊕ fallback.identity, workspaceId)`, `fireAt = now + after`, `watch`
  carrying `handoffsRemaining - 1`, `origin:"fallback:usage-limited"`. Fail-closed on
  `maxEngineFiresPerDay` and `handoffsRemaining <= 0`. CLI `--fallback-agent/-model/-after/-max`
  (implies `--watch`). fallback ≠ escalate ≠ retry: *deferred retry with an identity swap*.

## Phasing
1. `cron:sched` variant (spine) — model + engine + scan + store extension + tick wiring + list +
   unit tests.
2. Feature 3 — `--at`/`--in` + CLI + `h schedule`.
3. Feature 2 — pause/resume.
4. Usage-limit detection — classifier + propagation (4b active self-report).
5. Feature 1 fallback — policy + `executeFallback` + CLI.

## Hardening + verification
- Single-writer `cron:` (incl. `cron:sched:`) — prefix literals only in `dapr-cron-store.ts`;
  lint/test that no other file references `cron:sched:`. Update `ARCHITECTURE.md` + `CLAUDE.md` (cron
  family's third variant, "fire ONCE at a future time").
- Fail-closed budgets in `executeFallback` (no `maxEngineFiresPerDay` → no fire; stop at
  `handoffsRemaining <= 0`).
- Unit tests mirror the discover split: `schedule-engine.test.ts`, `schedule-scan.test.ts`,
  `classify-stop.test.ts`, `watch-scan.test.ts` additions.
- E2E: F3 `h workflow run <key> --in 2m` → `h schedule list` armed → fires after a tick; F2 pause →
  resume reusing workspaceId; F1 `--fallback-agent openhands` + injected rate-limit → `usage-limited`
  → armed fallback → openhands continuation. Correlate via obs MCP + `analyze-workflow-run`.

## Risks
1. Detection is heuristic (provider strings drift) — positive-match-only, never suppress a real
   failure; active self-report is the durable signal.
2. Outcome inversion — a usage-limited run is Dapr-`COMPLETED`; the watcher refines outcome from the
   ledger, not run status. Comment it so nobody folds it back into `decide()`.
3. Pause loses in-run progress — stop-and-continue, not freeze (accepted).
4. `fireAt` past after an outage fires late (self-healing); `notAfter`→expire for time-critical `--at`.
5. Cross-package run-mirror schema — adding `stopReason` touches `agent-server`; confirm that record.

## Progress log
- 2026-07-18 — plan approved; canonical doc created.
- 2026-07-18 — **all five phases IMPLEMENTED** (one change set):
  - **Phase 1 — `cron:sched` variant spine.** `domain/models/schedule.model.ts` (`SchedRow`,
    armed/fired/expired/disarmed) + `schedule-engine.ts` (pure `decide → wait|fire|expire`) +
    `schedule-scan.ts` (`registerSchedForFire` idempotent arm, `disarmSched`, `advanceSched`,
    `scanSchedEffect` mark-before-fire + fire via `invokeWithWatch`, `executeExpire`). Cron store
    extended to serve `cron:sched:*` (+ `cron:sched-index`), fifth scan wired into the tick,
    `GET /cron/list` surfaces sched rows. `scheduledFires` added to the cron ledger. Unit tests:
    `schedule-engine.test.ts`, `schedule-scan.test.ts`.
  - **Phase 2 — Feature 3 (schedule at a time).** `RunSavedBody` gains `at`/`in`; the run route
    arms a sched row (returns `{scheduled, fireAt}`) instead of firing. `scheduling.ts` gains
    `parseDurationMs`/`resolveFireAt`. CLI `--at`/`--in` + new `h schedule list|rm` (`commands/
    schedule.py`, `POST /cron/sched/disarm`). Tests: `scheduling.test.ts`, `workflow.router.test.ts`,
    `test_schedule.py`.
  - **Phase 3 — Feature 2 (pause/resume).** `SchedRow.workspaceId` (fire honors it → workspace
    reuse). `POST /workflow/pause/:instanceId` (terminate + arm continuation reusing workspace) +
    `POST /workflow/resume/:schedId` (`advanceSched`). CLI `h workflow pause`/`resume`.
  - **Phase 4 — usage-limit detection.** `agent-cli/agents/classify-stop.ts`
    (`classifyStop → completed|usage-limited|timeout|failed`, positive-match-only, context-window
    excluded) wired into `buildInvocationResult`; `StreamEvent.is_error`/`result` + `InvocationResult.
    stopReason` + the invoker's timeout/spawn synthetics. Runners (claude/pi/openhands) thread
    `stopReason` into the run-ledger; `RunOutcome`/`RunSummary` carry it → `run:<id>` mirror.
    `IWatchStore.getRunStopReason`; `refineUsageLimited` in `executeFinalize` upgrades completed/
    failed → `usage-limited` off the ledger (the OUTCOME INVERSION — out of band of `decide()`).
    `usage-limited` added to `WatchOutcome`. Tests: `classify-stop.test.ts`, `watch-scan.test.ts`.
  - **Phase 5 — Feature 1 (fallback).** `WatchFallbackPolicy` on `WatchPolicy`; `executeFallback`
    arms a `cron:sched:` row (embedded steps + identity override + workspace reuse), fail-closed on
    `maxEngineFiresPerDay` AND `maxHandoffs`, threading a decremented budget into the continuation's
    own watch policy. CLI `--fallback-agent/-model/-after/-max`. Tests in `watch-scan.test.ts`,
    `test_schedule.py`.
  - **Hardening/docs.** `cron:sched:` literal contained to `dapr-cron-store.ts` (single-writer,
    matching `cron:sub:`/`cron:discover:`); `ARCHITECTURE.md` + `CLAUDE.md` updated (cron family's
    third variant). All suites green: workflow-svc 272, agent-cli 39, agent-server 21, claude-agent
    13, pi-agent 2, openhands-agent 5, h-cli 192.
  - **DEFERRED (4b): active self-report.** The passive classifier ships; a template declaring
    `status: {enum:[COMPLETE, STOPPED_EARLY, USAGE_LIMITED]}` + a `stoppedEarly(results)` reader in
    `generic.workflow.ts` (mirroring `goalResolved`) is a follow-up — it needs the structured signal
    surfaced to where the watcher reads (the `run:` mirror or `wf:` row), which the passive path
    already covers for the common case.
  - **NOT LIVE-EXERCISED yet:** end-to-end against a running stack (arm → fire, pause → resume,
    inject a rate-limit → fallback). Build/dist note: the repo's TS 6.0.3 would not emit in the dev
    sandbox; agent-cli/agent-server `dist/` were rebuilt with TS 5.9.3 as a local stopgap — CI's
    `bun run build` regenerates them with 6.0.3 (dist is an untracked artifact).
