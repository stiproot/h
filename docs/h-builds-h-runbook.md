# h-builds-h runbook

Operating the self-build loop: labeled GitHub issues → `feature` runs on the h repo → PRs a
human reviews → auto-revised until merged. Design and rulings:
[docs/plans/h-builds-h.md](./plans/h-builds-h.md); the cron mechanism:
[docs/plans/workflow-watcher-registry.md](./plans/workflow-watcher-registry.md) §9 (discovery/
Job 1) and §10 (arm-at-birth revise/Job 2). Runs locally only — no inbound webhooks; all GitHub
state is poll-discovered on the `workflow-cron-tick`.

> **The loop is two crons, no sweep agent.** A **discovery cron** (§9) queries the issue board each
> tick and fires one `feature-pr` per newly-discovered issue (deduped against the `wf:*` keys). Each
> `feature-pr` run, on opening its PR, arms a per-PR **revise cron** (§10, `arm-revise`) that re-fires
> `revise` until the PR merges. Both crons are pure engine loops on workflow-svc — the retired
> `issue-sweep` agent (which bundled discover + revise into one judgment tick) is gone.

## Phase 0 — the security boundary (manual, do first)

GitHub (on the target repo):

1. Labels: `agent-approved` (the maintainer trust gate — restrict labeling to triage+
   collaborators), `agent-in-flight`, `agent-done`, `agent-needs-human`, `agent-retry`.
2. Branch protection on `main`: require a PR; the agent must never be able to push to main.
3. Credentials — **owner-repo trust model (current):** your SSH key does git transport as you
   (`GIT_AUTH=ssh`, optionally `GIT_SSH_KEY_PATH`), your PAT (`GH_TOKEN`) does API calls
   (PR creation, issue reads/comments) as you. Add a bypass rule so you can approve your own PRs.
   One identity; simplest — we own the repos the loop builds, so the executor (claude-agent) runs
   with full tools and the full token. A scoped coder token bound to a minimal-surface executor
   returns as a per-run trust profile if untrusted third-party repos come into play
   (docs/plans/reviewer-identity-security.md); claude-coder as a separate service was retired.

Local:

4. Pre-clone the target repo into the shared workspace root (`cli/scripts/clone.sh`).
5. `cli/charts/workflows/values.local.yaml` (gitignored) — feature/verify/create-pr config only;
   the discovery cron's repo/label/cadence are CLI args at arm time, not baked values:

   ```yaml
   feature:
     clonePath: /workspace/repo            # the pre-clone (agent-visible path)
     gitAuth: ssh                           # or omit for the GH_TOKEN pat path
   verify:
     cmd: "bun install --frozen-lockfile && bun run build && bun run test"  # pure build+unit ONLY
   createPr:
     gitAuth: ssh                           # match feature.gitAuth
   ```

Acceptance: a push to `main` with the loop's credential is rejected (branch protection), so the
loop can only land work through a PR.

## Bring-up order

```sh
cli/scripts/run-claude-agent.sh      # the loop's executor (feature runs + pr-review)
# workflow-svc, workflow-mcp, dapr-mcp, obs-mcp as usual (make dev-tab)
```

`GH_TOKEN` must be set on **workflow-svc** — the discovery cron reads the issue board itself (the
`git-core` GitHub client), no agent involved. Keep the MCP servers running whenever agents run — a
down MCP silently drops tools from a `feature-pr` run.

## Publish, seed, arm

```sh
# 1. The feature-pr template (feature ⊕ verify ⊕ create-pr ⊕ arm-revise; params: slug, spec,
#    issueNumber). Each run implements the issue, gates on the acceptance check, and opens its PR —
#    all in the one implement agent — then arm-revise arms a revise-until-merged recur cron for the
#    PR it just opened (§10, Job 2; a SKIPPED push arms nothing).
uv run h template compose feature verify create-pr arm-revise --save feature-pr

# 2. Also publish `revise` (the per-PR loop's target) so the arm-revise cron has a key to re-fire.
uv run h workflow publish revise

# 3. Phase-1 acceptance: hand-fire one issue-linked run before any automation.
#    Template VALUES ride -p key=value (slug/spec/issueNumber/repo); --agent selects the executor.
uv run h workflow run feature-pr -p repo=<owner>/h -p slug=issue-X -p spec=@toy.md \
  -p issueNumber=X --instance-id feature-issue-X --agent claude-agent
#    Confirm it opened a PR AND armed a revise cron: `h cron list` shows a
#    cron:sub:<owner>/h:issue-X:revise row.

# 4. Arm the discovery cron — the standing patrol. This fires a one-step provision workflow whose
#    register-discover activity writes the cron:discover row (§10 — crons via activities); its wf:
#    row audits the registration. --run-budget-mins attaches a watch policy so the watcher engine
#    terminates a hung feature-pr (and --run-retries re-fires a failed one) rather than it stalling
#    the one-in-flight serialize.
uv run h cron discover add <owner>/h \
  --label agent-approved --cadence "*/30 * * * *" --workflow feature-pr --max-per-day 3 \
  --run-budget-mins 40 --run-retries 2

# 5. Inspect the loop.
uv run h cron list        # recur crons (per-PR revise loops) + discovery crons, with the scan heartbeat
```

The discovery cron serializes (one `feature-pr` in flight at a time) and is bounded by
`--max-per-day`; it reads the issue board only when due (the cadence IS the GitHub read budget). It
skips any issue that already has a `wf:<repo>:issue-<n>:feature-pr` row — the dedup that fixes the
duplicate-dispatch bug.

## Kill switches (in order)

1. `state_save cron:config {"enabled": false}` (dapr MCP) — pauses the WHOLE cron family scan
   (discovery + every per-PR revise loop) loudly; `cron:__tick__` records disarmed.
2. Remove `agent-approved` labels on GitHub — nothing new is eligible to discover (in-flight PRs
   still revise until merged/budget).
3. `state_save watch:config {"enabled": false}` — pauses the watcher scan (supervision of in-flight
   runs), independent of the cron family.

*(A per-cron deactivate CLI — `h cron rm <id>` — is a deferred follow-up; today a single discovery/
revise cron is stopped by letting its budget exhaust, resolving its goal, or the family kill switch.)*

## Termination & budgets (engine-owned)

- **Per-PR revise loop** stops on either the goal (`revise` reports `===GOAL===RESOLVED` when the PR
  merges → the cron engine reads `wf:*.resolved` and deactivates) OR its `maxFires` budget (a PR that
  never merges still stops, bounded). (`revise` also reports `goal: RESOLVED|PENDING` in its
  structured output block — docs/plans/structured-workflow-outputs.md — but the goal handshake still
  reads the MARKER today; the structured cutover for `goalResolved`/`register-cron` is deferred.)
- **Discovery cron** never "resolves" — it drains the label class, bounded per-day by `maxFiresPerDay`;
  it runs until the family kill switch or a `h cron rm` (deferred).
- **A hung `feature-pr` run** is supervised by the watcher engine when the discovery cron is armed with
  `--run-budget-mins` (wall-clock `maxDurationMs` terminate) and optionally `--run-retries` (engine
  re-fire of a failed run). Without those flags the fired runs are unsupervised — a hung run is caught
  only by its own budget while the discovery cron's serialize waits it out.
- Inspect any run: `analyze-workflow-run` / `/observe` / `h watch get <instanceId>`; the join key is
  the `workflowInstanceId` (`feature-issue-<n>` / `revise-issue-<n>`).

## Named residual risks

- Engine budget-terminate ends the workflow, not the in-flight `claude` subprocess.
- No hard token cap inside h — set a LiteLLM-proxy budget too.
- Local/compose only: the k8s cron path can double-fire (no leader guard).
- Worktrees accumulate until a GC family ships.
- An UNsupervised (`--run-budget-mins` omitted) hung `feature-pr` stalls the discovery cron's serialize
  until the run's own budget trips — arm the watch policy to avoid this.
