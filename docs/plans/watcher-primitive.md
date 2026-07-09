**Status:** SHIPPED (2026-07-05) — the engine-in-workflow-svc shape, the closed action vocabulary (including `escalate`), and the h-primitives vocabulary are adopted and implemented in one atomic cutover (Decision 7; see the Progress log). The spike ladder (§8) is retained for the record only. Outstanding: first live end-to-end exercise against the running stack.
**Living doc** — update the Decisions section and the Progress log as things land.

# The watcher primitive: decoupling supervision from invocation

## Context

The idea: today, supervision is coupled to invocation. Every agent service embeds a `WorkflowBabysitter`; `POST /workflow` both schedules the run **and** starts an in-process, non-durable watch loop (poll status every 10s, terminate on wall-clock budget breach, publish `workflow-events` on terminal — `packages/js/agent-server/src/workflow-babysitter.ts:121-146`, Python sibling in `packages/py/agent-server/src/agent_server/workflow_route.py`). The proposal is to separate them:

- The **workflow** just runs, emitting telemetry and persisting operational state (Dapr instance status, run ledger, traces) as it already does.
- A standalone **watcher** holds a *watcher configuration* describing how to interpret that data and what actions to take (today's budget/TTL/retry logic). Registration could be as light as a `--watch` flag that the `/workflow` endpoints translate into a registration, independent of the invocation.
- A watcher is a specialized workflow-on-a-poll: **watch → interpret → act**. Actions include calling endpoints (terminate), updating state, and invoking agents when judgment is needed.
- The larger goal is conceptual simplification: a standard set of **h primitives** — workflow, watcher, trigger, registry — from which complex components are composed.

What exists today, and the duplication that motivates this:

- **The babysitter** (JS + a deliberate byte-for-byte Python sibling): poll loop, TERMINAL set (`workflow-babysitter.ts:58`), 10s/45min defaults (`:122-123`), budget-terminate (`:135-144`), best-effort terminal publish (`:176-193`), UNKNOWN-on-failure keep-polling (`:148-161`). Its watch table is an in-process Map that restarts forget (`:61`, `:116` — "MVP" by its own comment).
- **The issue-sweep's reconcile step R** (`cli/charts/workflows/templates/issue-sweep.yaml:68-89`) is *already a hand-rolled watcher, in agent prose*: it polls `get_workflow_status` per in-flight issue, interprets (terminal classification, markers, `runBudgetMs` breach at `:80-81`, UNKNOWN-heal at `:82-83`), and acts (registry stamps, labels, comments, `terminate_workflow`, re-dispatch with `fresh: true`, cost tally at `:84-89`).
- The two duplicate each other on purpose (h-builds-h.md:174 calls the tick's budget re-enforcement the belt for restart-orphaned watches), and each holds behavior the other lacks: retry/attempt semantics and cost accounting exist **only in prose**; the fast 10s enforcement and terminal events exist **only in volatile code**. Nothing subscribes to `workflow-events` (h-builds-h.md:81). Trigger-fired and cron-fired runs are entirely unsupervised — only the agent-service `POST /workflow` path attaches a babysitter (h-builds-h.md ruling D2, line 91).

This exploration synthesized two grounding fact sheets, three independent designs (A: standalone `watcher-svc` with a registry + 10s cron scan; B: one Dapr actor per watch with durable reminders as the clock; C: watcher = a scheduled saved workflow scanning subscription rows), and an adversarial red-team pass. The red team's strongest finding is quoted up front because it shapes everything below: **the null hypothesis nearly wins.** The genuinely broken thing is ~one defect (the volatile watch Map) with a ~40-line durable fix, and the policy being encoded is two rules totaling ~25 lines — while every design shipped a rules DSL, new runtime machinery, or both to express it. This plan therefore treats the watcher as vocabulary worth having and machinery worth *proving in the smallest possible increments*, with an explicit exit at spike 0.

---

## 1. The h primitives frame

Vocabulary, not architecture — adopting these names costs nothing and makes the composition story teachable:

- **Workflow** — a durable step sequence that does work and leaves durable traces: Dapr instance status, run-ledger files + `run:<id>` statestore mirrors, Zipkin spans, all joined on `workflowInstanceId`. It never supervises anything, including itself.
- **Watcher** — a durable registration (`{subject, policy}`) plus a shared engine that, on a clock, reads a subject's *already-persisted* operational state, interprets it against the policy, and acts through a closed vocabulary. It does no domain work; when interpretation needs judgment it hands facts to an agent via a trigger. The babysitter and sweep step R are both instances of this — one in volatile code, one in prose.
- **Trigger** — anything that fires a workflow: HTTP `/workflow/run*`, a `workflow-trigger` event `{key, params}`, or the cron tick over saved schedules. Triggers are data; one well-known topic, not per-family topics.
- **Registry** — durable rows under a claimed prefix in the flat Redis keyspace, plus a hand-rolled index key (the `__workflow_index__` pattern, `apps/workflow-svc/src/infrastructure/dapr-workflow-store.ts:9-11`). Registries are where primitives meet as data: saved workflows, `sweep:*` (the issue-sweep's, renamed from `h-auto:*`), run mirrors, and `watch:*`. The convention: a registry prefix names the single component that owns writing it.

Honest caveat (the red team's point, accepted): "watcher" is a *composition* of the other three — a policy row in a registry, evaluated on a trigger's clock, acting on workflows. It earns primitive status in the docs only because supervision recurs often enough to deserve one name and one home; it earns zero new runtime concepts.

---

## 2. Where the designs agreed (adopt without further debate)

1. **Watch registrations are durable statestore rows** (`watch:` prefix + index key), not an in-process Map. Restart amnesia is deleted by construction, not mitigated.
2. **The `POST /workflow` 202 contract is preserved.** `{instanceId, watching: true}` survives; `watching` comes to mean "durably registered" instead of "a process is looping". Callers (sweep step F) don't change.
3. **Budget deadlines are absolute** — computed from a persisted `startedAt`, never tick-counted — so a breach slept through an outage is enforced on the first scan after recovery.
4. **Closed, code-implemented action vocabulary.** No shell, no arbitrary HTTP, no GitHub from a watcher. A new capability is a PR adding a handler, not a config edit.
5. **Terminate is subject-scoped.** A watcher can only terminate the instance it is registered on; the target is derived from the row key, never a config field.
6. **Judgment stays agent-side.** The sweep's marker extraction (`===VERIFY===`/`===PR===`), GitHub labels/comments, and REVISE composition are deliberately *not expressible* in watcher config. The only escape hatch is firing a saved family (a trigger) with the watcher's facts as params.
7. **Every run a watcher causes is itself watched and budgeted** — D2 preserved structurally, one hop at a time.
8. **UNKNOWN is never immediately fatal.** Keep-polling semantics survive (`workflow-babysitter.ts:148-161`); only a sustained UNKNOWN streak finalizes a watch as orphaned.
9. **Trigger- and cron-fired runs gain supervision** — the one real capability gap all three designs close and the babysitter architecturally cannot.
10. **CLI surface**: `h workflow run <key> --watch [--budget 45m]` sets a body field; `h watch list|rm` reads/writes the registry. No new render plumbing.
11. **Both babysitter loops (JS + Python) are eventually deleted** — supervision written once, in one language.

---

## 3. Disagreements and rulings

The red team's findings are folded in; a ruling the red team gutted does not survive unmodified.

| # | Question | A: watcher-svc | B: actor-watchers | C: watcher-as-workflow | Ruling |
|---|---|---|---|---|---|
| W1 | Where does the engine run? | new `apps/watcher-svc` deployable | new actor-hosting deployable (phase-0: inside dapr-mcp) | activities in workflow-svc, driven by a published `watch` family | **Code in workflow-svc — C's location, not C's mechanism.** A buys a new SPOF deployable for <10 concurrent watches; B's phase-0 shortcut couples supervision to dapr-mcp, a dependency the repo has already been burned by (silent tool degradation gotcha). C's *family* variant is gutted by the red team's soft-kill-switch attack: supervision would exist only while the watch family is published + scheduled + enabled — one forgotten bootstrap or a `disabled: true` silently disarms everything, and stamp-forward means no alarm. So the scan is a plain code path inside workflow-svc (which already owns `getStatus`/`terminate`/state), always armed when the service is up, failing loud when it isn't. |
| W2 | The clock | new 10s cron binding | Dapr actor reminders (durable) | 60s family schedule, 6×10s in-activity loop if tighter | **The existing `workflow-cron-tick` (60s), scan in-handler.** B's reminders are the repo's least-exercised path (the only reminder callback today just logs) and the heaviest mechanism for the lightest job — rejected. C's 6×10s in-activity loop recreates the babysitter's `for(;;)` inside the workflow runtime — the red team is right that the design's thesis dies in that mitigation; rejected. 60s granularity on a 45-min budget is a ≤2% overshoot. If a human rules 10s latency matters (open question Q2), add a dedicated cron binding then — a YAML file, not a design change. |
| W3 | Config expressiveness | 5+ condition types, 7 actions, templating | rule/action lists per outcome | rules + `{{row.meta}}` templating | **No rules DSL. A fixed, typed policy struct.** The red team's config-DSL-trap attack lands on all three (Design A's own text backtracks on its code/data boundary mid-sentence): the policy being encoded is two rules, ~25 lines. The schema in §5 has *no* conditions, *no* action lists, *no* templating — `maxDurationMs`, an optional `escalate` hook, and engine-fixed behavior. Growth requires a third concrete policy that cannot be a preset; until then the escape hatch is `escalate` (fire a family), which is exactly "publish an event" without ceremony. |
| W4 | Retry/attempts and cost-tally ownership vs the sweep | watcher owns both (`redispatch`, `tally-cost`) | watcher owns both (actor state attempts, ledger counter) | watcher owns both (retry rule, `tallyCost`) | **The sweep keeps both; the watcher only records and publishes — for now.** The red team's two-counters/two-ledger-writers attack gutted all three: during any migration window the watcher's attempts and `h-auto:issue:<n>.attempts` diverge (double dispatch on one failure), and two writers on `h-auto:ledger:<date>` corrupt the fail-closed BUDGET gate. Ruling: one writer per key, ever. `h-auto:*` stays sweep-only. The watcher writes `watch:*` only. Retry and ledger migration into engine code is a *later, separate* decision gated on spikes 3-4 — and cost-tally arrives read-only (shadow comparison) before it ever writes. |
| W5 | The fresh/purge race (watch keyed on instanceId; `fresh: true` purges and re-runs under the same id) | unhandled (successor watch collides on key) | unhandled (worst: stale durable actor persists) | unhandled | **New requirement none of the designs had: epoch fencing.** The invoker path in workflow-svc stamps a monotonically increasing `epoch` on the watch row on every (re)schedule of an id — including `fresh` (`dapr-workflow-invoker.ts:100-108` is the one choke point where reuse/attach/purge is decided, so the row rewrite is co-located with the decision). Every engine action re-reads the row and no-ops if its in-hand epoch is stale. A `--fresh` re-fire without `--watch` still refreshes the epoch, invalidating the old watch instead of letting it budget-terminate the new incarnation with the old `startedAt`. |
| W6 | Registration path | separate `POST /watch` after submit | separate `POST /watchers` | `watch` field on `/workflow/run*` bodies, row written by workflow-svc | **C.** A's two-call registration has a silent hole the red team confirmed: submit 202s, watch registration fails, `watching: false` is returned — and no existing caller reads that field. With the row written by workflow-svc *in the same handler that schedules* (row-with-status-`scheduling` before invoke, healed by the scan if the invoke never lands — C's own mitigation, kept), registration cannot silently detach from invocation. The agent-service babysitter shrinks to: forward the submit with the `watch` field set from `policy`. |
| W7 | New deployable? | yes | yes (+ actor port, placement, index-anyway) | no | **No.** The red team's fan-out analysis is accepted: realistic load is <10 watches; 100 watches at 10s would be 10 rps of sidecar GETs. Scale justifies none of the machinery. B is strictly dominated and is rejected wholesale (its one unique asset, durable reminders, is unneeded once rows + an existing cron tick give durability). |
| W8 | Terminate idempotence under races | claims "terminate on a terminal instance is a no-op — invoker tolerates it" | idempotence keys in actor state | "terminate on terminal is a no-op" | **A's claim is false and the engine must handle the error path.** Verified: `terminate` deliberately surfaces non-2xx as `WorkflowError` (`dapr-workflow-invoker.ts:73-88` — "a caller terminating a workflow needs to know the request was rejected"), unlike fire-and-forget `purge`. Ruling: the engine's terminate action catches the error, re-fetches status, and treats already-terminal as success; anything else is retried next tick. During migration, watcher-vs-sweep terminate races exist by design (belt and braces) and both sides must tolerate the loser's error. |
| W9 | Self-watching | n/a | n/a | cron-fired runs default `watch: true`; the watch family is cron-fired → subscribes to itself every 60s | **Dissolved by W1, kept as an invariant.** With the engine as code (not a workflow instance), there is no self to watch. The invariant is still stated (§6) because it re-emerges the moment anyone reintroduces a watch *family*: the engine must never supervise its own machinery. |

---

## 4. The recommended shape

```
 any fire path                                           workflow-svc (one choke point)
   agent svc POST /workflow  {…, policy}  ──┐
   POST /workflow/run[/:key] {…, watch}   ──┤  invoker decides reuse/attach/fresh
   workflow-trigger event {key, params}   ──┤  (dapr-workflow-invoker.ts:100-108)
   cron tick fires due saved workflow     ──┘      │
        │                                          ├─ write watch:sub:<instanceId> row
        │                                          │  {policy, startedAt, epoch++, status: scheduling}
        │                                          └─ append watch:index; then schedule
        ▼
 instance runs (genericWorkflow) — emits what it already emits:
   Dapr status · run ledger (files + run:<id> mirrors) · Zipkin trace
        ▼
 workflow-cron-tick (existing 60s binding) → workflow-svc scan (code; CAS overlap guard,
   cron.router.ts pattern; heals `scheduling` rows whose instance stayed UNKNOWN)
   for each active row:  getStatus(instanceId)          ── watch
     interpret against the row's policy + epoch          ── interpret
     act (closed vocabulary):                            ── act
       RUNNING/PENDING past startedAt+maxDurationMs → terminate (error → re-check status)
                                                      → record budget-terminated + publish
       COMPLETED/FAILED/TERMINATED → record outcome + publish workflow-events → finalize
       UNKNOWN streak past threshold → finalize orphaned
       policy.escalate set + matching outcome → publish workflow-trigger {key, params+facts}
                                                (fired run gets its own budgeted watch row)
        ▼
 durable outcomes, one home:
   watch:sub:* rows (query: h watch list, GET /watch/list — survives every restart)
   workflow-events (finally has a guaranteed publisher; subscribers optional)
   sweep step R eventually READS rows instead of re-deriving   (spike 4, not before)
```

Invocation and supervision are decoupled *as concepts* (a row anyone can write, an engine that only reads rows) while staying physically co-located in workflow-svc — which is what kills A's two-call hole and C's bootstrap fragility at the same time.

---

## 5. Watcher config sketch

Not a DSL. A typed row (`Schema` validated at write, the `workflow.model.ts` pattern), with engine behavior fixed in code:

```yaml
# statestore row  watch:sub:<instanceId>   — written only by workflow-svc's fire paths
instanceId: feature-issue-12
epoch: 3                          # W5: bumped on every (re)schedule of this id, incl. fresh;
                                  #     every engine action is fenced on it
startedAt: "2026-07-05T09:00:00Z" # absolute deadline base — restart-safe (agreement 3)
policy:
  maxDurationMs: 2700000          # the ONLY mandatory knob; registration rejects absence
  unknownStreakLimit: 6           # ticks of consecutive UNKNOWN before orphaned (default 6)
  escalate:                       # the ONLY judgment hook (agreement 6); null = none
    onOutcome: [failed, budget-terminated]
    key: escalate-human           # a published family; fired via workflow-trigger with
    params: {}                    # engine facts (instanceId, outcome, attempts) merged in;
                                  # the fired run gets its own budgeted watch row (agreement 7)
# ---- engine-owned; config authors cannot set these ----
status: scheduling | watching | finalized | orphaned
lastStatus: RUNNING
unknownStreak: 0
outcome: null                     # completed|failed|terminated|budget-terminated|orphaned
meta: {owner: issue-sweep}        # opaque passthrough for row consumers (e.g. sweep step R)
updatedAt: "…"
```

What the babysitter's `policy.maxDurationMs` maps to is obvious; what step R's retry ladder and cost tally map to is **deliberately nothing yet** (ruling W4). If retry ever moves into the engine, it arrives as one more typed field (`retry: {maxAttempts, fresh: true}`) with the attempts counter engine-owned and monotonic — never as a condition language.

---

## 6. Safety invariants

- **Closed action vocabulary** (agreement 4): `terminate` (own subject only, error→re-check per W8), `record` (own `watch:` row only), `publish` (allowlisted topics: `workflow-events`, `workflow-trigger`), `escalate` (published families only). No generic HTTP, no shell, no GitHub, no writes outside `watch:*`. Blast radius of a hostile/wrong row: wrongly terminate its own subject (recoverable via `fresh`), spam two allowlisted topics, and fire already-published families at a capped rate.
- **Budgeted agent actions**: `escalate` refuses to fire without an effective `maxDurationMs` on the child, auto-registers the child's watch row (recursion is one-hop-guaranteed), and consults a daily dispatch gate (the sweep's gate-B pattern) fail-closed before firing. Red-team residual acknowledged in §9: lineage beyond one hop is bounded only by the daily gates, not tracked.
- **One writer per key** (ruling W4): engine writes `watch:*`; sweep writes `sweep:*` (formerly `h-auto:*`); neither crosses. Any future ownership transfer is a migration with a before/after spike, never an overlap.
- **Epoch fencing** (ruling W5): every action re-validates `epoch` before executing; `fresh` re-fires invalidate stale watches structurally.
- **Kill switch, loud not silent**: a single `watch:config {enabled}` key checked at the top of the scan — and because the scan is code in workflow-svc (ruling W1), "disarmed" is a logged, `/observe`-visible state (`watch:__tick__` heartbeat key), not C's silent unpublished-family failure mode. Layer 2: workflow-svc down pauses supervision *and* invocation together, which is at least honest.
- **No self-watching** (ruling W9): the engine is not a workflow instance and must never become one; `escalate` refuses any key whose stored definition is watch-engine machinery.
- **UNKNOWN is conservative** (agreement 8): a degraded status API must never trigger terminate; only sustained streaks finalize, as `orphaned`, with an event — never a kill.

---

## 7. What this deletes/simplifies vs what it adds

| Deletes / simplifies | Adds |
|---|---|
| The JS watch loop (`workflow-babysitter.ts:121-193`) and the entire Python `_watch`/`_publish_event` sibling — the worst deliberate two-language duplication in the repo | A scan code path + row store + routes (`GET /watch/list`, `DELETE /watch/:id`) in workflow-svc — new code with real tests, versus prose that was "free" |
| The volatile watch Map and its "restarts forget" residual (h-builds-h agreement #7) — deleted, not mitigated | An `epoch` concept on the invoker path — small but load-bearing, must be right |
| The unsupervised-runs gap: trigger- and cron-fired runs get watch rows through the same choke point (closes the D2 note) | A schema to validate and version (bounded by the no-DSL ruling, but real) |
| Sweep step R's mechanical half — *eventually* (spike 4): terminal classification, budget re-enforcement, UNKNOWN-heal read from rows instead of re-derived; prose shrinks toward pure judgment | A migration window where babysitter, scan, and sweep step R all enforce budgets — three enforcers before there is one (belt, braces, and a second belt) |
| `workflow-events` gains a guaranteed durable publisher; `GET /workflow/watches` becomes global truth via rows | One more indirection when debugging: run → row → scan tick (mitigated: same instanceId join key everywhere) |
| A nameable composition story: workflow · watcher · trigger · registry | workflow-svc concentrates further as the supervision SPOF — it already owns invoke/status/terminate, so this is marginal, but named |
| Enforcement latency 10s → 60s (accepted per W2 unless Q2 rules otherwise) | — |

Not fixed by any of this, per the red team: the orphaned `claude` subprocess after terminate, and the prompt-injection surface of sweep judgment. See §9.

---

## 8. Phased exploration plan (spikes, not build phases)

Each spike answers a question; a "no" at any rung stops the ladder with value already banked.

**Spike 0 — the null hypothesis, first and honestly.** *(RETIRED per Decision 1 — the human ruled the exploration itself answered this; the ladder starts at spike 1, whose row-writing subsumes this spike's persistence.)* Persist the babysitter's `WatchState` rows to the statestore on submit and re-arm loops on boot with absolute deadlines from persisted `startedAt` (~40 lines, JS side first). No engine, no new anything.
*Acceptance question:* with restart amnesia gone, does any observed pain remain that only the decoupled engine fixes (unsupervised trigger/cron runs? the JS/Py duplication? sweep-prose fragility?) — or should the exploration stop here and this doc be re-statused "closed: null hypothesis sufficed"?

**Spike 1 — row-at-schedule + shadow scan.** workflow-svc writes `watch:sub:*` rows on every fire path (with epochs) and the cron-tick scan runs in **shadow mode**: it records outcomes and publishes events but never terminates. Babysitter still live.
*Acceptance question:* over a week of real runs (including sweep dispatches and at least one `--fresh` re-fire), do the scan's recorded outcomes match the babysitter's and step R's classifications exactly — including the epoch-fenced fresh case and a deliberate mid-run workflow-svc restart?

**Spike 2 — terminate handoff.** Enable budget enforcement in the scan; disable the babysitter's terminate (keep its publish) on one agent service. Deliberately provoke the W8 race (sweep terminate vs scan terminate on the same over-budget run).
*Acceptance question:* does the loser of every terminate race recover cleanly (error → re-check → treat-as-done), and does a run that slept through its budget during an outage get terminated on the first tick after recovery?

**Spike 3 — deterministic cost tally, read-only.** Implement the sweep's cost prose (`issue-sweep.yaml:84-89` — runId prefix-match over run mirrors, LEDGER GAP on zero matches) as a scan-side computation that writes only to the watch row, never the ledger.
*Acceptance question:* over N terminal runs, does the code tally match the sweep's prose tally to the cent (and flag the same gaps)? This also pressure-tests issue #10 (obs `runs_list` has no instanceId filter) as a code path instead of prose.

**Spike 4 — sweep reads rows.** Re-cut step R's prose to read `watch:sub:*` outcomes (+ `meta.owner`) instead of calling `get_workflow_status`/re-deriving budget/heal — sweep still owns all `h-auto:*` writes, retries, and GitHub actions. **Staleness guard (Decision 3):** the sweep checks the `watch:__tick__` heartbeat first; a stale scan means the rows are not truth — fall back to direct `get_workflow_status` polling for that tick and report the engine-stale condition loudly in the sweep report, never trust silently stale rows. (Today's sweep is self-sufficient poll-based truth, agreement #7 of h-builds-h; this spike trades that for reading the engine's interpretation, so the trade must be visible when it goes bad.)
*Acceptance question:* does the sweep report stay byte-consistent with registry reality for two weeks of ticks, with a measurably smaller prompt and tool surface — including at least one tick where the engine is deliberately stopped and the fallback+loud-report path fires? Only a "yes" here opens the *separate* human decision on migrating retry/ledger ownership (W4, Q3/Decision 3).

**Spike 5 (only if 1-4 all pass) — delete.** Remove both babysitter watch loops; `POST /workflow` becomes forward-with-watch-field.
*Acceptance question:* does anything anywhere still read the babysitter's in-process state, and do Python agent services function with supervision fully delegated (Q4)?

---

## 9. Open questions only a human can decide

1. **The spike-0 exit.** What observed pain, concretely, justifies going past the null hypothesis? Name it now (e.g. "a trigger-fired run exceeded budget unsupervised" or "the Py/JS loops diverged again") so continuing is a tripwire, not a preference — the h-builds-h D1 discipline.
2. **Latency requirement.** Is 60s enforcement granularity acceptable for every run class, or does something need the babysitter's 10s? (Drives whether W2 ever grows a dedicated cron binding.)
3. **Long-term retry/ledger ownership.** After spike 4: does retry semantics live in the engine (typed, tested, shared by every loop) or stay per-domain in each loop's prose (sweep keeps its ladder)? One answer, one writer — the migration is a human call because it moves the BUDGET gate's data source.
4. **Python coupling.** Deleting the Python babysitter makes every Python agent service depend on workflow-svc for supervision. Acceptable, given workflow-svc already owns invoke/status/terminate?
5. **Is `escalate` in v1 at all?** The closed vocabulary is safest with zero agent-invoking actions; publish-to-`workflow-events` could be the only outbound path until a concrete escalation need exists. Fewer capabilities, smaller blast radius.
6. **Bless the vocabulary?** Adopt "workflow / watcher / trigger / registry" in CLAUDE.md and docs even if only spike 0 ships — naming is cheap and the red team conceded it's the one uncontested win — or hold off until an engine exists so the name isn't ahead of the capability?

---

## 10. Red-team residuals (accepted or unresolved)

- **The orphaned `claude` subprocess** — budget-terminating the Dapr instance still leaves the agent's CLI process running (h-builds-h.md:182 accepted residual; phase-4 backlog item 7). No design here fixes it; the engine's reliable `workflow-events` publishing merely gives the future runner-side terminate listener something dependable to subscribe to. *Accepted, unchanged scope.*
- **Prompt injection in sweep judgment** — steps V/D/S keep an agent holding state+GitHub+dispatch tools against third-party text. This exploration shrinks that agent's mechanical duties, not its trust problem. *Accepted; label gate + coder split remain the boundary.*
- **The DSL temptation** — ruling W3 is a policy, not a mechanism. The first "just one condition field" PR is where this dies or holds. *Unresolved by construction; guarded only by review culture and this doc.*
- **Lineage beyond one hop** — escalate → family → agent → dispatch chains are budgeted per hop and bounded by daily gates, but no lineage is tracked; a pathological chain burns the day's budget before stopping. *Accepted at current scale; revisit if escalation families multiply.*
- **The migration window's triple enforcement** (babysitter + scan + sweep step R all terminating) — deliberately tolerated per W8, but it triples the terminate-race surface until spike 5. *Accepted, time-boxed by the spike ladder.*
- **workflow-svc as supervision SPOF** — supervision and invocation now fail together. Honest, but a workflow-svc outage during a long agent run means no budget enforcement until restart (then immediate catch-up via absolute deadlines). *Accepted; the heartbeat key makes staleness observable.*

---

## Decisions (2026-07-05)

Human answers to the §9 open questions; the direction is approved on these terms.

1. **Null hypothesis retired; spike 0 skipped.** The exploration itself — not a spike — answered
   the exit question: the goal was to assess the merit of the idea, not to make the minimal patch
   fit, and the consolidation/unification the engine-in-workflow-svc shape delivers (one
   supervision home, unsupervised trigger/cron runs closed, JS/Py duplication deleted) is the
   point. The ladder starts at spike 1, whose row-at-schedule work subsumes spike 0's ~40-line
   persistence anyway.
2. **60s enforcement granularity accepted for every run class.** No dedicated 10s binding; the
   cadence is already configurable where it should be — the cron component's schedule — so a
   future latency need is a YAML edit, not a design change (per ruling W2).
3. **Retry/ledger ownership — REVISED same day: generic watcher policy, engine-owned, now.**
   The original ruling (defer per W4, sweep keeps both) is superseded. Retry (`retry:
   {maxAttempts, fresh}`) and cost accounting become typed watcher policy so no workflow — or
   judgment loop — has to re-derive them. Single-writer is preserved *structurally* rather than
   by deferral: all `watch:*` writes, including `watch:ledger:<date>`, happen inside
   workflow-svc's fire paths and scan — even sweep-fired runs are counted by workflow-svc (the
   row write lives in the same handler that schedules), so the sweep never touches the ledger
   or attempts again. Gate B reads `watch:ledger:<date>`; the sweep's prose drops its retry
   ladder and cost tally in the same change the engine gains them. Clarified during the
   decision: the dependency direction is not workflow→watcher — a *watched* workflow never
   knows its watcher exists; only judgment consumers (the sweep) read watch rows, with a
   mandatory staleness guard (heartbeat check + loud fallback to direct polling).
4. **Python agents supervise through workflow-svc.** Not judged an issue: workflow-svc is exactly
   this kind of augmentation — managed workflows, durability, and now a standard for watching.
   An agent needing supervision uses workflow-svc like every other; the Python babysitter is
   deleted at spike 5. If real pain surfaces later, run another data-backed spike then — start
   aligned.
5. **`escalate` ships in v1.** The short-circuit actions (time/budget exceeded → terminate) remain
   the heart of the watcher policy and the most important capabilities; `escalate` joins them
   under the §6 invariants (budgeted child, auto-registered watch row, fail-closed daily gate,
   published families only).
6. **Vocabulary locked in.** workflow / watcher / trigger / registry is adopted repo-wide now —
   CLAUDE.md carries the primitives frame — accepting that the name briefly runs ahead of the
   engine. Iterate later; start somewhere.
7. **No migration window — atomic cutover.** The spike ladder (§8) is retired as a build plan
   (retained above for the record). One change set delivers: the watch store + scan engine in
   workflow-svc (rows, epochs, budget-terminate, retry, cost tally, escalate, heartbeat),
   fire-path row writes on every entry point, both babysitter watch loops (JS + Python) deleted
   and replaced by forward-with-watch-field, the sweep prose re-cut to read rows (staleness
   guard included), gate B re-pointed at `watch:ledger:<date>`, goldens re-blessed, and the
   `--watch`/`h watch` CLI surface. The triple-enforcement window and its terminate races never
   exist. **Named accepted risk:** no shadow-validation period — cost-tally parity between the
   old prose and the new code is proven by unit tests plus preserved LEDGER GAP semantics
   (zero-match → loud flag, never a silent $0), not by weeks of live comparison.

## Progress log

- 2026-07-05 — **atomic cutover SHIPPED** (Decision 7 executed same day). workflow-svc: watch
  model/port/pure engine (`domain/watch-engine.ts`, unit-tested policy surface) +
  scan/registration (`domain/watch-scan.ts` — tests cover epoch-fencing, the W8
  terminate-race, LEDGER GAP, fail-closed escalate, fleet isolation) + `dapr-watch-store.ts`
  + `watch.router.ts` (GET /watch/list with heartbeat, GET/DELETE /watch/:id); every fire
  path (run, run/:key, trigger, cron) registers through the `invokeWithWatch` choke point;
  the scan rides the workflow-cron-tick and its failure never fails the tick. Both babysitter
  watch loops DELETED — JS (`workflow-babysitter.ts`) and Python (`workflow_route.py`) are
  submit-and-forward (policy→watch translation, explicit watch wins); `GET /workflow/watches`
  proxies the durable registry. workflow-mcp run tools take a `watch` policy. issue-sweep
  chart re-cut: step R reads rows behind the `watch:__tick__` staleness guard (ENGINE STALE
  fallback), gate B reads `watch:ledger:<date>`, M stops writing attempts/ledger, F carries
  `watch`+`watchMeta` (no `policy`), the retry ladder is deleted (engine-owned); goldens
  re-blessed, family gate intact. CLI: `h workflow run --watch/--budget/--retry`, new
  `h watch list|get|rm` (heartbeat staleness warning). CLAUDE.md primitives section updated
  to IMPLEMENTED; WORKFLOWS.md + h-builds-h runbook re-cut. All suites green: workflow-svc
  94, agent-server(js) 21, workflow-mcp 20, agent-server(py) 10, h-cli 59. Not yet exercised
  live: an end-to-end sweep tick against the running stack.

- 2026-07-05 — **registry prefix canonicalized: `h-auto:*` → `sweep:*`** (human ruling on the
  vocabulary follow-up). The convention is now stated in §1: a registry prefix names the single
  component that owns writing it — `watch:` (engine) and `sweep:` (issue-sweep) are the models.
  Chart prose, runbook, WORKFLOWS.md, CLAUDE.md renamed; live Redis keys copied
  `h-auto:*` → `sweep:*`; historical rulings text (W4, spike 4) left as the record of what was
  argued under the old name. `__workflow_index__` remains the known stray (code + stored
  state, not just prose) — a candidate for a later cleanup issue.
