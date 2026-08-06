# h-builds-h runbook

Operating the self-build loop: labeled GitHub issues → `feature` runs on the h repo → PRs a
human reviews → auto-revised until merged. Design and rulings:
[docs/plans/impl/h-builds-h.md](./plans/impl/h-builds-h.md); the cron mechanism:
[docs/plans/impl/workflow-watcher-registry.md](./plans/impl/workflow-watcher-registry.md) §9 (discovery/
Job 1) and §10 (arm-at-birth revise/Job 2). Runs locally only — no inbound webhooks; all GitHub
state is poll-discovered on the `workflow-cron-tick`.

> **The loop is two crons, no sweep agent.** A **discovery cron** (§9) queries the issue board each
> tick and fires one `implement-pr` per newly-discovered issue (deduped against the `wf:*` keys). Each
> `implement-pr` run, on opening its PR, arms a per-PR **revise cron** (§10, `arm-revise-pr`) that re-fires
> `revise-pr` until the PR merges. Both crons are pure engine loops on workflow-svc — the retired
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

Host mode:

4. Pre-clone the target repo into the shared workspace root (`cli/scripts/clone.sh`). It lands at
   `<WORKSPACE_ROOT>/repo` by default — the SAME location the agent's /worktree route resolves as
   `<sharedRoot>/repo` (from AGENT_BASE_DIR). **This is mode-agnostic:** host `…/h-workspace/repo`
   and compose `/workspace/repo` are the same dir (../h-workspace is bind-mounted at /workspace), so
   the pre-clone + worktrees work in either mode without changing config. Do NOT bake a `clonePath`.
5. `cli/charts/workflows/values.local.yaml` (gitignored) — feature/verify/create-pr config only;
   the discovery cron's repo/label/cadence are CLI args at arm time, not baked values. Leave
   `clonePath` UNSET so host ⇄ compose stay interchangeable (only set it to point at a repo
   pre-cloned to a non-default path):

   ```yaml
   feature:
     # clonePath: intentionally unset — the agent defaults to <sharedRoot>/repo (mode-agnostic).
     gitAuth: pat                           # or ssh; pat uses the ambient GH_TOKEN
   verify:
     cmd: "bun install --frozen-lockfile && bun run build && bun run test"  # pure build+unit ONLY
   createPr:
     gitAuth: pat                           # match feature.gitAuth
   ```

Acceptance: a push to `main` with the loop's credential is rejected (branch protection), so the
loop can only land work through a PR.

### Shared workspace (host ⇄ compose interchangeable) — one-time

The workspace root (`../h-workspace`) is shared by both modes: host run-scripts write it as your uid,
compose agents write it as `agent-svc` (uid/gid **10001**). Whichever ran first would own the
pre-clone + worktrees and lock the other out (the cross-uid problem — same class as the poisoned bun
cache). Make it a shared, group-owned workspace ONCE (before `clone.sh`, and re-run after if new files
land root-owned):

```sh
sudo cli/scripts/setup-agent-workspace.sh   # group-owns ../h-workspace by AGENT_GID (10001), setgid
                                            # + group-writable, and adds you to the group
newgrp agent                                # (or re-login) so your group membership applies
```

The host run-scripts set `umask 002` (via `_lib.sh`) and compose runs as gid 10001, so files either
mode creates in the workspace stay group-writable — both modes then share it, and the identical
mode-agnostic workflow config (`clonePath` unset → `<sharedRoot>/repo`) runs in either.

## Bring-up order

```sh
cli/scripts/run-claude-agent.sh      # the loop's executor (feature runs + review-pr)
# workflow-svc, workflow-mcp, dapr-mcp, obs-mcp as usual (make dev-tab)
```

`GH_TOKEN` must be set on **workflow-svc** — the discovery cron reads the issue board itself (the
`git-core` GitHub client), no agent involved. Keep the MCP servers running whenever agents run — a
down MCP silently drops tools from a `implement-pr` run.

## Publish, seed, arm

```sh
# 1. The implement-pr template (implement ⊕ verify ⊕ run-itest ⊕ create-pr ⊕ arm-revise-pr; params:
#    slug, spec, issueNumber). Each run: implement commits locally (gates on the prose acceptance
#    check; no push, no PR); the MACHINE-executed itest step runs the worktree integration gate
#    (docs/plans/worktree-integration-gate.md: ephemeral k8s namespace, base-ref harness,
#    infra/assertion taxonomy) — a red gate FAILS THE WORKFLOW HERE, BEFORE the PR is opened; then
#    create-pr pushes the branch and opens the PR (embedding the itest evidence in the body); then
#    arm-revise-pr arms a revise-until-merged recur cron (§10, Job 2; a SKIPPED push arms nothing).
#    run-itest is part of the implementor's definition of done — do not compose without it.
#
#    REQUIRES K8S MODE. The gate deploys an ephemeral h-itest-<id> namespace, so it is the one
#    part of this loop that needs k3d + `make dapr-install` — a host/container-only box cannot
#    run it. Do NOT quietly drop the step to make the loop fit such a host: either run the loop
#    from a k8s-capable machine, or engage the activity's documented break-glass (the `skip` /
#    `skipReason` step inputs), which records class="skipped" in the evidence and embeds the
#    reason in the PR body — an auditable waiver rather than a silently missing gate.
uv run h template compose implement verify run-itest create-pr arm-revise-pr --save implement-pr

# 2. Also publish `revise-pr` (the per-PR loop's target) so the arm-revise-pr cron has a key to re-fire.
uv run h workflow publish revise

# 3. Phase-1 acceptance: hand-fire one issue-linked run before any automation.
#    Template VALUES ride -p key=value (slug/spec/issueNumber/repo); --agent selects the executor.
uv run h workflow run implement-pr -p repo=<owner>/h -p slug=issue-X -p spec=@toy.md \
  -p issueNumber=X --instance-id feature-issue-X --agent claude-agent
#    Confirm it opened a PR AND armed a revise cron: `h cron list` shows a
#    cron:sub:<owner>/h:issue-X:revise row.

# 4. Arm the discovery cron — the standing patrol. This fires a one-step provision workflow whose
#    register-discover activity writes the cron:discover row (§10 — crons via activities); its wf:
#    row audits the registration. --run-budget-mins attaches a watch policy so the watcher engine
#    terminates a hung implement-pr (and --run-retries re-fires a failed one) rather than it stalling
#    the one-in-flight serialize.
uv run h cron discover add <owner>/h \
  --label agent-approved --cadence "*/30 * * * *" --workflow implement-pr --max-per-day 3 \
  --run-budget-mins 40 --run-retries 2

# 5. Inspect the loop.
uv run h cron list        # recur crons (per-PR revise loops) + discovery crons, with the scan heartbeat
```

The discovery cron serializes (one `implement-pr` in flight at a time) and is bounded by
`--max-per-day`; it reads the issue board only when due (the cadence IS the GitHub read budget). It
skips any issue that already has a `wf:<repo>:issue-<n>:implement-pr` row — the dedup that fixes the
duplicate-dispatch bug.

## Kill switches (in order)

1. `state_save cron:config {"enabled": false}` (dapr MCP) — pauses the WHOLE cron siblings scan
   (discovery + every per-PR revise loop) loudly; `cron:__tick__` records disarmed.
2. Remove `agent-approved` labels on GitHub — nothing new is eligible to discover (in-flight PRs
   still revise until merged/budget).
3. `state_save watch:config {"enabled": false}` — pauses the watcher scan (supervision of in-flight
   runs), independent of the cron siblings.

To disarm a specific recur cron (stops a single workflow from recurring without touching the kill
switch), use `h cron rm <repo> <slug> <workflow>` — e.g. `h cron rm stiproot/h dark-mode revise`.
This calls `POST /cron/disarm` (workflow-svc, the single writer); the row stays for audit.

## Termination & budgets (engine-owned)

- **Per-PR revise loop** stops on either the goal (`revise-pr` reports `goal: RESOLVED` in its
  validated structured output when the PR merges — docs/plans/impl/structured-workflow-outputs.md — →
  `goalResolved` records `wf:*.resolved` and the cron engine deactivates) OR its `maxFires` budget
  (a PR that never merges still stops, bounded).
- **Discovery cron** never "resolves" — it drains the label class, bounded per-day by `maxFiresPerDay`;
  it runs until the group kill switch (`h cron rm` is RECUR-only — a discovery row's identity is
  repo+label, which `REPO SLUG WORKFLOW` cannot address; a discovery disarm is a follow-up).
- **A hung `implement-pr` run** is supervised by the watcher engine when the discovery cron is armed with
  `--run-budget-mins` (wall-clock `maxDurationMs` terminate) and optionally `--run-retries` (engine
  re-fire of a failed run). Without those flags the fired runs are unsupervised — a hung run is caught
  only by its own budget while the discovery cron's serialize waits it out.
- Inspect any run: `analyze-workflow-run` / `/observe` / `h watch get <instanceId>`; the join key is
  the `workflowInstanceId` (`feature-issue-<n>` / `revise-issue-<n>`).
- **One-screen check-in**: `h status [--json]` reports active chains (stage cursor, loop iteration,
  findings count), engine heartbeats (stale >5m flagged), and a verdict line (OK / ATTENTION) — the
  low-token driver signal for "is h doing what it should".

## Named residual risks

- Engine budget-terminate ends the workflow, not the in-flight `claude` subprocess.
- No hard token cap inside h — set a LiteLLM-proxy budget too.
- Host/compose only: the k8s cron path can double-fire (no leader guard).
- Worktrees accumulate until a GC system ships.
- An UNsupervised (`--run-budget-mins` omitted) hung `implement-pr` stalls the discovery cron's serialize
  until the run's own budget trips — arm the watch policy to avoid this.
