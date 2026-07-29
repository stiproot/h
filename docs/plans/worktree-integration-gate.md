# Worktree integration gate — a machine-executed integration test on every h feature worktree

Status: Active — plan reviewed by a 4-agent panel 2026-07-29 (verdict: sound-with-changes); blockers folded in; implementing Phases 1–2
Established: 2026-07-29

## Problem

h's ways of working have no integration test — anywhere. "The tests pass" for an h PR means
lint + build + unit only (`.github/workflows/guards.yml` runs exactly the local entrypoints;
60 vitest specs + 31 pytest files, all unit). Nothing automated ever proves the stack *runs*.

The verify gate that exists is **prose, not a machine**: `verify.tmpl.yaml` overlays acceptance
instructions onto the `implement` step and the agent *self-reports* `verify: PASS|FAIL` in its
structured output. Nothing executes a command and reads an exit code. The archived
local-ci-execution plan names the consequence precisely: PR #98 passed FOUR review rounds and
eighteen findings while `bun run lint` was failing on three separate oxfmt violations — *"an
executed gate turns the build result into an objective input the review can read, instead of a
claim it must trust."* An integration failure (workflow-svc won't start, the cron tick scan
throws, a statestore key regression) is invisible to every gate we have.

The rule this plan enforces: **an h feature worktree must pass a machine-executed integration
test — the stack built from that worktree, actually running.** Not prose the agent may skip;
a workflow step whose activity fails on a nonzero exit. NOTE: the overlay merges by step id,
so in the composed implement-pr order the gate runs after the PR is already open (it is a
post-PR quality signal surfaced on the open PR, not a pre-PR block).

## Why k8s (the creative part)

The integration environment cannot be the running stack: the host/compose stack is a singleton
(pinned ports, one shared workspace, one etcd) and it is the very orchestrator driving the
feature run — you can't restart it with the worktree's code mid-run. Compose-project isolation
was considered and rejected: the port map is pinned repo-wide (`cli/scripts/run-*.sh`,
`check-ports.mjs`), a second project fights the first for host ports, and teardown is leaky
(`down -v` misses the etcd bind mount — a documented gotcha).

Kubernetes namespaces give exactly the isolation shape we need, from machinery we already have
(k3d + registry `h-registry:5111` on Linux, Dapr control plane in `dapr-system`):

- **One ephemeral namespace per gate run** — `h-itest-<runId>`: its own redis, its own Dapr
  components (components are namespace-scoped), its own workflow-svc + stub agent built *from
  the worktree*. No port collisions with anything.
- **Teardown is one call** — `kubectl delete namespace` reaps everything (trap on exit, plus a
  TTL sweeper for the paths a trap can't cover — see Failure containment).
- **The shared Dapr control plane** (sidecar injector, placement, scheduler in `dapr-system`)
  serves every namespace — the per-run cost is only the app pods + sidecars.
- The §18 carried-followup ("k8s cron leader guard — the loop is deliberately local/compose
  only") is *not* violated: the itest namespace runs a single workflow-svc replica whose cron
  binding is namespace-scoped, and the namespace lives minutes. The production loop stays
  local/compose; k8s is used here as an **isolation substrate for testing**, not as the loop's
  runtime.

Honest concurrency note (panel): namespace isolation covers k8s objects, not the shared docker
daemon, registry, or single-node k3d CPU/RAM. v1 documents **one gate run at a time** — the
h-builds-h loop is a singleton anyway, so this costs nothing today. A cluster-wide lease is the
follow-up if parallel feature runs ever exist.

## Design

Three pieces: the test (what runs), the gate (what enforces), the encoding (what makes the rule
permanent). Slice deliberately minimal — this is not k8s parity for 14 services.

### A. The integration test — `make itest` (runnable by hand, by the gate, and by CI)

`scripts/itest/run-itest.sh <worktree-path>` (default: repo root):

1. **Build** the minimal image set from the worktree — `workflow-svc` and the new `stub-agent`
  — and push to the k3d registry, tagged by content (git SHA + dirty-hash) so an unchanged
  worktree reuses the layer cache and the warm path is fast.
2. **Deploy** an ephemeral namespace `h-itest-<id>` via a kustomize overlay generated per run
  under the run's evidence dir: base = a manifests subset (redis, statestore, pubsub,
  appconfig, resiliency, workflow-cron, workflow-svc, stub-agent), transformers set the
  namespace and image tags **without editing the existing base manifests**. Two Dapr-specific
  patches the namespace transformer does NOT do for us (panel M7 + minor): the sidecar
  annotations must be present on every pod spec, and Dapr component `spec.scopes` must still
  match the deployed app-ids; Phase 1's acceptance explicitly verifies sidecar injection in
  the ephemeral namespace. The overlay also patches the workflow-cron binding cadence to ~5s
  so tick-dependent assertions are deterministic, not a 60–90s wait (panel B2).
3. **Smoke** — the integration assertions, exercising the runtime spine **end-to-end through a
  real agent dispatch, with no LLM and no secrets** (panel M2: spine-only is an infra check,
  not an integration test):
   - `POST /workflow/run` a checked-in smoke workflow whose agent step runs the **stub agent**:
     a tiny `stub-agent` app built on `packages/js/agent-server` with a deterministic
     `IAgentRunner` that echoes a canned structured output — so the smoke crosses the real
     seams: activity → Dapr invoke → agent-server `/run` route → runner → run ledger →
     rung-2 structured-output validation (`outputContract` on the step; the stub's canned
     fenced json block must validate);
   - assert the instance reaches COMPLETED (Dapr workflow + actor runtime + statestore up);
   - assert the `wf:` row lands `done` with the structured `goal` handshake validated;
   - assert the watch row finalizes on the (5s) cron tick (watcher engine + cron binding live).
4. **Teardown** the namespace unconditionally; before deleting, dump pod logs + `kubectl
  describe` to the evidence dir (namespace deletion destroys pod logs — evidence must outlive
  the namespace).

The stub-agent's contract (schema, params, canned output) is specified in Phase 1 before the
smoke workflow is written — the smoke cannot be authored against an unspecified contract.

Explicitly NOT covered by v1 (so "integration test" doesn't overclaim): the chain engine's
stage progression, the MCP servers, real agent services, macOS. Linux-first: the dev box (the
loop's actual host) runs k3d; `k3d image import` is the documented portability route if a
macOS path is ever needed.

### B. The gate — a machine-executed workflow step (post-PR quality signal)

- **New activity `run-itest`** in workflow-svc (specific-first per panel D5 verdict; the
  general execute-anything `run-gate` is deferred until a second consumer exists — and a
  general "run any command" activity is also the command-injection surface the panel flagged,
  M6). The activity:
  - **materializes the harness from the trusted base ref, not the worktree** (panel B1: the
    worktree's own `scripts/itest/*` / Makefile are agent-editable — `git -C <worktree> show
    origin/main:scripts/itest/run-itest.sh` into a temp dir and execute THAT against the
    worktree path; a PR that changes the harness legitimately gets tested by the NEXT run,
    the same merge-result rule CI already follows);
  - hard-codes what it executes (no fire-time or values-injectable command);
  - enforces a **hard timeout (~20 min)** and classifies failure as `infra` vs `assertion`
    from the harness's exit-code taxonomy (panel B2: the harness exits distinctly for
    build/deploy/cluster failures vs smoke-assertion failures); retries ONCE on `infra`,
    never on `assertion`;
  - records the worktree **tree hash** in the evidence so create-pr can assert the pushed
    HEAD matches what was tested (panel minor: tested tree ≠ pushed tree);
  - returns `{passed, class, exitCode, treeHash, durationMs, outputTail}` — a machine fact.
    Nonzero/timeout ⇒ the activity fails ⇒ the step fails ⇒ **the workflow fails structurally**.
    NOTE: the overlay merges by step id — create-pr's step carries id `implement` and folds
    into the implement step at compose time, while the `itest` step id appends afterwards.
    The composed order is therefore: …implement(+PR epilogue) → itest. The gate runs AFTER the
    PR is already open and surfaces the machine result on the already-open PR. This is the
    accepted design (a post-PR quality gate, not a pre-PR block).
- **New overlay template `run-itest.tmpl.yaml`** (`role: overlay`, the `arm-revise-pr`
  precedent: appends a *new* step, id `itest`) with cwd `{{worktree.worktreePath}}`.
- **Recompose the h feature key**:
  `h template compose implement verify run-itest create-pr arm-revise-pr --save implement-pr`.
  The verify prose overlay stays: prose catches what it catches; the machine step is the floor.
  Cutover order (panel minor): the workflow-svc carrying `run-itest` deploys BEFORE the
  recomposed key is saved.
- **Break-glass (panel B3)** — h-builds-h is how h fixes itself, so a wedged k3d/registry must
  not deadlock all feature work: a template-values-only `itest.skip: true` runs the step as a
  no-op that writes `SKIPPED + reason` into the evidence and the PR body — surfacing the
  bypass, never hiding it; a skipped gate is a mandatory review-pr finding. Documented runbook
  escape included.
- **Evidence threads forward**: create-pr's task embeds `{{itest.output}}` so the PR body
  carries the machine result (pass/skip, class, tree hash, duration); gate outcomes also land
  in the run ledger keyed by `workflowInstanceId` (the obs join key) and persist under
  `.local-logs/itest/<runId>/` — outside both the namespace and worktree GC scopes.

Runtime model, explicit (panel M8): the gate shells out to docker + kubectl, so gate-enabled
feature runs require **host-mode workflow-svc** (the loop's actual mode per §18). Compose-mode
workflow-svc has no docker/kubectl; containerizing the gate is an explicit follow-up, not v1.

Scope: the gate applies to **h's own feature runs**. Target-repo runs (trxy etc.) keep their
own verify conventions.

### C. The encoding — close the bypass holes (panel B1b/M1, mechanism committed)

The panel unanimously held that prose enforcement is insufficient, and split three ways on the
mechanism (registration-time CLI refusal / registry-evidence read by review / required CI).
**Committed choice: the merge-result backstop + evidence-reading review — not CLI coupling.**
Registration-time refusal couples `h chain run` to a repo-specific composition rule (the wrong
layer — the CLI composes workflows for any repo). Instead, omission of the overlay is made
*futile* rather than *refused*:

1. **CI `itest` job in `guards.yml`** (self-hosted-runner only; `if: RUNNER_LABEL`-gated so
  GitHub-hosted fallback skips loudly) runs the SAME `make itest` on the merge result. Lands
  non-required in the same change; flips to required in the same change that enables branch
  protection (carried-followups local-ci §16) — the two are linked so "non-required" cannot
  quietly become permanent. A run that skips the overlay still faces the same test at merge.
2. **review-pr prose**: missing or `SKIPPED` machine itest evidence on an h code-touching PR
  is a FINDING (upgrade of the existing test-evidence clause from self-reported to
  machine-fact-required).
3. **Content guard lockstep**: the template guards verify `run-itest.tmpl.yaml`'s gate/role
  invariants and that the runbook's documented compose command includes `run-itest`.
4. **Docs**: ARCHITECTURE.md (gate joins the composition-stack narrative), CLAUDE.md index,
  `docs/h-builds-h-runbook.md` compose command, cookbook entry stamped after the first
  validated run.

### Failure containment (panel B2/B3/M3/M4/M5 consolidated)

- **Namespace GC**: trap-on-exit PLUS a sweeper — `make itest-gc` deletes `h-itest-*`
  namespaces older than N hours (trap doesn't survive SIGKILL/host restart); wired as a
  Phase 1 deliverable and callable from the gate's preamble, with a manual runbook note.
- **Image/registry GC**: content-tagged images accumulate (~hundreds of MB per distinct
  tree) — the harness prunes gate-built images older than 7 days / keeps last N, best-effort
  in teardown plus the same `itest-gc` entrypoint.
- **Concurrency**: one gate run at a time (documented; the loop is a singleton). No lease in
  v1.
- **Flake telemetry**: every gate run's `{passed, class, durationMs}` lands in the run ledger
  + evidence dir; an `infra`-class failure rate visibly above ~zero is the signal to fix the
  harness, and durations set the timeout/`maxDurationMs` budgets from data instead of guesses.
- **Loop economics, acknowledged**: the gate adds ~2–8 min (warm–cold) to every h feature run;
  `implement-pr`-composed runs get a watch `maxDurationMs` bump in the same change.

## Decisions (as amended by the 2026-07-29 panel review)

- **D1 — k8s namespaces as the isolation substrate** — approved; scope boundary added: reuse
  existing manifests as an untouched kustomize base; the parameterization is transformer-side.
- **D2 — smoke slice = runtime spine + stub-agent dispatch** — amended (was spine-only): all
  four panelists held spine-only is an infra check; the stub agent (agent-server + canned
  runner, no LLM/secrets) makes the invoke→run-ledger→structured-validation path part of the
  assertion. Full-stack parity remains out of scope.
- **D3 — kustomize for the ephemeral render** — approved; plus explicit sidecar-annotation and
  `spec.scopes` handling (M7).
- **D4 — the gate is a workflow step failing structurally** — approved; plus the B2 taxonomy
  (timeout, infra-vs-assertion, retry-once-on-infra); retry-once is in the activity itself
  (not caller's responsibility as the Phase 2 note originally said — corrected).
- **D5 — specific-first: `run-itest` activity, not a general `run-gate`** — reversed from the
  base plan (was general-first) on the panel's argument: one consumer today, and a general
  execute-command activity is itself the M6 injection surface. Generalize on the second
  proven consumer.
- **D6 — host/local mode first** — approved; runtime model now explicit (host-mode
  workflow-svc required for gate-enabled runs).
- **D7 (new) — harness runs from the base ref** — the gate executes the merge-base's harness
  against the worktree, so the worktree cannot neuter its own gate (B1).
- **D8 (new) — enforcement = merge-backstop + evidence-reading review, not CLI refusal** —
  the committed resolution of the panel's one unresolved architectural disagreement (see C).

## Phases

- **Phase 0 — plan review.** DONE 2026-07-29: panelized `answer` run `plan-review-itest-gate`
  (roster claude/openhands/pi/kimi, pinned claude judge; every panelist + judge completed).
  Verdict sound-with-changes; 3 blockers + 8 majors folded in above.
- **Phase 1 — the test.** IMPLEMENTED 2026-07-29 (PR feature/itest-gate).
  - *1a — substrate*: `k8s/itest/base/` kustomize base (redis, statestore, pubsub, appconfig,
    resiliency, workflow-cron, workflow-svc, stub-agent); resiliency patch adds stub-agent target;
    per-run overlay generated by the harness to `$EVIDENCE_DIR/overlay/` (namespace + image tags +
    cron-5s patch) without editing the base manifests.
  - *1b — smoke*: `apps/stub-agent/` (TypeScript, agent-server, deterministic IAgentRunner,
    canned output `{"goal":"RESOLVED","status":"smoke-passed"}`); `scripts/itest/smoke-workflow.json`
    (wf identity, 120s watch, run-stub step + outputContract); `scripts/itest/run-itest.sh`
    (exit-code taxonomy 0/10/11, content-tag build, evidence capture, trap teardown, wf-row +
    watch-row assertions); `make itest` target.
  - *1c — failure honesty*: exit 10 on wf-row assertion failure; `make itest-gc` sweeper;
    evidence to `.local-logs/itest/<id>/` before namespace deletion.
- **Phase 2 — the gate.** IMPLEMENTED 2026-07-29 (PR feature/itest-gate).
  `run-stub` activity (mirrors run-kimi, calls stub-agent Dapr service);
  `run-itest` activity (materialises harness + smoke def from origin/main, 20 min hard timeout
  per attempt, taxonomy, tree hash, retry-once on infra implemented in the activity); unit tests;
  activity-registry entries; `run-itest.tmpl.yaml` overlay + template gate + goldens;
  `itest.skip` break-glass; recompose `implement-pr` is an operator cutover step AFTER
  workflow-svc carrying run-itest is deployed (out of scope for this PR).
- **Phase 3 — the encoding.** CI `itest` job (non-required, linked to branch-protection flip);
  review-pr prose upgrade; content-guard lockstep; ARCHITECTURE/CLAUDE/runbook/cookbook.
- **Phase 4 — e2e validation.** One real h-builds-h feature run through the gate, including a
  deliberately broken intermediate commit proving create-pr is blocked with `assertion` class;
  cookbook entry stamped; then archive per plan-management (lift → `impl/`).

## Validation plan (the full run this feature ships through)

Base plan (this doc) → plan review DONE (panelized `answer`, roster claude/openhands/pi/kimi —
every agent except codex) → implement (`implement-pr` composed key, scope: Phases 1–2) → PR
review by the same roster panelizing `review-pr` (executor freeze relaxes to the named roster,
pin migrates to the judge) → `revise-pr` under loop-until-clean. Phase 3–4 land as follow-up
runs once the gate exists.

## Implementation findings (2026-07-29, Phases 1–2)

- **stub-agent contract**: params `{task, workflowInstanceId?, workspaceId?, outputContract?}`;
  canned output ends with fenced json `{"goal":"RESOLVED","status":"smoke-passed"}` satisfying the
  smoke's outputContract. No LLM, no secrets, zero latency.
- **executorFromActivity behaviour**: `executorFromActivity("run-stub")` → `"stub"`,
  `executorFromActivity("run-itest")` → `"itest"`. Both pass the exec-policy gate by default
  (no entry in `exec:config`). The gate is structurally applied via the `gatedExecutor` pattern.
- **hostPath removal**: `k8s/apps/workflow-svc.yaml` stale macOS hostPath removed (sanctioned by plan).
- **stub-agent NOT in `_services.sh`/zellij layouts**: itest-only, not a persistent h service.
- **itest.skip break-glass**: template values `itest.skip: true` / `itest.skipReason` render the
  step as a no-op emitting `{skip: true, skipReason: ...}` — no subprocess, no filesystem access.
- **recompose `implement-pr` is deferred**: operator cutover (`h template compose implement verify
  run-itest create-pr arm-revise-pr --save implement-pr`) happens AFTER workflow-svc with the
  `run-itest` activity is deployed — out of scope for this PR.
- **watch-budget bump**: deferred with the recompose step (both go together).

## Review trail

- 2026-07-29 — panel run `plan-review-itest-gate` (workflow COMPLETED; 4 panelists + judge).
  Blockers: B1 self-tamper/omission (→ D7, D8), B2 no timeout/taxonomy/retry (→ D4 amendment,
  5s cron patch), B3 no break-glass (→ `itest.skip`). Majors M1–M8 folded as marked. Genuine
  divergences recorded: verdict label (pi: rethink; others: sound-with-changes — same findings,
  different bar), enforcement mechanism (settled by D8), macOS-now vs Linux-first (settled:
  Linux-first, documented).

## Related / carried context

- `docs/plans/impl/local-ci-execution.md` — the executed-gate argument and PR #98 evidence.
- `docs/plans/carried-followups.md` §18 (k8s cron leader guard — respected, not solved, by the
  single-replica ephemeral namespace), §16 (worktree GC — itest namespaces self-reap via
  trap + sweeper; images via `itest-gc`), §11 (review-pr worktree — unchanged; review reads
  evidence, doesn't execute), local-ci §16 (branch protection — the itest CI job becomes its
  second required check when it flips on).
- Known k8s debt this plan touches but does not own: stale `workflow-svc.yaml` hostPath,
  orphaned `codex-agent.yaml` (wrong secret name, missing PVC), CLAUDE.md k8s layout staleness.
  Fix what the kustomize base forces; file the rest as issues.
