# h builds h: labeled GitHub issues → feature PRs, on cron

**Status:** design complete (2026-07-05); phase 0 not started
**Living doc** — update the Progress log as phases land.

## Context

Dogfooding the harness by having it build itself: a maintainer labels an issue on the h
repo `agent-approved`; a cron-fired sweep turns it into a run of the published `feature`
family against the h repo itself (with the `createPr` ending); a human reviews and merges
the PR, which closes the issue. The design was produced by a multi-agent exploration
(2 grounding passes — capability inventory + self-build risk analysis — 3 independent
designs: minimal-glue / event-driven-purist / operator-first, then an adversarial
synthesis), verified against `cli/charts/workflows/templates/feature.yaml`,
`apps/workflow-svc/src/infrastructure/dapr-workflow-invoker.ts`,
`apps/workflow-svc/src/presentation/http/trigger.router.ts`,
`packages/js/agent-server/src/workflow-babysitter.ts`, and WORKFLOWS.md.


---

## 1. The recommended end-to-end loop

```
 human labels issue #<n> `agent-approved` on the h repo        ← trust gate #1 (untrusted text admitted)
        │
 dapr cron binding workflow-cron-tick (60s)                     dapr/local/workflow-cron.yaml
        ▼
 workflow-svc POST /workflow-cron-tick                          cron.router.ts → scheduling.ts
   isDue("issue-sweep")? disabled? → invoke saved family, stamp lastRunAt (stamp-forward)
        ▼
 issue-sweep instance (generic.workflow.ts, workspaceId=h-issue-sweep)
   setup (idempotent) → run-claude "sweep" on claude-agent      ← the TRUSTED instance:
        │                                                          full dapr+workflows+obs+github MCP
        │  fail-closed checklist (§4 below):
        │  0 tool preflight + h-auto:config.enabled gate
        │  R reconcile every in-flight issue via get_workflow_status
        │      (poll-based truth; extract ===VERIFY===/===PR=== from run output via obs run_get;
        │       stamp registry, swap labels, comment PR link / failure+instanceId on the issue)
        │  B budget gate (runs/day, costUsd/day from run: mirrors)   C concurrency gate (1 in flight)
        │  D discover: open issues labeled agent-approved, skip done/abandoned/bot-authored, pick OLDEST
        │  S compose spec: fenced verbatim title+body + untrusted-input preface
        │  M mark registry in-flight  →  F fire:
        ▼
 curl POST http://claude-coder:<port>/workflow                  workflow-route.ts (standard endpoint)
   { key: "feature", params: {slug: "issue-<n>", spec, createPr: "true", issueNumber: "<n>"},
     instanceId: "feature-issue-<n>", workspaceId: "feature-issue-<n>",
     policy: {maxDurationMs: runBudgetMs} }
   → 202 {instanceId, watching:true}; claude-coder's babysitter supervises (budget-terminate,
     terminal workflow-events)                                   workflow-babysitter.ts
        ▼
 feature family executes ON claude-coder                        ← the STRIPPED instance:
   create-worktree (feature/issue-<n> off origin/main of the       github MCP ONLY (.mcp.coder.json),
     pre-cloned h repo) → setup → plan (read-only, reuses          minimal env (GH_TOKEN + model key)
     persisted plan-feature-issue-<n>.md) → implement → verify
     (verifyCmd fix-forward ≤3, ===VERIFY=== PASS/FAIL)
   → PASS-gated PR epilogue: commit, one-shot GH_TOKEN push,
     create_pull_request with "Closes #<n>" → ===PR=== <url>
        ▼
 next sweep tick reconciles terminal → registry done + prUrl, label agent-done,
   comment PR link on issue #<n>
        ▼
 human reviews the PR                                           ← trust gate #2 (code admitted)
   merge → GitHub auto-closes #<n> (Closes #N) → issue leaves the label query forever
```

Every hop is observable on existing rails: one Zipkin trace roots at the cron tick; the feature run's ledger and traces key on `feature-issue-<n>`; failure comments carry the instanceId that `/observe`, `/run`, and `analyze-workflow-run` join on.

---

## 2. Agreements and rulings

### Where all three designs agreed (adopt without further debate)

1. **One new chart family (`issue-sweep`) on the existing cron-saved-workflow machinery.** No new pub/sub topic, no new agent service, no new cron binding. The family MUST carry the family gate (`{{- if eq .Values.family "issue-sweep" }}`).
2. **The issue body is the spec, verbatim.** No issue→spec grooming step; the feature family's plan step is where reading-the-spec judgment already lives. Revisit only if PRs miss the point.
3. **The statestore registry is the dedup authority** — not instanceIds (a terminal instance under a reused id is *purged and re-run*, `dapr-workflow-invoker.ts:104-106`, so instanceId alone cannot prevent reprocessing a done issue) and not GitHub labels (mirror only).
4. **A maintainer-applied label is the trust gate.** Issue text becomes a prompt for an agent running `--dangerously-skip-permissions`; only text a maintainer has read gets in. GitHub makes this structural: only triage+ collaborators can label.
5. **`workspaceId = feature-issue-<n>`, stable across attempts** — one worktree, idempotent setup, persisted `plan-feature-issue-<n>.md` makes retries cheap.
6. **One issue in flight, attempt cap 2**, then hands-off with a human-visible marker.
7. **Poll-based reconciliation is the durable truth.** Babysitter watches are in-process and die on restart (`workflow-babysitter.ts:112`); nothing subscribes to `workflow-events` today. The sweep tick re-polls status; events are at most a fast path.
8. **feature.yaml gains an `issueNumber` param** (the `createPr` pattern) and `Closes #N` prose in both epilogue branches; goldens re-blessed deliberately.
9. **Config-only guardrails first**: fine-grained PAT, branch protection on `main`, `disabled: true` kill switch, verifyCmd = pure build+unit only, local/compose only (k8s cron double-fires, WORKFLOWS.md:166).
10. **Dry-run mode and manual fires before any schedule.**

### Disagreements and rulings

| # | Question | A | B | C | Ruling |
|---|---|---|---|---|---|
| D1 | Sweep: agent step or deterministic workflow-svc activity? | agent | **activity** (port/adapter/registry code in workflow-svc) | agent | **Agent step** (A/C). B's principle is right — scanning has no judgment — but B's rebuttal fails on its own terms: the *cron* is the loop; the sweep is one bounded tick, not an agent supervising a loop (the anti-pattern the babysitter principle forbids). The agent tick costs one chart family; B's version costs a new port, adapter, registry store, activity, `GH_TOKEN` in workflow-svc's env, and invoker changes — all before the loop has proven its shape. Adopt B's discipline instead: a numbered fail-closed checklist, cheap model, explicit tool preflight. Promote to a deterministic activity later **only if** the sweep proves flaky in practice (criteria in §5 open questions). |
| D2 | Dispatch: `run_saved_workflow` (workflows MCP) or agent-service `POST /workflow`? | MCP (punts babysitter) | POST /workflow | POST /workflow | **`POST /workflow`** (B/C — and A concedes it as its own upgrade path). It is the only path that attaches a budget-terminate and publishes terminal events; trigger-fired and MCP-fired runs are unsupervised, and an unattended loop must not create unbudgeted agent runs. The sweep curls the coder's `/workflow` with explicit `instanceId`/`workspaceId`/`policy`. |
| D3 | Strip the coding agent's control plane? | punt | reduce claude-agent's `MCP_CONFIG_SRC` | dedicated `claude-coder` instance | **Dedicated `claude-coder`** (C). The risk report's single highest-leverage change: the agent that executes untrusted specs holds `github` only — no `workflows` (can't `save_workflow` over the feature family or `terminate_workflow` siblings), no `dapr` (can't `state_save`/`pubsub_publish` in the flat keyspace). B's variant is unworkable because the *sweep* needs the full MCP set on claude-agent — two configurations require two instances. The feature chart already parameterizes `agentId`, so this is compose+script+json config, zero chart logic. The plan-persistence prose already tolerates a missing dapr MCP (`feature.yaml:111-113`). |
| D4 | Registry namespace | `issue:<n>` | `issue:<n>` + `dispatch:` + quota keys | `h-auto:*` | **`h-auto:*`** (C). `issue:` is too generic for a deliberately flat shared keyspace; `h-auto:` scopes ownership and brings `h-auto:config` (runtime enable/budget knobs, writable from the repo session via dapr-mcp) and `h-auto:ledger:<date>` along. Schema merged from A/B (attempts, instanceId, prUrl, status, updatedAt). Skip B's `dispatch:<instanceId>` reverse map — it only serves the deferred event finalizer (D7). |
| D5 | instanceId scheme | `feature-issue-<n>` | `feature-issue-<n>-a<attempt>` | `feature-issue-<n>` | **Stable `feature-issue-<n>`** (A/C). It keeps the RUNNING/PENDING-reuse belt against sweep overlap, keys the ledger/traces/worktree/branch on one readable id, and matches the family's own non-publish convention. B's concern — purge destroys attempt history — is real but the purged copy (Dapr instance metadata) is the least valuable one: the run ledger (per-attempt subdirs under one instanceId dir) and Zipkin survive purge and are the forensic record. Attempt count lives in the registry. |
| D6 | GitHub labels: state machine mirror or registry-only? | registry-only (`issues:read` token) | mirror | mirror | **Mirror** (B/C). The human's steady state is on GitHub, not `state_get`; `agent-in-flight`/`agent-done`/`agent-needs-human` are the operator dashboard, and human-applied `agent-retry` is the re-arm control without touching Redis. Registry stays truth; divergence is cosmetic. A's structural anti-self-filing defense is preserved via D8's token split instead. |
| D7 | Build the `workflow-events` finalizer subscriber now? | no | yes (events.router.ts + invoker output exposure) | no (backlog) | **Defer** (A/C). The reconcile tick is mandatory regardless (restart-orphaned watches), so the finalizer is purely a latency optimization on a 30-minute loop — not worth workflow-svc code on the critical path. Phase 4 item, together with B's status-output exposure (C8), which is independently useful for `h workflow status`. |
| D8 | Token scope: `issues:read` (kills self-filing structurally) vs `issues:write` (enables write-back) | read | write | write, split later | **Two tokens, immediately** (merge of A and C): the **sweep** token (claude-agent env) gets `issues:read+write` — labels and comments are the loop's human interface; the **coder** token (claude-coder env) gets `contents:write` + `pull_requests:write` + `issues:read` only. The agent exposed to untrusted text cannot file or edit issues — A's structural defense — while the trusted sweep writes back. Both h-repo-only, fine-grained, no org scope. |
| D9 | Daily budget enforcement | none (cadence is the cap) | dispatch quota key | runs/day + costUsd/day gates, fail-closed | **C's gates.** `h-auto:config {maxRunsPerDay, dailyBudgetUsd, runBudgetMs}` + `h-auto:ledger:<date>` summed from `run:<id>` `costUsd` mirrors via obs `runs_list`. Cheap (prose + two keys), and unattended operation without a spend gate is not acceptable. Named residual: not a hard token cap — set the LiteLLM proxy budget too. |
| D10 | Spec framing | verbatim | fenced + preface | fenced + preface | **Fenced + untrusted-input preface** (B/C). Defense-in-depth only, never load-bearing — the label gate is the real boundary. |
| D11 | Cadence | hourly | */10 | */30 | **`*/30 * * * *`.** Each tick is a real (cheap-model) agent run, and with one-in-flight most ticks only reconcile; 30m keeps the reconcile latency tolerable. Tune after a week. |

---

## 3. Phased build plan

### Phase 0 — Config floor (no code; do first, it is the security boundary)

**Deliverables**
- GitHub: labels `agent-approved`, `agent-in-flight`, `agent-done`, `agent-needs-human`, `agent-retry`; branch protection on `main` (require PR + review); two fine-grained PATs per ruling D8.
- `.env` / compose env split for the two tokens; `cli/scripts/gen-k8s-secrets.sh` untouched (loop is not for k8s).
- Pre-clone h into the shared workspace root (`cli/scripts/clone.sh`).
- `cli/charts/workflows/values.local.yaml` (gitignored): `feature.sourceRepo` (the h clone path), `feature.verifyCmd` = pure build+unit (`bun install --frozen-lockfile && bun run build && bun run test` — never compose/Tilt-touching scripts), `feature.models.*`.

**Acceptance:** attempt a direct push to `main` with the coder PAT → rejected. `gh api` (or curl) with the coder PAT cannot create an issue; the sweep PAT can comment.

### Phase 1 — Issue-linked feature runs (smallest demonstrable loop, human-fired)

**Deliverables**
- `cli/charts/workflows/templates/feature.yaml`: `issueNumber` param, exactly the `createPr` pattern (publish mode emits `h.token "params.issueNumber"`, absent → `''`); `===ISSUE===` section + *"if the value is a number N, include `Closes #N` on its own line in the PR body"* in **both** epilogue branches (implement-final and verify-final).
- `cli/h/tests`: re-bless feature goldens (review the `.ambr` diff).
- Republish: `h workflow publish feature` (verifyCmd/sourceRepo baked from values.local).

**Acceptance:** file a toy issue #X on the h repo; fire by hand — `h workflow run feature -p slug=issue-X -p spec=@toy.md -p createPr=true -p issueNumber=X --instance-id feature-issue-X`. Observe: worktree on `feature/issue-X` off `origin/main`, `===VERIFY=== PASS`, a PR whose body contains `Closes #X`, and GitHub showing the linked PR on the issue timeline. Merge it; the issue closes.

### Phase 2 — The sweep (registry + judgment tick, manual fires)

**Deliverables**
- `cli/charts/workflows/templates/issue-sweep.yaml` (new, ~100 lines, family-gated): steps `setup` → `run-claude` (sweep, on claude-agent, cheap-but-capable model — sonnet, not haiku). The prompt is the fail-closed checklist: **0** tool preflight (github/dapr/workflows/obs — any missing → `===SWEEP REPORT=== TOOLS UNAVAILABLE`, stop) + `state_get h-auto:config`, missing or `enabled !== true` → stop; **R** reconcile in-flight entries via `get_workflow_status` (+ obs `run_get` for markers), stamp registry/labels/comments, terminate RUNNING past `runBudgetMs`, heal UNKNOWN (mark-then-fire crash) back to pending, sum `costUsd` into the day ledger; **B** budget gate; **C** concurrency gate (any in-flight → stop); **D** discover oldest eligible `agent-approved` issue, skipping done/abandoned/at-cap/bot-authored (only now read the body); **S** compose fenced spec + preface; **M** mark registry in-flight + label, **F** curl the coder's `POST /workflow` (non-202 → revert to pending); **Z** `===SWEEP REPORT===`. `dryRun` value stops after D/S.
- `cli/charts/workflows/values.yaml`: `issueSweep:` block — `repo`, `label`, `maxAttempts: 2`, `maxInFlight: 1`, `coderWorkflowUrl`, `models.sweep`, `dryRun`; org-real values in `values.local.yaml`.
- Registry convention (documented in the chart header + CLAUDE.md keyspace list): `h-auto:config`, `h-auto:issues-index`, `h-auto:issue:<n>` `{status: pending|in-flight|done|failed|abandoned, attempts, instanceId, startedAt, prUrl?, lastError?, updatedAt}`, `h-auto:ledger:<yyyy-mm-dd>` `{runsFired, costUsd}`.
- Golden for the new family.
- Seed `h-auto:config` via dapr-mcp `state_save`: `{enabled: true, maxAttemptsPerIssue: 2, maxRunsPerDay: 3, dailyBudgetUsd: <small>, runBudgetMs: 2400000}`.
- In this phase the sweep dispatches to **claude-agent's** own `POST /workflow` (the babysitter exists on every agent service) — the coder split lands in phase 3.

**Acceptance:** label one toy issue; fire `issue-sweep` manually with `dryRun` → `===SWEEP REPORT===` names the issue, registry untouched beyond what dry-run stamps, no dispatch. Fire live → 202, registry `in-flight`, label swapped, feature run proceeds to a `Closes #N` PR. Fire the sweep again **while the run is in flight** → gate C stops it. Fire again **after** completion → reconcile stamps `done` + `prUrl`, comments the PR link, and D skips the issue. That double-fire is the dedup proof.

### Phase 3 — claude-coder split, budgets armed, clock on (unattended)

**Deliverables**
- `apps/claude-agent/.mcp.coder.json` (new): `github` server only.
- `docker-compose.yml`: `claude-coder` service (same image as claude-agent; `MCP_CONFIG_SRC` → the coder json; env = coder PAT + model key only — no `LINEAR_API_KEY`/`NOTION_API_KEY`; shared workspace volume).
- `cli/scripts/run-claude-coder.sh` (new): fresh port set + `stop_stale`, per the port-allocation/idempotency gotchas; README port map updated.
- Republish `feature` with `--set agentId=claude-coder`; set `issueSweep.coderWorkflowUrl`.
- `h workflow publish --schedule/--workspace-id/--disabled` options (`cli/h/src/h_cli/commands/workflow.py` + `infrastructure/workflow_svc.py save()` — the save route already accepts them, `workflow.router.ts`; ~15 lines) or the one-curl fallback.
- Publish `issue-sweep` with `schedule: "*/30 * * * *"`, `workspaceId: h-issue-sweep`, **`disabled: true`**; enable by re-save for one supervised evening, then leave on with budget knobs at minimums.
- Runbook section in `docs/` : kill-switch order (1. re-save `issue-sweep` `disabled:true` — honored by cron and trigger paths; 2. `state_save h-auto:config {enabled:false}`; 3. remove labels on GitHub), retry semantics, the named residual risks (§4).

**Acceptance:** `h feature run <toy spec> --agent claude-coder` — inspect the worktree's merged `.mcp.json`: `github` present, `workflows`/`dapr` absent. Kill claude-coder mid-run and restart → next sweep tick's reconcile still resolves the run (poll-truth proof). Let the cron run overnight on one labeled issue: exactly one feature run fired, PR opened, registry `done`, ledger shows the cost, no second fire.

### Phase 4 — Feedback and hardening backlog (priority order)

1. **`workflow-events` finalizer** (B's design, verbatim): `apps/workflow-svc/src/presentation/http/events.router.ts` clone of `trigger.router.ts` semantics + `finalize.ts` shared with nothing yet in-repo — cuts done-latency from ≤30 min to seconds; requires B's `dispatch:<instanceId>` reverse key and the invoker status-output exposure (`dapr-workflow-invoker.ts` returning `dapr.workflow.output` — independently improves `h workflow status`).
2. **Daily cost-report family**: sums `run:` mirrors, comments/publishes a digest.
3. **Family drift-check family**: diff `get_workflow(feature)` against a fresh publish render; alert on live-control-plane tampering.
4. **Worktree GC family**: weekly prune of worktrees whose `feature/issue-*` branch has a merged/closed PR.
5. **Deterministic sweep promotion** (B's activity + `IIssueBoard` port) — only if the agent sweep misbehaves (see open question Q6).
6. **k8s cron leader guard** — prerequisite to ever deploying the loop to k8s.
7. Runner-side terminate listener so budget-terminate actually kills the `claude` subprocess.

---

## 4. Guardrail set for unattended operation

| Guardrail | Implementing mechanism |
|---|---|
| Only maintainer-read text reaches an agent | `agent-approved` label; GitHub restricts labeling to triage+ collaborators (structural, not prose) |
| Prompt injection ≤ "a bad PR a human reviews" | `claude-coder`: `github`-MCP-only via `MCP_CONFIG_SRC` → `.mcp.coder.json`; minimal env; no `workflows`/`dapr` tools → no `save_workflow`/`terminate_workflow`/`state_save`/`pubsub_publish` reachable from an injected spec |
| No push to `main`, ever | Branch protection (GitHub config) — independent of any prompt |
| No self-filing / issue tampering by the coder | Coder PAT: `issues:read` only; sweep skips bot-authored issues; label gate catches unlabeled bot issues anyway |
| Token blast radius | Two fine-grained h-repo-only PATs (D8); git-core in-process token injection + one-shot push URL keep it out of configs/logs (push rule is prose; clone/fetch is enforced) |
| Code merge gate | Human PR review; `Closes #N` links every PR to its provenance; harness-touching diffs (`cli/charts/`, `apps/workflow-svc/`, `packages/js/agent-server|agent-cli/`, `skills/`, `dapr/`) get a path-based `actions/labeler` `touches-harness` label + policy: never merge same-sitting |
| One run in flight | Sweep gate C on the registry; belt: stable `instanceId=feature-issue-<n>` → RUNNING/PENDING reuse (`dapr-workflow-invoker.ts:99-107`); braces: git fails loudly on a branch checked out in another worktree |
| Terminal-state dedup (the purge gap) | `h-auto:issue:<n>.status ∈ {done, abandoned}` checked before every fire — the registry, not instanceIds, is the authority |
| Per-run wall clock | `policy.maxDurationMs` on the `POST /workflow` submit (babysitter terminate); tick reconcile re-enforces for restart-orphaned watches via `terminate_workflow` |
| Per-day spend | Gate B: `h-auto:ledger:<date>` (costUsd from `run:` mirrors, runsFired) vs `h-auto:config` caps, fail-closed; plus LiteLLM-proxy budget (outside h) |
| Retry containment | `attempts` in the registry, cap 2 → `abandoned` + `agent-needs-human` + comment carrying the instanceId; human re-arms with `agent-retry`; retries are cheap (`workspaceId` reuse + persisted plan) |
| Silent tool degradation | Sweep step 0: explicit `TOOLS UNAVAILABLE` + stop (MCP-down otherwise silently drops tools — known failure mode) |
| Kill switch (layered) | (1) `disabled: true` on the saved `issue-sweep` — honored by cron and trigger paths; (2) `h-auto:config.enabled=false`; (3) strip labels on GitHub |
| No PR for failing changes | PASS-gated epilogue + `===VERIFY===` marker (prose enforced by the verify step; verifyCmd baked at publish, pure build+unit only) |
| Crash-safe state transitions | Mark-before-fire + reconcile's UNKNOWN branch reverts to pending; `isDue` stamp-forward prevents catch-up storms |
| Forensics per run | Run ledger + Zipkin joined on `feature-issue-<n>`; failure comments carry the instanceId for `analyze-workflow-run` |
| **Accepted residuals (named)** | Budget-terminate does not kill the in-flight `claude` subprocess; no hard in-h token cap; sweep-overlap safety is convention + instanceId reuse, not a lock; local/compose only (k8s cron double-fire); worktree accumulation until the GC family ships |

---

## 5. Open questions only a human can decide

1. **Which issue board, initially?** The real public h repo means anyone on the internet authors candidate text behind one maintainer click; a private mirror/fork for the first weeks trades reach for a calmer trust boundary. (The design is identical either way.)
2. **Bot identity.** Personal PAT vs a dedicated machine user. A machine user makes the bot-author skip reliable, keeps PR authorship honest, and — critically — lets you *approve* the PRs (GitHub forbids approving your own). Recommend a machine user; needs a human to create it and grant repo access.
3. **Budget numbers.** `dailyBudgetUsd`, `maxRunsPerDay`, `runBudgetMs` (~40 min?), sweep cadence, and the LiteLLM proxy ceiling. Pick the starting minimums.
4. **verifyCmd scope for h itself.** Full `bun run build && bun run test` per run is real money and time on every attempt; per-package scoping is cheaper but weaker. Are Python (`uv run pytest`) suites in scope?
5. **Failure noise policy.** Are attempt/failure comments acceptable on a public issue tracker, or should failures write back only to `agent-needs-human` + the registry?
6. **Promotion criterion for the sweep (D1).** Define now what flakiness means — e.g. "two ticks in a month where the `===SWEEP REPORT===` doesn't match registry reality" — so the move to B's deterministic activity is a tripwire, not a debate.
7. **`touches-harness` merge policy.** The never-merge-same-sitting rule for PRs touching the loop's own machinery is team policy, not code — someone has to own enforcing it.

---

## Decisions (2026-07-05)

1. **Purge is now opt-in (`fresh`), attach is the default.** The invoker no longer purges a
   terminal instance on instanceId reuse; it returns it as-is. `fresh: true` (CLI `--fresh`,
   MCP param, `/workflow/run*` body field, babysitter submit field) restores purge-and-rerun
   for deliberate re-tests. Consequences for this plan: agreement #3 weakens from "instanceIds
   cannot dedup" to "instanceIds are now a real dedup belt" — the registry stays the authority
   for done/abandoned *semantics*, but a stable `feature-issue-<n>` id now structurally cannot
   double-run. **The sweep's retry branch must fire with `fresh: true`** when re-dispatching a
   FAILED issue (attempt 2), otherwise it attaches to the failed instance and no-ops.
2. **Git auth becomes a strategy, SSH first.** `git-core` grows a `GitAuthStrategy` port —
   `pat` (today's in-process token URL injection), `ssh` (remote left/rewritten to
   `git@github.com:`, `GIT_SSH_COMMAND` pointing at a mounted key, no URL mutation), and later
   `github-app` (mint an installation token per operation, then the pat path). The strategy is
   *named* in workflow/step config (`auth: ssh`) and threaded through `/clone` / `/worktree`;
   secrets stay env/mounts, never in definitions. The feature chart's PR-epilogue push prose
   becomes strategy-aware (`token URL` vs plain `git push origin`). Transport ≠ API: SSH covers
   git push/fetch only — PR creation still uses the GitHub MCP with the owner's PAT, so PRs are
   authored as the owner, who (with bypass rules) approves them. That is the accepted starting
   posture on owner-controlled repos; the two-PAT split from ruling D8 becomes the posture when
   the loop graduates beyond them.
3. **No per-PR cron registration.** One standing `issue-sweep` cron; PR lifecycle is registry
   *data*, not registered/deregistered workflows. "Deregistration" is the registry row hitting
   `done` (merge auto-closes the issue via `Closes #N`, so it also leaves the label query).
   Merge detection is the sweep's poll. GitHub webhooks are explicitly OUT of scope: the
   stack runs locally with no inbound reachability, so all GitHub state (merges, review
   comments, labels) is discovered by polling on the sweep tick. The only phase-4 latency
   optimization is the internal `workflow-events` finalizer (Dapr pub/sub, outbound-only). **Review-comment resolution** joins the reconcile contract as new
   scope: an open agent PR with unaddressed human review comments → the sweep fires a `revise`
   run (same branch/worktree, `fresh: true`, comments as the spec addendum) under the same
   attempt cap.

## Progress log

- 2026-07-05 — **revise flow shipped and live-proven on PR #2.** New sweep step V. REVISE
  (between C and D): open agent PRs with a merge conflict or changes-requested/new human
  review comments get a revise run — same branch/worktree, fresh: true, push updates the
  PR, harness artifacts resolve to main's side and are removed — before any new issue is
  discovered. sweep-live-6 caught PR #2 dirty, dispatched the revise; the run merged main,
  stripped .mcp.json + plan-*.md from the PR, verified PASS, and PR #2 is now
  mergeable:clean with a CONTRIBUTING.md-only diff. sweep-live-7 reconciled it and the
  LEDGER GAP branch fired correctly (no silent zero) — root cause: obs runs_list has no
  instanceId filter (filed #10; sweep prose now prefix-matches runIds meanwhile).

- 2026-07-05 — **live sweep acceptance PASSED, full gate coverage.** Five manual ticks:
  sweep-live-1 dispatched #3 (oldest eligible, mark-before-fire); sweep-live-2 stopped at
  gate C mid-run (double-fire dedup proof); sweep-live-3 reconciled #3 done + commented
  PR #6 + advanced to #4; sweep-live-4 reconciled #4 (cost summed into the ledger after a
  prose sharpening — the original "when present" wording silently added $0) + advanced to
  #5; sweep-live-5 stopped at gate B (3/3 runs, $1.79/$5). Three autonomous PRs: #6
  (MCP_CONFIG_MODE=replace — the loop fixed its own security hole), #8 (internal-gRPC
  ports → 610xx), #9 (fleet supervision + NR busy_timeout). Selective-commit epilogue
  verified live (clean diffs, .mcp.json restored). New issue #7 (hardcoded ledger agentId
  misattributes claude-coder runs). Known nick: #3's ~$1.36 predates the prose fix and is
  missing from the day ledger (one-time undercount). Next: human review/merge of PRs
  #6/#8/#9, then arm the cron (--schedule "*/30 * * * *" --disabled first).

- 2026-07-05 — **sweep dry-run PASSED** (instance sweep-dry-1): all gates executed in
  order — 4-MCP preflight, config gate, empty reconcile/budget/concurrency, discovered
  labeled issue #1, composed the fenced spec, stopped before MARK with a full
  ===SWEEP REPORT===. Loop labels created on stiproot/h; h-auto:config seeded. New
  `h-issues` skill (skills/h-issues) — used to file the first two dogfood issues (#3
  MCP_CONFIG_MODE, #4 ephemeral-port pins). Next rung: live sweep + double-fire dedup
  proof (after PR #2 is resolved).

- 2026-07-05 — **e2e PASSED** (issue stiproot/h#1 → PR stiproot/h#2, 12 min): worktree off
  origin/main via ssh, plan → implement → verify PASS (191 tests) → ssh push → PR with
  Closes #1. Two findings: (1) FIXED — the epilogue's "commit all changes" shipped the
  runner's .mcp.json merge + plan-feature-<slug>.md in the PR; now commits selectively.
  (2) OPEN — the stripped-coder guarantee has a hole when the target repo is h itself: the
  worktree's own .mcp.json ships dapr/workflows/obs and mergeMcpConfig deliberately
  preserves cwd servers, so the coder regained control-plane tools (observed: implement
  used actor_state_set). Candidate fix: an MCP_CONFIG_MODE=replace knob on the runner for
  claude-coder, so its github-only config REPLACES instead of merges.

- 2026-07-05 — design synthesized and committed; no implementation yet.
- 2026-07-05 — `fresh` flag shipped (attach-by-default invoker, flag threaded through
  workflow-svc routes, both babysitters, workflow-mcp tools, `h workflow run --fresh`,
  `h feature run --fresh`). Decisions 1-3 above recorded; auth-strategy port and
  comment-resolution not yet implemented.
- 2026-07-05 — GitHub webhooks ruled out (local deployment, no inbound reachability);
  GitHub state is poll-discovered on the sweep tick.
- 2026-07-05 — implementation: phase 1 (feature issueNumber param + Closes #N), GitAuth
  strategy (pat|ssh in git-core, threaded through /clone + /worktree + chart gitAuth,
  ssh-aware push prose), phase 2 (issue-sweep family + h-auto registry convention), phase 3
  scaffolding (h workflow publish --schedule/--workspace-id/--disabled; claude-coder compose
  service + run script + .mcp.coder.json). Runbook: docs/h-builds-h-runbook.md. Outstanding:
  phase-0 GitHub config (human), publish/seed/arm (stack), review-comment resolution in the
  sweep prompt, phase-4 backlog.
