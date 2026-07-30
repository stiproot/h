# Cost containment — budgets the engines enforce, accounting the ledger can't lose

Status: Active — Phase 1 audit complete (findings below); Phase 0 decisions being settled
Established: 2026-07-30

## Problem (evidence: 2026-07-30, the Moonshot $20 day)

One day of panel reviews spent ~$20 through the kimi executor (Moonshot Anthropic-compat), and
the runtime neither prevented nor even fully *recorded* it:

- **~$11.39 booked** across 9 ledgered kimi runs (reviews at ~$3.1–3.2 each, a plan run at
  $2.30). **~$6–8 never booked**, via three distinct accounting holes:
  1. **Timeout runs record `cost=0`** — `costUsd` is captured from the final result event,
     which a timed-out run never emits; two 30-minute runs billed their full duration and
     ledgered zero. No `costGap` fires because a `run:` mirror *does* exist — it's just wrong.
  2. **Orphaned CLIs are invisible** — when an agent app dies mid-run (OOM/SIGTERM), its
     spawned CLI subprocess survives, re-parented, and runs to completion billing the provider
     with no ledger entry at all (observed live: a panel branch whose app was killed).
  3. **Failed rounds re-bill** — a panel whenAll fails when ONE branch fails; the other three
     completed branches' spend bought nothing, and the retry re-bills all four.
- **Why each review costs $3+**: Moonshot's Anthropic-compat endpoint does not honor prompt
  caching — every per-turn usage event shows `cached_tokens: 0`, so each of ~100 agentic turns
  re-bills the full ~100k context at full input rate (~3.8M input tokens per review). The same
  shape on claude pays ~10% for repeated context via the 1h cache. Compounded by provider
  rate-limiting (460 rate-limit events that day) stretching runs into their timeouts.
- **No enforcement surface existed**: every h budget lever is time- or count-denominated
  (watch `maxDurationMs`; cron `maxFires` / `max-per-day` / `run-budget-mins`). The one
  cost-shaped mechanism — the watcher's finalization tally into `watch:ledger:<date>` — is
  observability-only, and per hole 1 it undercounts.

Operational state (already applied, not part of this plan's build): kimi is operator-denied
(`h agents deny kimi`), so the activity-registry gate refuses `run-kimi` on every fire path
until the machinery below exists.

## The watcher model this plan builds on (corrected, current reality)

The watcher is **not opt-in**: every workflow-svc fire path registers `watch:sub:<instanceId>`
in the same handler that schedules the run (persist-then-invoke), one row per workflow
instance. The per-fire choice is the **policy** — `maxDurationMs`, `retry`, `escalate`. Cost
enters only at **finalization**: the scan tallies `costUsd` off the run's `run:` mirrors
(zero matches → `costGap`). There is no mid-run cost signal and no cost policy knob. This plan
adds cost as a first-class budget axis at two altitudes: per-run (watch policy) and
per-executor-per-day (exec policy), and makes the underlying tally trustworthy for every
agent shape.

## Workstream A — enforcement: budgets the engines act on

- **A1. Per-executor daily cost budget → auto-deny. DONE 2026-07-30** (the chassis existed:
  usage-limit auto-deny, docs/plans/impl/usage-limit-auto-deny.md). As designed: `exec:config`
  gained a `budgets` table ({shortname: dailyBudgetUsd}); `executeBudgetCheck` runs after every
  finalize's ledger bump, sums the day ledger's `costByAgent` per executor, and writes a
  `cost-budget` deny expiring at the next UTC midnight via `mergeBudgetDeny` (never downgrades
  operator, idempotent — sibling of mergeAutoDeny; BOTH merges now preserve the budget table,
  as do POST /exec/policy replacements). Reason vocabulary grew to
  `operator | usage-limited | cost-budget`; the gate needed nothing new. Surface:
  `POST /exec/budget`, `h agents budget <name> <usd>|--clear`, and `h agents list` gained
  budget + today-spend columns (GET /exec/policy now returns `budgets`/`todaySpend`/
  `todayCostGapRuns` off the day ledger) plus a gap warning line; the url column was dropped
  (it truncated to noise at table width).
- **A2. Per-run cost ceiling — `maxCostUsd` in the watch policy.** The watcher terminates a
  running workflow whose tallied-so-far cost crosses the ceiling, finalizing
  `outcome: cost-capped`. Requires a **live cost signal** (today mirrors land at run end):
  the cheapest sufficient design is the ledger flushing a cumulative-usage snapshot to the
  `run:` mirror periodically (e.g. every N events / M seconds, best-effort like all ledger
  writes) — the scan already reads mirrors each tick. Alternatives to weigh at design review:
  events.jsonl tailing by the scan (couples engine to fs), or app-side self-report. A2 is
  gated on B1's partial-usage capture; if live flushing proves heavy, A2 degrades gracefully
  to "cap enforced at next mirror flush," which still bounds spend.
- **A3. Panel quorum (cost-adjacent).** An N-1 quorum for panel groups — a failed branch is
  surfaced in the judge's synthesis instead of failing the whenAll — so one throttled provider
  stops erasing (and re-billing) whole rounds. Scoped here only as the cost rationale; the
  design belongs to its own issue (panel semantics, unanimity rule interaction).

## Workstream B — accounting integrity: a tally that can't silently lose money

- **B1. Partial-usage capture on timeout/kill. DONE 2026-07-30.** Landed at the STRATEGY layer,
  not the ledger: `run-process.ts` now handles the timeout where `streamEvents` is in scope and
  builds the exit-124 result via `buildInvocationResult` + `extractMetrics` (previously
  `AgentTimeoutError` short-circuited past both, discarding every collected event). claude's
  `extractMetrics` folds per-API-call `message.usage` off assistant events when no terminal
  result event exists — deduped by `message.id` (verified live: 30 events / 14 ids), flagged
  `costPartial: true` (tokens/model/turns; per-event cost does not exist in the stream, so
  costUsd stays absent → a B3 gap). All five JS runners' FAILED-exit ledger finish now carries
  the result's metrics instead of dropping them (the audit's hole-1b). `costPartial` threads
  `InvocationResult → RunOutcome → RunSummary → run: mirror`; py `record_run` gained
  `stopReason`/`costPartial` parity (honest None — py runners don't classify yet).
  **C3 fixed in the same change**: `buildInvocationResult` counts `system/api_retry` events
  (429/rate_limit — the captured marker shape) and `classifyStop` classifies a timeout with
  ≥3 such retries as `usage-limited`, so a throttle-stretched run reaches the fence/fallback.
- **B2. Orphan reaping. DONE 2026-07-30.** Finding first: `@effect/platform-node` already spawns
  the CLI `detached` (a process-group leader) and its scope release group-kills a still-running
  or nonzero-exited child — so the timeout path was half-covered all along (a first setsid-based
  attempt was reverted as redundant AND harmful: setsid forks when the child is already a leader,
  swallowing exit codes). What was actually missing, now in `agent-cli/src/agents/reaper.ts` +
  a run finalizer in run-process.ts:
  1. **App death** — `process.exit()` (SIGTERM/SIGINT/uncaught paths) runs no Effect finalizers;
     every live run registers in the reaper and a `process.on("exit")` hook SIGKILLs the live
     groups. Residual (documented): SIGKILL/OOM of the app itself in HOST mode — container mode's
     PID-namespace death reaps everything anyway.
  2. **The dropped-uid group** — a `kill(-pid)` from the app's uid reaches only sudo itself
     (which relays to its one command child; grandchildren survive). The reap also shells
     `sudo -u #uid kill -- -pgid`, the identity allowed to take the whole group (covered by the
     agent-base sudoers `ALL` grant).
  3. **Clean-exit leftovers** — the platform skips cleanup on exit 0; the run finalizer
     group-kills on every scope close, so a background child the agent left running dies with
     the run. Live-validated by a Linux-gated invoker test: a timed-out run's GRANDCHILD is dead
     after the finalizer.
- **B3. Honest gaps. DONE 2026-07-30.** `tallyCost` (watch) and `tallyChainCost` (chain) now
  read a `RunMirrorMeta` slice per mirror (the port cutover: `getRunCost`/`getRunStopReason` →
  one `getRunMeta`, shared pure parser `runMirrorMetaFrom` in watch.model.ts): `kind:
  "activity"` records excluded, an agent-run mirror with costUsd 0/null counts as a PER-RUN gap
  (`costGap` no longer fires only on zero matches), and per-agent subtotals land on the day
  ledgers — `WatchLedger`/`ChainLedger` gained optional `costByAgent` + `costGapRuns` (optional
  so pre-existing ledgers decode).

## Workstream C — the audit: every agent shape, same questions

Run the same checklist over **every executor** — claude, openhands, pi, codex, kimi (and the
Python in-process agents that take the `/run` route) — since each `agent-cli` strategy parses
its own CLI's stream shape, capture quality varies per strategy and must be verified, not
assumed. pi and openhands are *suspected* fine (no usage-limit incidents to date) — the audit
proves it rather than trusting the absence of pain.

Per agent/strategy:
1. **Cost metrics reach disk**: the strategy's stream parser captures per-event usage AND the
   run summary lands `costUsd` + token counts (`ModelUsage`) + `stopReason` in
   `summary.json`/the `run:` mirror. Name the field mappings per shape; fix gaps.
2. **Caching honored?** Verify per-turn cache token counts are nonzero where the provider
   supports it (claude: expected; pi/openhands: depends on backing provider+SDK; codex:
   ChatGPT-plan billing is flat but API mode isn't; kimi: known broken — the finding that
   motivated this plan). Where caching is absent, document the per-review cost model and set
   A1 budgets accordingly.
3. **Limit/throttle classification**: rate-limit and quota responses must classify into
   `classifyStop` outcomes (`usage-limited`, not generic `failed`/`timeout`) so the existing
   auto-deny machinery sees them. Kimi's rate-limited runs today surfaced as
   `timeout`/invoke errors — the signal never reached the fence.
4. **Watcher coverage**: confirm the watcher's cost tally can read this agent's `run:` mirror
   shape — one loosely-typed mirror contract, every strategy writing it (the recent
   shape-per-agent strategy work should make this checkable per shape). The Python
   `record_run` sibling is in scope: same fields, same semantics.
5. **Runtime knobs encoded**: per-agent `AGENT_RUN_TIMEOUT_MS` (and any provider-specific
   pacing) lives in the run script/compose env — never in a shell that launched a supervisor
   once (the zombie-supervisor incident: an env-less supervisor won a stop_stale fight and
   silently reverted the timeout).

Audit output: a table in this plan (agent × the five checks), each cell pass/gap + fix filed.

## Phase 1 audit findings (2026-07-30, manual read of every strategy + both ledgers + the tally)

Table: agent × the five checks. ✅ pass, ◐ partial, ❌ gap. File pointers are the fix sites.

| Check | claude | kimi (=claude strategy) | codex | openhands | pi | py agents (`record_run`) |
|---|---|---|---|---|---|---|
| 1. cost→disk | ◐ success-path only | ◐ same, worse in practice | ❌ no cost (tokens only) | ❌ nothing ever | ❌ nothing (documented) | ❌ `cost_usd` never populated |
| 2. caching visible | ✅ cacheRead/Creation per model | ❌ provider returns cached:0 | ◐ cached_tokens folded into input | ❌ unobservable | ❌ unobservable | ❌ unobservable |
| 3. limit→`usage-limited` | ◐ timeout outranks limit | ❌ observed live miss | ◐ error events not in haystack | ◐ ConversationErrorEvent path ok (unverified live) | ◐ stderr regexes only (unverified) | ❌ no `stopReason` field at all |
| 4. watcher reads mirror | ✅ | ✅ | ◐ null cost → silent 0 | ◐ null cost → silent 0 | ◐ null cost → silent 0 | ◐ mirror exists; no stopReason |
| 5. timeout knob encoded | ❌ nowhere | ❌ nowhere | ❌ nowhere | ❌ nowhere | ❌ nowhere | n/a (in-process) |

**Mechanics behind the table (the fix sites):**

- **Hole 1 has TWO layers, not one.** (a) Timeout: `run-process.ts` raises `AgentTimeoutError`
  from `Effect.timeoutFail`, which short-circuits past `buildInvocationResult` — the accumulated
  `streamEvents` (with every per-turn usage event) are unreachable from the invoker's catch
  (`invoker.ts:124`), so the synthetic exit-124 result carries no usage. (b) **Every JS runner's
  failed-exit path drops metrics even when present**: `exitCode !== 0` → `Effect.fail` →
  `tapErrorCause → ledger.finish({status, output, error, stopReason})` — costUsd/tokens/model are
  omitted from the failure finish (kimi-runner.ts:144–148 & 172–179; same shape in claude/codex/
  openhands/pi runners). A nonzero-exit claude run that DID emit `total_cost_usd` ledgers
  `costUsd: null`.
- **The ledger already has the B1 seam**: `events.jsonl` receives every event incrementally
  (`onEvent` fires during the run), and `startRunLedgerEffect` already takes an injected
  per-strategy fold (`tallyToolCalls`). A sibling `tallyUsage` fold gives cumulative
  usage/cost during the run; `finish` uses it when the outcome carries none → `costPartial: true`.
- **C3 is a two-lock miss.** `classifyStop` (classify-stop.ts:50) returns `timeout` on
  signal/exit-124 BEFORE the usage-limit match, and its haystack is stderr + the terminal result
  event — kimi's 460 rate-limit markers were mid-stream events, so even without the ordering the
  markers never reach the classifier. And `refineUsageLimited` (watch-scan.ts:657) deliberately
  refines only `completed|failed`. Fix direction: classify from the event stream too (a strategy
  that saw N rate-limit events + timeout → `usage-limited`), not by loosening the refiner's
  outcome guard (budget-terminated/terminated stay non-limits).
- **Codex tokens may undercount**: `extractMetrics` takes the FIRST `type:"result"` event
  (codex.ts:204) = the first `turn.completed`; multi-turn runs would drop later turns' usage.
  Verify against a captured multi-turn events.jsonl before fixing.
- **Orphans (hole 2)**: the Effect scope finalizer kills the child only on fiber interruption
  (timeout) — an app death (OOM/SIGTERM) orphans the CLI; and the kill targets the direct child
  pid, not the process GROUP the CLI spawned (grandchildren survive even the timeout path).
- **Timeout knob (C5)**: `AGENT_RUN_TIMEOUT_MS` is read by all five runners (30-min code default)
  but set in NO run script, compose file, or `.env.example` — any operator override lives in a
  shell export today, exactly the zombie-supervisor anti-pattern the check exists to prevent.
- **Kimi cost caveat (C2)**: the ~$3.1/review "booked" figures are the claude CLI's own computed
  `total_cost_usd` — priced at Anthropic rates for a Moonshot model. Treat booked kimi cost as
  an estimate, not invoice truth; the audit documents this blind spot per the non-goals.
- **Python agents**: `record_run` writes `costUsd` (always null in practice — no py runner
  populates `cost_usd`) and has **no `stopReason` field**, so a py-agent usage limit can never
  reach the fence. Same fields, same semantics as the JS ledger is the parity bar.

## Non-goals

- No new pricing tables in h. Cost figures come from what providers/CLIs report; the audit
  documents per-provider blind spots instead of re-deriving billing.
- No provider-side caching fixes (Moonshot honoring cache markers is not ours to build); the
  remedy is budget + fence + informed routing of task classes to executors.
- Panel quorum design (A3) — rationale here, design elsewhere.

## Phases

- **Phase 0 — this plan reviewed** (panel), decisions A1/A2 design settled.
- **Phase 1 — Workstream C audit** (read-only; produces the table + filed gaps). First,
  because A/B implementation details depend on what each shape actually emits.
- **Phase 2 — Workstream B** (partial usage, orphan reaping, honest gaps) — the tally becomes
  trustworthy.
- **Phase 3 — Workstream A1** (daily budget auto-deny) on the now-trustworthy tally; then A2
  (`maxCostUsd`) if the live-signal design holds up.
- **Phase 4 — e2e validation**: a deliberately cheap-budgeted executor crosses its ceiling in
  a controlled run; observe fence, refusal, and ledger honesty; cookbook-stamp.

## Phase 0 decisions (settled 2026-07-30, operator + assistant review — no panel)

1. **A2: build it, on the mirror-flush design.** B1's cumulative-usage fold makes a periodic
   flush of the running tally to the `run:` mirror nearly free; the watch scan reads mirrors
   each tick, so `maxCostUsd` enforces with ≤1-tick lag. Scan-side event tailing rejected
   (couples engine to fs).
2. **Budget scope: per-executor-per-day only.** Loop chains stay bounded by their own loop
   budget; a per-chain cost axis waits for evidence.
3. **`cost-budget` deny is BINARY** — same semantics as operator/usage-limited entries, plus
   expiry. The gate stays one check; class-scoping (denying only expensive kinds) can be added
   later without unwinding anything, but threading a task-class through every fire path is not
   paid for today.
4. **Kimi stays operator-denied until A1 + Workstream B land.** The daily-budget number is
   decided then, with trustworthy tallies in hand — not pre-committed on estimated figures
   (the booked kimi costs are CLI-computed at Anthropic rates, see audit caveat).

## Related

- docs/plans/impl/usage-limit-auto-deny.md — the fence chassis A1 extends.
- docs/plans/worktree-integration-gate.md — the runs whose review panels surfaced all of this.
- docs/plans/carried-followups.md — candidate home for A3 (panel quorum) if not built here.
