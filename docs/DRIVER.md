# DRIVER — the h supervisor session's standing procedure

The DRIVER is the interactive session that fires chains, reads verdicts, verifies at head,
and merges. This doc is its durable procedure: any FRESH session — Claude, or a fallback
model — must be able to pick up the driver role from this file plus the runtime's durable
state, with zero conversation history — so anything a successor needs must live in this file,
in the registries, or in the run ledger, never only in a conversation.

## Identity and fallback

- **Primary:** Claude Code on the Anthropic subscription.
- **Fallback:** the SAME Claude Code CLI pointed at DeepSeek's Anthropic-compatible
  endpoint — the harness, MCP wiring, and steering files carry over unchanged:

  ```sh
  # the DeepSeek key already lives in .env as LLM_API_KEY (the openhands/pi BYOK pair)
  export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
  export ANTHROPIC_AUTH_TOKEN="$LLM_API_KEY"
  export ANTHROPIC_MODEL="deepseek-v4-flash"
  export ANTHROPIC_SMALL_FAST_MODEL="deepseek-v4-flash"
  # unset CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY so the override wins
  claude   # then operate per this doc
  ```

  VALIDATED 2026-07-26: wire (Anthropic-shaped responses incl. thinking blocks), headless
  tool use (Read/Write), MCP (workflows + obs servers), and a cold-start read-only
  check-in that produced an accurate fleet picture from this doc + durable state alone.
  Not yet drilled: a fallback-driver merge-queue close-out and park under a real limit
  window (model-fallback-continuity Phase 4). The cold-start also proved the sharp edge:
  the fallback reports the Driver state paragraph AS WRITTEN — a stale paragraph is
  faithfully repeated, so the primary driver MUST keep it current (that is the contract).

## Authority — completion-oriented, merge-gated

The driver — ANY model — drives work to completion: fire chains, read findings, let loops
revise, finish stray evidence, update plan docs, verify at head. ONE hard boundary for a
fallback driver: **never merge to main**. Everything short of the merge is
reversible-by-branch; the merge is where Claude (or the human) has final say on return.
A fallback driver's goal state is a MERGE QUEUE: branches driven review-clean + verified,
listed in the session-state paragraph (below), waiting for the returning primary.

## Choosing a workflow tier

**Direct (light) — the default.** Use the current in-session spec → implement → review-loop
flow for bounded work whose premises and design choices are already settled.

**Spec-reviewed (heavy).** A spec chain first produces the specification as a plan document
and opens a spec PR. A reviewer panel checks that PR, revisions land, and the spec merges;
only then does a separate implementation chain run against the reviewed specification.

Consider the heavy tier when the work touches a data model or migration, has several
interlocking design questions, changes cross-cutting invariants, begins from an idea stub
rather than a scoped design, or spans more than one chain. The heavy tier is never mandatory;
the driver chooses it when the extra premise and design review is worth its cost.

## The check-in loop (cheap first, deep only on anomaly)

1. **`h status`** (landed 2026-07-26, PR #89; `--json` for scripted check-ins) — one
   screen. Verdict OK and nothing in flight you were waiting on → done, spend nothing
   further.
   **Before FIRING anything, read the headroom:** `h agents list --local` (or `h doctor`)
   prints one `quota:` line per executor — `5h 53% → 17:00 · 7d 22% → Tue 21:00`, a `!`
   marking a window the CLI last reported REJECTED, `reset` a window already past its
   reset. Those are the rate-limit windows the agent's own CLI reported at its last run,
   and the pre-fire gate reads the same row: a fire that would push a window past 100%
   (`--on-quota fail`, the default) or 90% (`--on-quota wait`) is refused BY NAME before
   any cost lands. Plan against the numbers rather than discovering them from a dead run —
   a 3,600s implement step that dies usage-limited at minute 40 has paid for 40 minutes.
2. **Per flagged/advanced chain:** read its findings off the row
   (`curl -s localhost:8003/chain/list | jq '.chains[] | select(.chainId=="X") | .data.reviewFindings'`)
   — NOT by re-reading the whole PR.
3. **Per finalized review loop:** unresolved PR review threads are the work queue; a loop
   that exhausted iterations usually left 1–2 residuals — finish them (evidence into the
   PR body, factual corrections) or re-fire a scoped revise.
4. **Failed instance?** Run ledger first: `~/code/h-workspace/.runs/<instanceId>/*/`
   (`summary.json` → status/stopReason; `output.txt` tail → what it was doing).
   `stopReason: usage-limited` → the fallback/park path, not a bug hunt.
5. **Update the session-state paragraph** in the ACTIVE plan doc (`## Driver state` at the
   bottom: in-flight / merge queue / parked / next). This is what makes driver intent
   transferable — write it every check-in, it is the next driver's first read.

## Merge protocol (primary driver only)

**The protocol below IS the gate — GitHub is not.** `main` carries branch protection (the
`Guard surface (lint → build → test → pytest)` check, plus required PR reviews), but
`enforce_admins` is off and the token h pushes with holds repo admin, so both an operator push
and an agent push sail straight past it. That is a deliberate 2026-08-12 decision — enforcing it
would end direct-to-main for everyone — but it means a green tick on GitHub proves nothing was
*checked*, only that nothing *blocked*. Never substitute it for step 2's sweep.

1. Loop finalized CLEAN (or operator-verified equivalent after an exhausted loop). **A
   first-round CLEAN deserves a spot-check, not trust** — verify the diff against the
   spec's key demand yourself. Two 2026-07-27 cases: trxy #54 was clean churn on a stale
   premise, and #56's clean verdict rested on one real panelist plus one that returned a
   bare `{"verdict":"CLEAN"}` with no summary.

   **How to judge a panelist as hollow (corrected 2026-07-28).** Use the *content* of the
   branch — a verdict with no summary and no cited findings is not a review. Do NOT judge
   by `toolCalls == 0` alone: until `868d080` the ledger tallied only the claude CLI's
   event shape, so EVERY non-claude agent recorded a confident `0` no matter how much work
   it did (h #96). The tally is now per-strategy and `toolCalls` is `number | null`, where
   **`null` means "not measurable for this agent", never zero** — and every run records its
   observed `eventShape`. Treat `null` as no-signal and read the output instead.

   **Reading a CAPPED loop — `"stopped after N iterations (findings may remain)"`.** Do not
   take that note at face value in either direction.

   - **`reviewFindings` records the last REVIEW, not the last REVISE.** The revise that
     follows the final review still runs; it just never gets re-reviewed. So a capped loop
     routinely lists findings that are ALREADY FIXED on the branch. **Check each finding
     against the branch before acting on it** — on 2026-07-28 both #98 and #99 capped with
     "residual" findings that were fully resolved. Trusting the note would have meant
     re-doing settled work or wrongly blocking a good merge.
   - **Conversely, a cap is not a pass — and the cheap resolution is one more round, not
     adjudication from the note.** Each round tends to surface NEW findings rather than
     re-report old ones, so "capped" means UNKNOWN. Demonstrated in both directions on PR #98
     (2026-07-28): round 3's recorded findings were already fixed on the branch, AND a fourth
     round then found two real defects three rounds had missed — an unwired `permissionMode`
     and a missing `Effect.withSpan`, the latter silently breaking trace correlation.
     Verify-at-head was fully green throughout; **no build/lint/test gate can catch a missing
     span or an unwired param.** Firing another review round costs ~30 min and is the only
     thing that answers the question.
   - **With a thorough panel, `loop-until-clean` effectively never returns CLEAN on a
     substantial PR** — it always finds something, so it terminates on the cap. CLEAN is
     therefore not a realistic merge gate by itself; expect to adjudicate residuals, and
     merge on *verify-at-head green + every recorded finding confirmed resolved*.

   **A panel cannot catch a build failure.** It reviews the DIFF and accepts the PR body's
   evidence claims. On 2026-07-28 PR #98 passed 3 full review rounds while `bun run lint`
   failed on TWO separate `oxfmt` violations — no number of further rounds would have found
   them. Always run the guard surface yourself (below), and feed what you find back as a PR
   comment: the revise leg reads PR comments, so that is the working channel for a driver
   finding.
2. Branch updated against main; verify sweep AT HEAD in a worktree:
   - h repo: `bun run lint && bun run build && bun run test && uv run --package h-cli pytest cli/h/tests`
     (all green — the suite is hermetic since #85).
   - trxy-v2: **this sweep is the ONLY pre-merge gate** — trxy CI no longer runs on pull
     requests (main + dispatch only since 2026-07-27, Actions rate limit); nothing catches
     a bad merge before it lands, so never merge on a loop's word alone. THE SEQUENCE IS
     LOAD-BEARING — in a fresh worktree always:
     `bun install && bun run build && bun run install:all && bun run verify`
     (build BETWEEN the two installs; the second must be `install:all` — a bare
     `bun install` skips mobile's yarn install and `lint:mobile` then fails inside
     `verify`). Skipping the rebuild+reinstall yields
     TS2591/TS2503 errors in untouched packages — build-architecture.md failure mode 1,
     NOT a pre-existing failure. `verify` is fully green (31/31 + 25/25); there are NO
     accepted pre-existing failures, and a run claiming one must prove it on base.
     Service-file changes additionally need
     `test:core` GREEN — if a run claims "Supabase unavailable", derive the env first:
     `supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)' | sed 's/^API_URL/SUPABASE_URL/; s/^ANON_KEY/SUPABASE_ANON_KEY/; s/^SERVICE_ROLE_KEY/SUPABASE_SERVICE_ROLE_KEY/' > packages/core/.env`
3. Squash-merge; commit message records what the loop caught and the verification
   evidence. Resolve any threads your close-out addressed (reply with the sha).

**A COLD e2e run lies — never merge or file on its first result.** In a fresh worktree the
bundler compiles on demand, the earliest specs blow their timeout on a loading screen, and
the screenshots look like a broken app. Live 2026-07-27: a cold trxy web-e2e run reported
9 failed / 7 passed with every failure in the alphabetically-early specs; re-running the
same specs warm passed them all. Re-run failures once before treating them as evidence —
this cuts both ways, since a run REPORTING e2e failures may just have been cold.

**Read exit codes, not grepped output.** `cmd | grep …` / `| tail …` returns the PIPE's
status, so `cmd | tail -2 && git commit` commits even when `cmd` FAILED (bit us
2026-07-27: a format:check failure sailed through a `&&` chain; only the pre-commit hook
saved the push). When a check gates an action, run it unpiped or capture `${PIPESTATUS[0]}`
— especially now that trxy CI cannot catch what the sweep misses.

## Recovery drawer

- **Re-fire a failed chain:** same registration + `--fresh` on the failed member
  (attach-by-default returns a terminal instance as-is — CLAUDE.md gotcha).
- **Usage-limited run / exhausted provider quota:** the reset time is in the `quota:` row
  (`h agents list --local`) and in the gate's refusal, which names the three ways past it.
  Since 2026-09-03 this is the path the shepherd takes BEFORE the run, not after: the gate
  refuses a fire that would exhaust the window, `--on-quota wait` parks it until the reset
  (a foreground local run sleeps, up to 6h; a service run arms a `cron:sched` continuation,
  at most `maxQuotaWaits` = 2 hops), and `--ignore-quota` is the deliberate override for a
  run you have decided is worth the risk. After a run DID die usage-limited: re-fire under
  an executor on a DIFFERENT provider, or park (`--at <resetsAt>` / `--in
  <duration-to-reset>` — the resetsAt is on the row, so schedule at reset + 1m rather than
  guessing). The three executors sit on three providers, so a quota outage never blocks
  everything:
  `claude` (Anthropic) · `codex` (OpenAI/ChatGPT) · `openhands` (DeepSeek, via
  `LLM_API_KEY`/`LLM_BASE_URL` — the same key the DeepSeek driver fallback uses).
  **A dead provider must be dropped from PANEL ROSTERS too**, not just implement legs: a
  panel is a parallel step group joined with whenAll, so one dead panelist fails the whole
  review member (observed 2026-07-27 — OpenAI quota ran out mid-batch; the codex implement
  leg had finished but the codex panelist took the review chain down with it). Re-fire the
  review with a roster on live providers, e.g. `--agent claude openhands`.
- **Mid-step death (state not landed):** the full session transcript is on disk —
  `~/code/h-workspace/.runs/<instanceId>/<agent>-<ts>/events.jsonl`; splice its tail into
  the continuation task.
- **Engine silence:** no chain advances for >5 min → check the workflow-svc heartbeat
  (`h status` flags it); recreate/restart workflow-svc host-local (`dapr stop --app-id
  workflow-svc` — the supervisor restarts it rebuilt).
- **Never push to main while implement chains are cutting worktrees** (fetch race,
  issue #84).

## Standing conventions

- **Diff a tracking doc the run touched.** `git diff <base>..<head> -- <doc>` must show no
  removed lines beyond the run's own status phrase and no second entry for the run's own unit;
  a PR number in that doc is stamped by the driver at merge, never by the run — on 2026-09-04,
  four trxy runs rewrote a neighbour's entry or duplicated their own.

- **Anticipate the rate limit; never discover it from a dead run.** The `quota:` row is the
  shepherd's clock as much as h's: read it before every fire (`h agents list --local`), and
  when a window is near its ceiling choose deliberately — a different executor for the
  next fire (`--agent codex`), `--on-quota wait` for anything unattended, or a scheduled
  fire at `resetsAt + 1m`. When the SEVEN-DAY window is what is exhausting, one reset does
  not help: the rest of the week's fires want another provider by default (a relay with
  `--fallback-agent codex` on the service substrate; a roster without claude locally).
  The shepherd's own wake-ups follow the same clock: a `/loop` or `ScheduleWakeup` that
  fires into an exhausted window pays for nothing, so time the next tick at the reset.

- **Verify a plan doc's CLAIMS against the repo before scoping a spec from it.** Half one of
  the pick-up validation the `plan-management` skill's step 2 and CLAUDE.md's Plans section
  require of every plan; stated here because scoping a spec is where a driver hits it. Plan docs
  drift: on 2026-07-27 two of the four docs used to scope a batch were stale —
  `architecture-lint-rules.md` listed four backlog sections already fixed and enforced at
  `error`, and `e2e-flow-backlog.md` claimed "Covered: auth, challenge, spot" while the
  tree held nine flows including the two the doc called un-built. A spec scoped from the
  latter produced a PR that redid finished work and had to be closed unmerged. Cheap
  check, seconds long: for each claim the spec will rest on, look at the tree (does the
  file/rule/flow exist? is the config already flipped?). Spec-aware review CANNOT catch
  this — the panel checks the diff against the spec, so a spec built on a false premise
  passes clean.
- **Interrogate the item's PREMISE before building it.** Half two, and the one the first cannot
  catch: that asks whether a doc's claims are still TRUE, this asks whether its goal is still
  WANTED. Both are required — a plan passing one says nothing about the other. Before designing anything from `carried-followups.md` or
  a plan's backlog, state what it was for, whether its `Revisit when:` trigger actually fired,
  what real usage exists, and what has changed since it was written. Dropping it is a normal
  outcome — record it in place with the reasoning. (2026-08-12: §2 proposed a coded chain-member
  kind whose whole benefit was six fewer CLI flags; every claim in it was accurate, its trigger
  had not fired, and the brevity it offered is the opposite of what this repo wants from a chain
  expression. A design review would only ever have caught HOW to build it, never WHETHER.)
- **The verify FLOOR must be green on base before a batch fires.** Prove the exact floor
  command passes on the target repo's main (fresh worktree) BEFORE registering chains on
  it — a floor that is red on base walls every honest run (2026-07-26: game-visibility
  implemented everything, then obeyed the gate and opened no PR because the floor carried
  a pre-existing failure). Fix the base or change the floor; never ship a known-red floor.
- **Harden h between target-repo tasks (operator rule, 2026-07-26):** an h weakness
  surfaced by a trxy arc (bug, template gap, loop inefficiency) is fixed in h BEFORE the
  next trxy task fires — fire the h chain in the between-tasks window. Check open h
  issues + the arc's friction at every window; don't batch hardenings for later.

- Chains: implement + `--after` review loop, explicit `-p slug=<feature-slug>`
  belt-and-braces; serialize loops over PRs that share files, merge between.
- Specs: never bare plan-doc pointers for cross-repo targets — splice content with
  `-p spec=@file`; state the repo, the touch-only scope, and the evidence duty.
- The stack runs HOST-LOCAL for trxy work (supabase CLI on host — memory
  `trxy-runs-local-mode`).
- **Serialize DB-touching trxy chains.** All trxy runs share ONE local Supabase stack; a
  `db:reset`/migration in one run corrupts or 502s another's gate (bit us 2026-07-26:
  ig-promo's final db:reset 502'd while game-visibility's acceptance ran concurrently).
  Never let two chains whose acceptance touches the DB overlap — gate with --after/--in,
  or hold the re-fire until the running one finalizes. Check `supabase status` health
  before re-firing after a 502.
