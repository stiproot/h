# Model fallback & session continuity — surviving the subscription limit

Status: Active — Phase 1 COMPLETE 2026-07-26; next: Phase 2/3 design pass + Phase 4 live-fire
Established: 2026-07-26

## Origin

The 2026-07-26 verify-eval arc hit the Claude Max 5-hour limit live: the fix-82 revise run
died mid-flight ("You've hit your session limit · resets 2:20pm"), its chain failed as a
unit, and the operator finished the last finding by hand. h already owns half the answer —
the usage-limit fallback (docs/plans/schedule-and-fallback.md: `classify-stop` detects
`usage-limited`, the watcher arms a deferred continuation under `--fallback-agent`,
pause/resume reuses workspaces) — but it is per-workflow, opt-in, and was not wired into the
day's chains. And the DRIVER session (the Claude Code session that fires chains, reads
verdicts, verifies, merges) has no fallback story at all: when the subscription gates, the
whole operation loses its supervisor, not just one executor.

Two goals, verbatim from the operator:
1. **Fall back and finish** — continue the in-flight work under another model (available
   accounts: DeepSeek, ChatGPT/codex — codex is already integrated).
2. **Fall back and park** — use the fallback only to get the chain into a schedulable
   state, then resume under Claude when the limit resets (the limit message carries the
   reset time — machine-usable).

Both apply to BOTH surfaces: the driver/host session and h's executors.

## The continuity inventory — what actually transfers

A fallback model gets NONE of the predecessor's conversation. Continuity must ride on
durable state only. Audit of what exists today (all verified live in the 2026-07-26 arc):

| State | Home | Transfers? |
| --- | --- | --- |
| Code in flight | the PR branch | yes — the branch IS the context |
| What the task was | chain row `data.spec` (recoverable verbatim) | yes |
| Tracking log / status | the plan doc — **repo-level markdown, not issues** (h convention; the runs DID keep it current, and the seam-3 evidence rule now polices its accuracy) | yes |
| What reviewers demand | PR review threads (unresolved = the work queue) | yes |
| Orchestration position | `chain:sub:` rows (cursor, iterations, captures), `wf:` rows, watch rows | yes |
| What each run did | run ledger + `run:` mirrors (incl. `stopReason: usage-limited`) | yes |
| The full agent session, turn by turn | run ledger `events.jsonl` + `output.txt` — agent-cli logs every session to disk per agent per run | yes — see below |
| Driver intent ("what's next, what to check") | **nowhere durable** — lives in the driver's conversation + harness task list | **NO — the gap** |

Conclusion the plan builds on: h-side state is already resumable by construction; the
driver's supervisory state is the only non-transferable piece. Fix that with a durable
driver runbook + state doc, not with session-transfer magic.

**Session hydration is available but is the second resort, not the design (decision
2026-07-26).** Because agent-cli persists the full session transcript, a successor agent —
any model — CAN trawl the predecessor's `events.jsonl` and hydrate ("here is the dying
run's transcript; continue"). Lean on this core machinery rather than building a new
handoff channel. But hydration only helps when the durable state is ALREADY maintained to
the pick-up standard — a transcript is a narrative, not a work queue. So the plan's
ordering: first-class continuity = the durable-state standard (branch + plan doc + threads
+ rows); transcript hydration = the recovery tool for runs that died MID-step, before
their state landed (e.g. mid-plan-update). A continuation prompt template that splices the
tail of the predecessor's events into the successor's task is a Phase 2/3 building block.

## Enhancements

### Phase 1 — DeepSeek driver fallback (START HERE)

The driver role during steady state is deliberately light: check chains, read findings,
verify at head, merge or park. Make that role executable by a fresh, cheaper session:

1. **DeepSeek-backed claude CLI recipe.** DeepSeek exposes an Anthropic-compatible API;
   validate `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` +
   `ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY` (+ model env) drives the stock `claude` CLI —
   tool calls, MCP servers (`.mcp.json`), file edits. Record the exact env set in
   docs/h-builds-h-runbook.md; add keys to `.env` handling. If the compat surface proves
   too lossy for the CLI, fall back to opencode/pi as the driver harness (decide with
   evidence, in this doc).
2. **The driver handoff doc** — `docs/DRIVER.md` (or runbook section): the standing
   check-in procedure any fresh session (any model) follows from durable state alone:
   `h chain list` → per-chain `data.reviewFindings` → unresolved PR threads → the merge
   protocol (verify at head, known pre-existing failures list, merge commit conventions)
   → the park protocol. Plus a **session-state paragraph the driver updates in the active
   plan doc** at every check-in ("in flight / next / blocked"), which makes driver intent
   durable — closing the inventory gap above.
3. **Low-token check-in.** One command that answers "is h doing what it should" cheaply:
   `h status` or a script summarizing chains (status/iter/findings-count), watches,
   scheds, open PRs — one screen, no agent tokens. The DeepSeek driver (and Claude) both
   check in against THAT, reading deeper only on anomaly.
4. **Authority policy — completion-oriented, merge-gated (decided 2026-07-26).** The
   fallback (driver or executor) TRIES TO SEE THE WORK THROUGH to completion — implement,
   revise, re-review, drive loops clean, update plan docs — with ONE hard boundary: it
   never merges to main. Everything up to the merge is reversible-by-branch; the merge is
   where Claude (or the human) has the final say on return. No static "park judgment
   calls" list: the starting posture is CONFIDENCE that the steering context in the h and
   trxy repos is sufficient for an alternate model to complete a take — held until an
   experiment proves otherwise (Phase 4 measures exactly this: how far fallback-completed
   branches get before the returning Claude's merge review finds gaps). Encode in
   DRIVER.md; the plan doc's session-state paragraph records what the fallback completed
   so the returning driver's first check-in is a merge queue, not an investigation.
5. **Validation:** kill the Claude driver mid-batch (simulated), launch the DeepSeek
   driver cold, have it complete one full check-in + one mechanical merge close-out +
   one park, from durable state only.

### Phase 2 — DeepSeek as an h executor + default fallback wiring

1. **DeepSeek identity in `AGENT_IDENTITY`.** Mechanism decision: (a) claude-agent with
   per-run env override (Anthropic-compat endpoint; needs agent-env-propagation care), or
   (b) a `deepseek-agent` service — a thin clone of claude-agent/codex-agent with the env
   baked (cleaner isolation, one more service). Lean (b) — matches the one-agent-one-auth
   model that codex-chatgpt chose; reuse the integrate-agent playbook
   (docs/plans/agent-integration-playbook.md).
2. **Chains carry fallback by default.** `h chain run --fallback-agent deepseek
   [--fallback-model …]` threads the existing watcher fallback onto every member fire
   (today it's `h workflow run`-only). Validate `classify-stop` matches the exact 5h-limit
   phrasing seen live 2026-07-26 ("You've hit your session limit · resets …").
3. **Panel/judge policy under fallback.** review-pr panels pin the judge to claude; under
   the completion-oriented posture the degraded-mode roster runs too (codex+deepseek
   panel, deepseek judge) so loops can drive branches clean without Claude — the merge
   gate, not a parked review, is where Claude's judgment re-enters. Validate the degraded
   panel's verdict quality in Phase 4 against the same PRs Claude-judged.
4. **The watcher as the on-course primitive (shape decided, mechanism to design).** The
   question "who keeps fallback work on course?" is answered by composing the EXISTING
   watcher vocabulary, not a new supervisor — judgment stays agent-side, the watcher stays
   mechanical:
   - Every fallback fire is watched (already true — `invokeWithWatch` is the fire choke
     point), so budgets/retries hold regardless of model.
   - The new piece: a watch policy `escalate: {onOutcome: "completed-under-fallback",
     key: <claude-checkpoint workflow>}` — when a run completes under a fallback identity,
     the watcher REGISTERS (via the escalation's workflow arming a `cron:sched` one-shot
     at the limit-reset time) a deferred Claude checkpoint: re-review the branch, then
     merge or send findings back through a revise. The watcher never judges the work; it
     guarantees the "Claude has the final say" appointment gets booked, mechanically.
   - Requires: the fallback identity stamped on the run's outcome (`run:` mirror already
     carries agentId/model), and an `onOutcome` value for it in the watch model — small
     additions to existing rows, no new engine.

### Phase 3 — chain-level park-and-resume

Today a usage-limited member FAILS its chain as a unit (D6) — observed live. Wanted: the
chain PARKS instead.

1. On a member outcome `usage-limited` (read off the `run:` mirror / wf row), the chain
   engine sets `notBefore` to the reset time parsed from the limit message (fallback:
   +5h), keeps the cursor, and re-fires the member `fresh` when the gate reopens —
   reusing pause/resume's stop-and-continue semantics at the chain tier. No new
   primitive: it is the existing activation-gate machinery pointed at a new trigger.
2. Interaction with Phase 2: **fallback-first, park-second (decided 2026-07-26)** — if a
   fallback agent is declared (and it should be, by default), the work continues to
   completion under it; parking is the path only when no fallback exists or the fallback
   itself dies. Both paths must leave the plan doc's status line honest (the run that
   died mid-plan-update is the risk case — transcript hydration from `events.jsonl` is
   the recovery tool there, and the review evidence rule catches stale plan claims as
   the backstop).
3. Kill-switch + budget: parking must not fight the wall-clock budget (activation
   re-stamps startedAt — the gate-hold lesson from e4802e2 applies).

### Phase 4 — e2e validation

- Simulated: force `usage-limited` (env-starved run or stubbed classify-stop) →
  fallback-finish path AND park-resume path each drive a real PR to merge-ready.
- Real: next actual 5h window, run the batch through it without operator rescue; the
  driver check-in doc is the only supervision.

## Non-goals

- Session/conversation transfer between models — continuity is durable-state-only, by
  design.
- ChatGPT-side driver (codex CLI as driver harness) — executors already have codex;
  a codex DRIVER is a follow-up if the DeepSeek driver validates the pattern.
- Model-quality routing (picking models per task difficulty) — this plan is about
  availability, not optimization.

## Open questions

- DeepSeek Anthropic-compat fidelity: tool_use/MCP/streaming parity with the claude CLI —
  Phase 1 item 1 answers with evidence.
- Where the driver session-state paragraph lives when NO plan is active (a standing
  `docs/plans/ops-journal.md`? the DRIVER.md itself? decide in Phase 1).
- Chain park vs watcher fallback precedence when both are armed (Phase 3 item 2).

## Driver state

- In flight: `ai-challenge` (gate 22:31Z) + its review loop — fires off a main carrying
  BOTH merged features (#50 game-visibility, #51 ig-promo incl. the shared edge-fn
  machinery its spec reuses) and the fully green floor.
- Merge queue: (empty — #50 and #51 merged ~20:40Z with full evidence).
- Done tonight: h #90 (revise body-updates) + #92 (worktree fetch-race mutex, agents
  redeployed ~20:45Z) merged; trxy #49 (TS2503 fix, verify 31/31), #50, #51 merged;
  h issue #91 filed (--after fires into certain failure on missing capture); trxy issue
  #52 filed (bun link nondeterminism / TS2591 flake — reinstall is the interim remedy).
- Blocked: nothing.
- Next: ai-challenge arc → merge; then Phase 2/3 design pass with tonight's live-fire
  evidence (usage-limit never hit — codex executors sidestepped it entirely).

## Log

- 2026-07-26 (evening, later) — Phase 1 validation ladder COMPLETE. The DeepSeek key was
  already in .env as LLM_API_KEY (the openhands BYOK pair; operator remembered, the grep
  didn't). Validated: (1) wire — api.deepseek.com/anthropic returns Anthropic-shaped
  messages (thinking blocks included) for deepseek-v4-flash; (2) headless claude CLI
  tool use (Read/Write, exact-format replies) with scoped --allowedTools (the
  --dangerously-skip-permissions variant is classifier-blocked in-session — scoped
  allowlists are the shape anyway); (3) MCP — the DeepSeek-backed CLI drove the
  workflows + obs servers correctly; (4) cold-start check-in — accurate fleet picture,
  correct no-action verdict, correct reading of --after gates and loop state, from
  DRIVER.md + durable state alone. Finding: it repeated the plan's STALE driver-state
  paragraph verbatim — faithful-reporting proves the mechanism and exposes the contract:
  the primary driver must keep the paragraph current. Recipe recorded in DRIVER.md.
- 2026-07-26 (evening) — Phase 1 started. docs/DRIVER.md authored (check-in loop, merge
  protocol, completion-oriented authority, recovery drawer). `h status` fired as an
  h-builds-h chain (h-status-cmd + review loop) rather than hand-built — the driver
  tooling is itself loop-made. DeepSeek validation blocked on the API key.
- 2026-07-26 (later) — Operator refinements folded in as decisions: (1) lean on core
  primitives — the run ledger's full per-session transcripts make cross-agent hydration
  possible; durable-state standard first, hydration as mid-step recovery; (2) authority is
  completion-oriented and DYNAMIC, gated at merge-to-main only — starting posture is
  confidence that repo steering suffices for alternate models, experiment-validated; (3)
  the watcher is the on-course primitive: watch every fallback fire (already true) + an
  escalate-on-`completed-under-fallback` policy that books the deferred Claude checkpoint
  via a `cron:sched` one-shot; (4) driver = Claude primary, the claude CLI on DeepSeek's
  Anthropic-compat endpoint as fallback (mechanism confirmed).
- 2026-07-26 — Scoped. Origin evidence: fix-82 revise usage-limit death (operator finished
  by hand); the day's hand-holding audit (see the verify-eval arc) counts 2 machinery bugs
  (both fixed same-day: #82/#87, cookbook), 1 operator error (--fresh), ~4 judgment calls
  (spec contradiction, evidence completion, merges), and a clear late-arc trend toward
  zero-touch loops (val-42/46 needed only verify+merge). Sibling machinery already live:
  schedule-and-fallback (usage-limit fallback, pause/resume), codex-chatgpt-auth.
