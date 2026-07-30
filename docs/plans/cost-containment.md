# Cost containment — budgets the engines enforce, accounting the ledger can't lose

Status: Planning — design + audit scope only; nothing here is implemented yet
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

- **A1. Per-executor daily cost budget → auto-deny** (the chassis exists: usage-limit
  auto-deny, docs/plans/impl/usage-limit-auto-deny.md). `exec:config` gains per-executor
  `{dailyBudgetUsd}`; when the watcher's finalization tally for the day (see B) crosses it,
  the watcher writes an **expiring `cost-budget` deny entry** — same single-writer,
  epoch-fenced, never-downgrades-operator semantics; the activity-registry gate already
  refuses denied executors on every fire path (chains, crons, re-fires, sched continuations,
  panel branches), so enforcement costs nothing new. Reason vocabulary grows:
  `operator | usage-limited | cost-budget`.
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

- **B1. Partial-usage capture on timeout/kill.** Strategies stream per-event usage; the
  ledger must tally cumulative usage/cost from received events when the run ends WITHOUT a
  final result (timeout, kill, crash), instead of defaulting to null/0. `stopReason` already
  lands on the summary — cost must too, flagged `costPartial: true`.
- **B2. Orphan reaping.** The invoker owns its CLI subprocess: on run timeout and on app
  shutdown it must kill the **process group** (the CLI spawns children), so no orphan can
  bill invisibly. (Same class as the sub-agent cache-poisoning fix: child processes must not
  outlive their contract.)
- **B3. Honest gaps.** A run that completed with nonzero duration and a run-capable agent but
  `costUsd: 0/null` is a **gap, not a zero** — the watcher's tally marks `costGap` per-run
  (today costGap only fires when NO mirror matches). `watch:ledger:<date>` gains per-agent
  subtotals + gap counts so a day's spend is auditable per executor at a glance.

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

## Open questions (for plan review)

1. A2's live cost signal: periodic mirror flush vs scan-side event tailing vs skipping A2
   entirely (is A1 + duration caps enough in practice?).
2. Budget scope: per-executor only, or also per-chain (a runaway loop-until-clean burns
   through any single-run cap)?
3. Should `cost-budget` denies block ONLY expensive kinds (review/implement) while allowing
   cheap `answer` tasks — i.e., is the deny binary or class-scoped?
4. Kimi's future: budget + quorum + no-caching documented — is $X/day of uncached Moonshot
   worth the roster diversity, and what is X?

## Related

- docs/plans/impl/usage-limit-auto-deny.md — the fence chassis A1 extends.
- docs/plans/worktree-integration-gate.md — the runs whose review panels surfaced all of this.
- docs/plans/carried-followups.md — candidate home for A3 (panel quorum) if not built here.
