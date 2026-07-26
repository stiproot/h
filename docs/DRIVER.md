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
  export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
  export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"   # from .env
  export ANTHROPIC_MODEL="deepseek-chat"
  export ANTHROPIC_SMALL_FAST_MODEL="deepseek-chat"
  claude   # then operate per this doc
  ```

  (Validation status: see the model-fallback-continuity plan log — do not assume parity
  beyond what a validated check-in has proven.)

## Authority — completion-oriented, merge-gated

The driver — ANY model — drives work to completion: fire chains, read findings, let loops
revise, finish stray evidence, update plan docs, verify at head. ONE hard boundary for a
fallback driver: **never merge to main**. Everything short of the merge is
reversible-by-branch; the merge is where Claude (or the human) has final say on return.
A fallback driver's goal state is a MERGE QUEUE: branches driven review-clean + verified,
listed in the session-state paragraph (below), waiting for the returning primary.

## The check-in loop (cheap first, deep only on anomaly)

1. **`h status`** (until it lands: `h chain list`, `h watch list`, `h cron list`) — one
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
   - trxy-v2: `bun run verify` (accept ONLY the documented pre-existing failure:
     `ig-automation-svc` TS2503); service-file changes additionally need `test:core`
     GREEN — if a run claims "Supabase unavailable", derive the env first:
     `supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)' | sed 's/^API_URL/SUPABASE_URL/; s/^ANON_KEY/SUPABASE_ANON_KEY/; s/^SERVICE_ROLE_KEY/SUPABASE_SERVICE_ROLE_KEY/' > packages/core/.env`
3. Squash-merge; commit message records what the loop caught and the verification
   evidence. Resolve any threads your close-out addressed (reply with the sha).

## Recovery drawer

- **Re-fire a failed chain:** same registration + `--fresh` on the failed member
  (attach-by-default returns a terminal instance as-is — CLAUDE.md gotcha).
- **Usage-limited run:** the limit message states the reset time. Either re-fire under a
  fallback executor (`--agent codex`, deepseek when landed) or park: re-register the
  chain `--in <duration-to-reset>`.
- **Mid-step death (state not landed):** the full session transcript is on disk —
  `~/code/h-workspace/.runs/<instanceId>/<agent>-<ts>/events.jsonl`; splice its tail into
  the continuation task.
- **Engine silence:** no chain advances for >5 min → check the workflow-svc heartbeat
  (`h status` flags it); recreate/restart workflow-svc host-local (`dapr stop --app-id
  workflow-svc` — the supervisor restarts it rebuilt).
- **Never push to main while implement chains are cutting worktrees** (fetch race,
  issue #84).

## Standing conventions

- Chains: implement + `--after` review loop, explicit `-p slug=<feature-slug>`
  belt-and-braces; serialize loops over PRs that share files, merge between.
- Specs: never bare plan-doc pointers for cross-repo targets — splice content with
  `-p spec=@file`; state the repo, the touch-only scope, and the evidence duty.
- The stack runs HOST-LOCAL for trxy work (supabase CLI on host — memory
  `trxy-runs-local-mode`).
