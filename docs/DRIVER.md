# DRIVER — the h supervisor session's standing procedure

The DRIVER is the interactive session that fires chains, reads verdicts, verifies at head,
and merges. This doc is its durable procedure: any FRESH session — Claude, or a fallback
model — must be able to pick up the driver role from this file plus the runtime's durable
state, with zero conversation history. (docs/plans/model-fallback-continuity.md is the
plan behind this; the continuity inventory there lists what state lives where.)

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

## The check-in loop (cheap first, deep only on anomaly)

1. **`h status`** (landed 2026-07-26, PR #89; `--json` for scripted check-ins) — one
   screen. Verdict OK and nothing in flight you were waiting on → done, spend nothing
   further.
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

1. Loop finalized CLEAN (or operator-verified equivalent after an exhausted loop).
2. Branch updated against main; verify sweep AT HEAD in a worktree:
   - h repo: `bun run lint && bun run build && bun run test && uv run --package h-cli pytest`
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

**Read exit codes, not grepped output.** `cmd | grep …` / `| tail …` returns the PIPE's
status, so `cmd | tail -2 && git commit` commits even when `cmd` FAILED (bit us
2026-07-27: a format:check failure sailed through a `&&` chain; only the pre-commit hook
saved the push). When a check gates an action, run it unpiped or capture `${PIPESTATUS[0]}`
— especially now that trxy CI cannot catch what the sweep misses.

## Recovery drawer

- **Re-fire a failed chain:** same registration + `--fresh` on the failed member
  (attach-by-default returns a terminal instance as-is — CLAUDE.md gotcha).
- **Usage-limited run / exhausted provider quota:** the limit message states the reset
  time when it is a session limit. Re-fire under an executor on a DIFFERENT provider, or
  park (`--in <duration-to-reset>`). The three executors sit on three providers, so a
  quota outage never blocks everything:
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

- **Verify a plan doc's CLAIMS against the repo before scoping a spec from it.** Plan docs
  drift: on 2026-07-27 two of the four docs used to scope a batch were stale —
  `architecture-lint-rules.md` listed four backlog sections already fixed and enforced at
  `error`, and `e2e-flow-backlog.md` claimed "Covered: auth, challenge, spot" while the
  tree held nine flows including the two the doc called un-built. A spec scoped from the
  latter produced a PR that redid finished work and had to be closed unmerged. Cheap
  check, seconds long: for each claim the spec will rest on, look at the tree (does the
  file/rule/flow exist? is the config already flipped?). Spec-aware review CANNOT catch
  this — the panel checks the diff against the spec, so a spec built on a false premise
  passes clean.
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
