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

_Last updated 2026-07-28, ~22:30, start of an unattended overnight batch. Read this first._

**OVERNIGHT BATCH IN PROGRESS (2026-07-28 → 29).** Operator asleep; authority granted:
merge PRs that are review-clean AND pass a driver verify-at-head. Order: harness fixes →
hardening-audit items → doc/steering drift. Executors: claude + openhands (DeepSeek);
**codex EXCLUDED — OpenAI quota exhausted**; pi is implement-only (no MCP, cannot own a
PR-flow stage).

**CORRECTION — the usage-limit fallback is NOT armed, and cannot be.** The driver intended
to arm it and said so; verifying afterwards showed `h chain run` has **no `--fallback-*`
flags at all** — they exist only on `h workflow run`. This is exactly Phase 2 item 2 of this
plan ("chains carry fallback by default … today it's `h workflow run`-only"), still unbuilt,
now with a concrete cost: an entire unattended batch ran with no fallback because the surface
does not exist on the shape the batch uses. **Every real batch runs as chains, so a
workflow-run-only fallback is effectively no fallback.** Promote Phase 2 item 2.

*Actual mitigation in force tonight (posture, not machinery):* openhands/DeepSeek does all
writing (implement + revise); claude appears ONLY as a review panelist. So a Claude usage
limit does not stop work — it kills the claude branch of a review panel, and because a panel
is a `whenAll` parallel group, one dead panelist fails the whole review member (DRIVER.md's
recovery section). The recovery is to re-fire that review with an openhands-only roster.

- **⚠ THE TEST SUITE FIRES REAL CHAINS AGAINST A LIVE STACK (2026-07-28).** Durable rows
  appeared in two production registries overnight (`chain:sub:x`, saved workflow `x-w0` —
  the registry's only entry), the chain epoch climbed to **4**, and a live `review-pr` panel
  ran **including codex**, the executor excluded for the night on exhausted quota; that run
  completed with 3 tool calls, so it spent quota.
  **Root cause (corrected — the first attribution to an agent running commands was WRONG):**
  `test_chain_roster_accepts_model`, new in PR #99, invokes
  `chain run --slug x -w review-pr --agent claude codex --model opus` with **no
  `@respx.mock`**, so it makes a real HTTP call to whatever workflow-svc is reachable. That
  explains every observation exactly — the chain id is the test's `--slug`, `x-w0` is its
  compose-on-fire publish, the epoch increments once per suite run, and codex is literally in
  the test's roster. **The driver's own verify-at-head runs were among the triggers.**
  So the exposure is not agency but a property of the suite: **running the CLI tests on any
  machine with a live stack fires real chains, publishes real workflows, and invokes real
  agents on real providers, silently.** Harmless only by luck here (dispatch failed). The
  immediate fix (the missing mock) was caught independently by #99's review panel; the class
  needs a guard, and an engine-enforced executor allowlist so an exclusion cannot be bypassed
  by ANY path. See task #8 and reviewer-identity-security (moved Deferred → Active).
- **In flight:** `kimi-int3` (openhands implementing the Moonshot Kimi integration from a
  panel-vetted spec) → `kimi-int3-review` gated behind it (claude+openhands review panel →
  openhands revise, loop-until-clean ×3).
- **Four harness defects found tonight, all real, none yet fixed** — see the task list and
  the notes below. Two of them BREAK CHAINS and have live workarounds:
  1. *Empty-string model params.* `--agent X` without `--model` emits `modelImplement: ""`;
     `openhands.ts:184` sets `LLM_MODEL` only `if (request.model)` → the CLI dies. Claude is
     masked by `DEFAULT_CLAUDE_MODEL`. **Workaround: always pass `--model` explicitly on a
     single-agent member.**
  2. *Unsatisfiable member inputs fail late.* `-w plan --kind answer` drops `slug` →
     `fatal: 'feature/' is not a valid branch name` inside an activity. Registration checks
     declared `--capture` against the outputs schema but never checks inputs.
     **Workaround: declare `--input slug=slug` explicitly.**
  3. *Panelize silently downgrades the model* — `panelize.py:157` strips `model`, so branches
     fall back to `AGENT_MODEL`; `--model` with a roster is rejected, so there is no override.
     **Workaround applied: `.env` `AGENT_MODEL` raised haiku → `claude-sonnet-4-6`** (backup
     at `/tmp/env.bak.*`; this is a global change worth reverting or making deliberate).
  4. *No first-class `plan` member kind* — carried-followups §2, now with a concrete failure.
- **Environment left changed:** `.env` `AGENT_MODEL=claude-sonnet-4-6` (was haiku);
  claude-agent restarted to pick it up. Host-mode stack UP via `make infra-up` +
  `MODE=dev up-local` (8 services).
- **Litter to clean:** six finalized dead chain rows (`kimi-agent`, `kimi-agent-review`,
  `kimi-integration`, `kimi-integration-review`, `kimi-int2`, `kimi-int2-review`) and a stale
  `feature/kimi-integration` worktree. `h chain rm` is PR #97, still open — the reason this
  cannot be cleaned properly yet.
- **Open PR not from this batch:** #97 (`h chain rm` / `POST /chain/disarm`).

### Prior state (2026-07-27 session handoff), still true unless superseded above

- **In flight: nothing.** Board clear apart from the parked zombie below.
- **Merge queue: empty.** All of batch 2 is merged: trxy #55 (team S.K.A.T.E. design, fully
  decided), #56 (spot-image terrain suggestions), #57 (spot ownership), plus h #93/#94.
  trxy #54 was CLOSED unmerged (stale-premise churn — see the standing rule in DRIVER.md).
- **Provider status: OpenAI/codex quota EXHAUSTED (2026-07-27).** Do not roster codex in
  implement legs OR panels until it clears. Live: claude (Anthropic), openhands (DeepSeek).
  **CORRECTED 2026-07-28 — the "openhands is implement-only" rule is WITHDRAWN.** It rested
  on h #96's `toolCalls: 0`, which was a measurement artifact: the ledger tallied only the
  claude CLI's event shape, so every non-claude agent scored a confident `0` regardless of
  work done. Fixed in `868d080` (per-strategy tally; `toolCalls` is now `number | null`,
  null = not measurable). Counter-evidence the same day: a panelized `plan` member
  (claude + openhands) shows openhands at **14** real tool calls — `ActionEvent`,
  `FileEditorAction`, `TerminalAction` — producing a 27KB plan citing real paths and line
  numbers. So openhands IS a viable panelist for plan/answer work. The **bare-verdict**
  observation on PR review specifically is a separate claim and remains unverified — roster
  openhands on reviews, but judge its branch by whether it produced a substantive summary,
  not by a tool count.
- **Open h issues, none blocking:** #84 done, #95 (no `h chain rm` — the reason for the
  zombie), #96 (hollow panelist). Open trxy issue: #58 (leaderboard rank gaps, found by
  hands-on exploration; root-caused with a before/after — read-side fix suggested).
- **Zombie to clean:** chain `spot-ownership-review2` is a PARKED DUPLICATE gated to
  2026-08-26. Kill it before then, or when #95 lands.
- **Still needs the operator:** trxy CI/CD is down on the GitHub Actions quota, so every
  migration merged since 2026-07-26 (ig-promo, ai-challenge, spot-ownership) is UNAPPLIED in
  prod. Nothing automated will apply them.
- **Environment left running:** local Supabase up; Android emulator `trxy-emulator`
  (adb `localhost:5555`) with a local-stack APK installed and a logged-in seeded user
  (`explore1785162251@trxy.test` / `Explore123!`). Tear down with
  `apps/mobile/scripts/android-emulator.sh stop` if not needed.
- **Next candidates:** team S.K.A.T.E. PR 1 (database foundation) is unblocked and specced —
  its spec is the merged plan doc, so it is the natural first user of the in-repo spec
  pointer (docs/plans/spec-review-pipeline.md); and that pipeline's own build (a
  `review-spec` template) is unstarted.

## Log

- 2026-07-27 (overnight) — Phase 4 live-fire ran but did NOT exercise the fallback: the
  limit-immune posture (codex executors, claude only in panels) meant no usage-limited
  outcome occurred across 8 chains / 4 merged trxy PRs. So Phase 2/3 remain
  UNVALIDATED-IN-ANGER; the posture itself is the working mitigation today. What the night
  DID prove: the durable-state continuity story (three separate runs died at a gate —
  TS2503 floor, Supabase 502 — and each resumed from its preserved worktree via a recovery
  addendum with zero lost work, exactly the mechanism a model fallback would use). Design
  note for Phase 3: the park/fallback trigger should cover ANY gate-stop with preserved
  work, not just usage-limited — the recovery addendum pattern is the template.
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
