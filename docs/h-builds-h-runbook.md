# h-builds-h runbook

Operating the self-build loop: labeled GitHub issues → `feature` runs on the h repo → PRs a
human reviews. Design and rulings: [docs/plans/h-builds-h.md](./plans/h-builds-h.md). Runs
locally only — no inbound webhooks; all GitHub state is poll-discovered by the sweep tick.

## Phase 0 — the security boundary (manual, do first)

GitHub (on the target repo):

1. Labels: `agent-approved` (the maintainer trust gate — restrict labeling to triage+
   collaborators), `agent-in-flight`, `agent-done`, `agent-needs-human`, `agent-retry`.
2. Branch protection on `main`: require a PR; the agent must never be able to push to main.
3. Credentials — either posture:
   - **Owner-repo trial (current):** your SSH key does git transport as you
     (`GIT_AUTH=ssh`, optionally `GIT_SSH_KEY_PATH`), your PAT (`GH_TOKEN`) does API calls
     (PR creation, issue reads/comments) as you. Add a bypass rule so you can approve your
     own PRs. One identity; simplest.
   - **Two-token split (graduation):** sweep token (`GH_TOKEN` on claude-agent) =
     issues:read+write + PR read; coder token (`GH_CODER_TOKEN` on claude-coder) =
     contents:write + pull_requests:write + issues:read ONLY. Prefer a machine user so a
     human account can approve the bot's PRs.

Local:

4. Pre-clone the target repo into the shared workspace root (`cli/scripts/clone.sh`).
5. `cli/charts/workflows/values.local.yaml` (gitignored):

   ```yaml
   feature:
     sourceRepo: /workspace/repo            # the pre-clone (agent-visible path)
     verifyCmd: "bun install --frozen-lockfile && bun run build && bun run test"  # pure build+unit ONLY
     gitAuth: ssh                           # or omit for the GH_TOKEN pat path
   issueSweep:
     repo: <owner>/h
     coderWorkflowUrl: http://localhost:8014/workflow   # claude-coder; claude-agent (8002) until the split
   ```

Acceptance: a push to `main` with the coder credential is rejected; the coder PAT cannot
create an issue (two-token posture only).

## Bring-up order

```sh
cli/scripts/run-claude-agent.sh      # the trusted instance (sweep) — full MCP set
cli/scripts/run-claude-coder.sh      # the stripped instance (feature runs) — github MCP only
# workflow-svc, workflow-mcp, dapr-mcp, obs-mcp as usual (make dev-tab)
```

Keep the MCP servers running whenever agents run — a down MCP silently drops tools; the sweep's
preflight step turns that into an explicit `TOOLS UNAVAILABLE` stop.

## Publish, seed, arm

```sh
# 1. The feature family (params: slug, spec, createPr, issueNumber; config baked from values.local)
uv run h workflow publish feature

# 2. Phase-1 acceptance: hand-fire one issue-linked run before any automation
uv run h workflow run feature -p slug=issue-X -p spec=@toy.md -p createPr=true \
  -p issueNumber=X --instance-id feature-issue-X --agent claude-coder

# 3. Seed the runtime config (dapr MCP state_save, or curl the state API):
#    key sweep:config
#    {"enabled": true, "maxAttemptsPerIssue": 2, "maxRunsPerDay": 3,
#     "dailyBudgetUsd": 5, "runBudgetMs": 2400000}

# 4. Phase-2 acceptance: label ONE toy issue agent-approved, then dry-fire the sweep
uv run h workflow publish issue-sweep --key issue-sweep-dry   # with issueSweep.dryRun=true set
uv run h workflow run issue-sweep-dry
#    then live-fire once, watch it dispatch, fire AGAIN mid-run (gate C stops it),
#    and again after completion (reconcile stamps done + comments the PR link).

# 5. Arm the clock — parked first, enable deliberately
uv run h workflow publish issue-sweep --schedule "*/30 * * * *" \
  --workspace-id h-issue-sweep --disabled
uv run h workflow publish issue-sweep --schedule "*/30 * * * *" \
  --workspace-id h-issue-sweep          # re-save without --disabled = armed
```

## Kill switches (in order)

1. `h workflow publish issue-sweep --schedule "*/30 * * * *" --workspace-id h-issue-sweep
   --disabled` — parks the schedule; honored by the cron and trigger paths.
2. `state_save sweep:config {"enabled": false}` — the sweep's own gate 0 stops every tick.
3. Remove `agent-approved` labels on GitHub — nothing is eligible to discover.

## Retry semantics (watcher-engine cutover — docs/plans/watcher-primitive.md)

- Mechanical retries are ENGINE-owned now: the sweep's dispatch carries
  `watch: {maxDurationMs, retry: {maxAttempts, fresh: true}}`, and workflow-svc's scan
  re-fires a FAILED run under the cap automatically (fresh purge, same instanceId, engine
  `attempts` on the `watch:sub:feature-issue-<n>` row). The sweep no longer re-dispatches.
- At the cap, the sweep (reading the watch row) marks the issue `abandoned` + labels
  `agent-needs-human`, with the instanceId in a comment — feed it to
  `analyze-workflow-run` / `/observe` / `h watch get <instanceId>`.
- A human re-arms with the `agent-retry` label; the next sweep dispatch fires with
  `fresh: true` (a new watch epoch — engine attempts continue, they are monotonic).
- Retries are cheap: `workspaceId feature-issue-<n>` reuses the worktree and the persisted
  plan file.
- Watcher kill switch (separate from the sweep's): `state_save watch:config
  {"enabled": false}` pauses the scan loudly (`watch:__tick__` records disarmed); the sweep's
  staleness guard then falls back to direct status polling and reports ENGINE STALE.

## Named residual risks

- Engine budget-terminate ends the workflow, not the in-flight `claude` subprocess.
- No hard token cap inside h — set a LiteLLM-proxy budget too.
- Sweep-overlap safety is the concurrency gate + stable instanceIds, not a lock; the 30-min
  cadence makes overlap unlikely, not impossible.
- Local/compose only: the k8s cron path can double-fire (no leader guard).
- Worktrees accumulate until a GC family ships (phase 4).
- PR review-comment resolution is designed (plan §Decisions 3) but NOT yet in the sweep
  prompt — comments on an open agent PR are not acted on automatically yet.
