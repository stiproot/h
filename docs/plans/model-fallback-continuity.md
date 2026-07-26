# Model fallback & session continuity — surviving the subscription limit

Status: Planning — scoped 2026-07-26; DeepSeek + driver session first, then h executors
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
| Driver intent ("what's next, what to check") | **nowhere durable** — lives in the driver's conversation + harness task list | **NO — the gap** |

Conclusion the plan builds on: h-side state is already resumable by construction; the
driver's supervisory state is the only non-transferable piece. Fix that with a durable
driver runbook + state doc, not with session-transfer magic.

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
4. **Authority policy.** Decide what a fallback driver may do: recommended — full
   read/verify/park authority; merges allowed only when the loop finalized CLEAN and the
   verify sweep is green (mechanical close-out); judgment calls (spec contradictions,
   scope changes) are parked for Claude/human. Encode in DRIVER.md.
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
3. **Panel/judge policy under fallback.** review-pr panels pin the judge to claude; decide
   the degraded-mode roster (codex+deepseek panel, deepseek judge?) vs parking reviews
   until Claude resumes (cheaper and safer — reviews are rarely urgent). Recommended:
   executors fall back, review loops park.

### Phase 3 — chain-level park-and-resume

Today a usage-limited member FAILS its chain as a unit (D6) — observed live. Wanted: the
chain PARKS instead.

1. On a member outcome `usage-limited` (read off the `run:` mirror / wf row), the chain
   engine sets `notBefore` to the reset time parsed from the limit message (fallback:
   +5h), keeps the cursor, and re-fires the member `fresh` when the gate reopens —
   reusing pause/resume's stop-and-continue semantics at the chain tier. No new
   primitive: it is the existing activation-gate machinery pointed at a new trigger.
2. Interaction with Phase 2: if a fallback agent is declared, fall back; else park. Both
   paths must leave the plan doc's status line honest (the run that died mid-plan-update
   is the risk case — the review evidence rule already catches stale plan claims, which
   is the backstop).
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

## Log

- 2026-07-26 — Scoped. Origin evidence: fix-82 revise usage-limit death (operator finished
  by hand); the day's hand-holding audit (see the verify-eval arc) counts 2 machinery bugs
  (both fixed same-day: #82/#87, cookbook), 1 operator error (--fresh), ~4 judgment calls
  (spec contradiction, evidence completion, merges), and a clear late-arc trend toward
  zero-touch loops (val-42/46 needed only verify+merge). Sibling machinery already live:
  schedule-and-fallback (usage-limit fallback, pause/resume), codex-chatgpt-auth.
