# Panels as a modifier: the `--agent` roster

Status: DONE — v1 + agent-panel retirement + e2e validated 2026-07-24 (PR #64); follow-ups listed
Established: 2026-07-23 · Designed: 2026-07-24 · Built: 2026-07-24 · Validated: 2026-07-24

## The idea

Today a multi-agent panel is its OWN thing: the `agent-panel` chart template + the `agent-panel`
chain kind — a distinct workflow you compose as a member. That makes "run something as a panel" a
special workflow rather than a capability.

**Flip it: a panel is a per-member CARDINALITY, not a flag.** `--agent` already answers *who
executes*; a panel is that answer being plural. No new flag, no second identity axis:

```sh
h chain run --slug auth-hardening -p spec=@spec.md -p repo=stiproot/h \
  -t feature verify create-pr --agent codex --inline \
  -w pr-review --agent claude codex openhands \
  -t revise --agent codex --inline \
  --strategy loop-until-clean --max-iterations 3
```

One token of difference from a single-reviewer chain. The space-delimited roster conforms to the
expression grammar's existing idiom — greedy operand consumption until the next dash token, exactly
like `-t feature verify create-pr`.

## The structural fact that decides the design

h already has two fan-out substrates with different physics:

| | In-workflow parallel group | Chain parallel stage |
|---|---|---|
| What fans out | N **agent steps** in ONE workflow (`generic.workflow.ts` whenAll) | N **whole workflows** in one stage |
| Workspace | **Shared** — all branches see the same worktree | **Isolated** — per-member instance/worktree |
| Provisioning | Once (setup/clone/worktree in the shared prefix steps) | N times |
| Output seam | One workflow, one structured output → chain contract unchanged | N outputs on the namespaced blackboard (D5) |
| Exists today as | `agent-panel`'s hand-written template | `--parallel` / `--stage N` |

So: **read/judge work (review, plan) panelizes in-workflow** — panelists share the checkout,
nobody writes, and the synthesis emits the workflow's normal contract so everything downstream
(loop-until-clean, captures, the watcher) is blind to the panel. **Write work (implement, revise)
cannot share a worktree** — a roster on a write kind is rejected loud, with a pointer to
`--parallel` stage composition, which already expresses "N implementations" with per-member
isolation. A later sugar may compress that; it is not v1.

## Locked decisions

1. **Roster = plural `--agent`.** Space-delimited in the chain expression (hand-parsed, so no
   click limitation); the standalone `h workflow run` surface uses the repeated flag
   (`--agent claude --agent codex`) because `--agent` is Typer-declared there and click can't do
   open-ended space-delimited option values. Each surface conforms to its host grammar; semantics
   and the panelize path are shared.
2. **Roster-only, no `--panel N`.** Identity diversity is what h can guarantee; same-agent×N with
   assigned perspectives (risk-first / user-first / …) is a later prompt-engineering slice.
3. **The transform is pure and CLI-side** (`panelize.py`, sibling of `overlay.py`): the engine
   needs NOTHING new — the parallel step group and the one-declarer contract convention already
   exist. `panelize(steps, outputs, roster, judge) -> steps'`:
   - locate the panel step = the step carrying `outputContract` (the contract-carrying step IS the
     workflow's voice — the same convention the one-declarer composition rule established);
   - replicate it into a `parallel:` group, one branch per roster agent
     (`activity: run-<agent>` from `AGENT_IDENTITY`), contract STRIPPED from branches (they answer
     in prose), branch id = agent name, concurrency preamble prepended (see Sync steering);
   - append a `synthesize` step carrying the ORIGINAL `outputContract`, task = generic panel
     prose + the template's optional `panelSynthesis` guidance + the branch outputs via the
     existing `{{<agent>.output}}` tokens.
4. **A roster forces compose-on-fire.** A restructured member can't fire a stored definition
   verbatim: a `-t` roster member panelizes after `compose_templates`; a `-w` roster member
   fetches its stored steps first, then panelizes — inline or republished under `<slug>-wN`, the
   same mechanics `-t` already has.
5. **Synthesis is declared by the workflow, optionally.** The join differs by workflow (review:
   "CLEAN only if all say CLEAN, else merge the blockers"; plan: "merge the best of N designs") —
   so a template MAY carry a `panelSynthesis:` prose block beside `outputs:`; `panelize` splices
   it into the synthesis task, falling back to generic compare-and-merge prose. The join SHAPE is
   already the declared `outputs` schema either way. "How to synthesize a panel of me" lives with
   the workflow, not the panel site — matching how `outputs:` works. (Q1, answered.)
6. **The seams hold untouched:**
   - *loop-until-clean* — synthesis emits the same verdict contract at the same seam; the chain
     engine's `until verdict=CLEAN` and the `pr-review` kind contract are unchanged. The panel is
     invisible below the verdict. (Q2.)
   - *watcher/cost* — still ONE instance; the cost tally already sums `run:` mirrors per
     instance, so N runs land in one tally naturally. (Q5.)
   - *comments* — each panelist posts its own PR review, prefixed `[panel:<agent>]` for
     attribution (one GH_TOKEN, so attribution is prose); synthesis posts nothing — it only
     aggregates verdicts. (Q4.)
7. **The executor pin migrates to the judge.** Single-agent `--agent` on `pr-review` still
   warns-and-keeps (`FROZEN_EXECUTOR_KINDS`); a roster is the explicit relaxation — allowed, and
   the **synthesis judge stays pinned to claude**, which is where the trust decision now lives
   (docs/plans/reviewer-identity-security.md). (Q3.)
8. **`--model` with a roster is rejected in v1.** Per-branch models fall to each agent's
   `AGENT_MODEL`; a positional `--model m1 m2 m3` mirroring the roster is conceivable later.
9. **Cardinality changes mechanics, not semantics** — the defended line: one agent sets
   fire-time identity params on a saved definition; several restructure it into a parallel group.
   Acceptable because the semantics stay "these agents execute this member" and the restructure is
   invisible at every seam (same contract, same instance, same watcher).

## Sync steering (shared-workspace concurrency)

Panel branches share one worktree, so the transform — the SINGLE author of every branch's task
prose — injects a concurrency preamble (the `agent-panel.yaml` `$brief` pattern, generalized):

> You share this workspace with N other agents running concurrently. Treat the worktree as
> read-only: do not switch branches, install dependencies, run builds, or write files into it.
> Keep scratch reasoning in your answer, not on disk.

One place, every panelized workflow inherits it. Honest caveat: steering is advisory — a reviewer
that runs the test suite still writes `node_modules`/caches. Acceptable for v1 because review/plan
tasks are read-and-judge by construction (`verify` already ran in the implement member) and the
prose says so explicitly. Per-branch worktrees are the hard-isolation escalation if this bites —
deferred (reintroduces N× provisioning).

## v1 slice

1. DONE — `chain_expr.py`: `--agent` moved to a greedy `ROSTER_FLAGS` class (the `-t` atom loop);
   `WorkflowConfig.agent` → `agents: tuple[str, ...] = ()`; single agent stays a legal chain-wide
   default, a prefix roster is rejected. Forgotten `-w` dies loud at `AGENT_IDENTITY` validation.
2. DONE — `infrastructure/panelize.py` (pure, dependency-free): `panelize(definition, roster)` +
   `roster_pairs(roster, identity)` (identity table injected to keep the module pure). Notable
   implementation decisions beyond the design: the synthesis KEEPS the original step id (it IS
   the step — later `$ref`s resolve to the synthesized result); branch ids are the short agent
   names (`claude-agent` → `claude`, matching the agent-panel template); the quoted original task
   inside the synthesis is stripped of its rendered `===OUTPUT CONTRACT===` epilogue (one
   authoritative contract block); a same-executor-twice roster is rejected (no perspective
   assignment in v1, so duplication adds nothing). Unit-tested (`test_panelize.py`): shape,
   stripping, preamble, judge, purity, error paths.
3. DONE — `chain.py`: roster branch in `_resolve_workflow` (forces compose-on-fire; a `-w` key
   prefers its chart template render via `_panel_definition` so `panelSynthesis` flows, else the
   stored def; `WRITE_KINDS` rejected; `--model` rejected; pr-review freeze relaxed for rosters
   with the judge noted). Wire-tested (`test_chain.py`): inline roster member embeds panelized
   steps, write-kind + model rejections.
4. DONE — `workflow.py`: `--agent` repeatable; roster → `_roster_definition` + panelize + fire
   inline via `run_steps` (roster rejects `--via`/`--cron`/`--at`/`--in` — panel + recurrence/
   routing composes via `h chain run`). Wire-tested (`test_workflow_run.py`).
5. DONE — `pr-review.yaml` declares `panelSynthesis:` (unanimous-CLEAN verdict rule, merged
   findings, disputed-finding notation, no second posted review). Golden re-blessed.
6. DONE — docs/tests ripple: grammar docstrings, `chain.py`/`workflow.py` help, CLAUDE.md (chain
   bullet + CLI layout line), parser tests migrated to `agents=`, 246 h-cli tests green.
7. DONE — the prior art is retired ([[atomic-cutovers]]): `agent-panel` (template + chain kind)
   → **`answer`**, the bare panelizable task member. New `answer.yaml` (ONE contract-carrying
   step, open identity slots, contract `{answer, disagreements?}`, its own `panelSynthesis:`);
   engine kind renamed on both sides (`chain.model.ts` literal + `chain-workflows.ts`
   `captureAnswer` capturing the flat `answer`; `capturePanel`/`consensus`/`best` deleted); CLI
   tables follow (`KNOWN_KINDS`/`WELL_KNOWN`/`KIND_FIRE` prefix `answer-<slug>`/
   `KIND_MODEL_PARAMS` gains `modelAnswer` — a real model slot the old pinned-identity panel
   never had — + `MODEL_PARAM_SLOTS`); kind-sync guard green by construction, engine 309 +
   h-cli 246 tests green, old golden deleted + answer golden blessed. A panel chain member is
   now `-w answer --agent claude codex openhands` — same words as everywhere else.
8. DONE — e2e validated in CONTAINER mode, 2026-07-24, as TWO chains carrying out
   hardening-audit A9 (the template-gate guard — chosen deliberately: we had authored
   `answer.yaml` the same day, the exact "new template forgets the gate" hazard):
   - **Chain 1 `a9-template-gate-guard`** (staged, sequential; ~6 min): stage 0 ran TWO
     panels concurrently — `design` (`-w answer --agent claude codex --inline --id design`)
     and `risks` (`--agent claude openhands`) — both capturing namespaced `answer`s (D5, no
     clobber); stage 1 codex implemented from `--input spec=design.answer` → PR #64
     (+23/−4, verify PASS). Every parallelism substrate exercised: in-workflow panel groups,
     two panels in one chain stage, stage join, blackboard threading.
   - **Chain 2 `a9-review-loop`** (pure sequential, `loop-until-clean --max-iterations 3`):
     panelized `pr-review --agent claude codex` with `--input focus=risks.answer` (the risks
     panel STEERED the review) → `revise --agent codex`. Ran the full arc: iteration 1 the
     panelists DISAGREED (one found the wrap-coverage gap the risks panel had predicted, one
     said clean) and the unanimous-CLEAN `panelSynthesis` rule correctly emitted FINDINGS;
     three review×revise rounds drove the guard from a line-regex to a gate-coverage checker
     (`hasCompleteTemplateGate` + 9 unit tests), including the panel catching a false-positive
     REGRESSION its own round-2 demand had induced. Verified locally post-loop: guard passes
     all real templates, fires on gateless + typo'd-gate fixtures.
   - Split into two chains because loop-until-clean × stages is the DEFERRED reconciliation
     (chain.py `startCursor` is a member index; a staged cursor is a stage index) — the
     constraint is real at compose time.

## E2E findings (follow-ups, in priority order)

1. **Worktree lifecycle across chains** — chain 1's finalized worktree kept
   `feature/<slug>` checked out, so chain 2's revise (fresh engine-derived workspace) died at
   create-worktree (`already used by worktree`); freed manually and re-fired. A finalized
   chain leaks its worktrees; any later chain touching the same branch collides. Wants a
   lifecycle answer (cleanup on finalize, or worktree reuse by branch), not an ad-hoc rm.
2. **Final-stage captures don't land** — chain 1 finalized without writing `prNumber` to the
   blackboard (capturePr for the terminal member never ran/persisted; mid-chain captures work).
   Harmless intra-chain, but chain-to-chain handoff wants the finalized row to carry them.
3. **loop-until-clean × stages** — encountered as a real constraint; the deferred
   reconciliation (inline-chain-cron-composition open sub-question) now has a concrete
   motivating case (panel stage + review loop in ONE chain).
4. **Panelist attribution** — posted PR reviews carry no `[panel:<agent>]` prefix (design Q4
   called for it); panelize's preamble doesn't inject posting-attribution prose.
5. Cosmetics: rich markup swallows a `[label]`-shaped member label in a chain-run console
   line; `--strategy`/`--max-iterations` must precede the `--` separator (Typer options) —
   worth a hint in the ExprError for known Typer flag names.

## v1 caveats (observed while building — candidates for the e2e to confirm or dissolve)

- **Provisioning asymmetry**: pr-review's `setup` step provisions only claude-agent's workspace
  (skills). Roster branches on other agents run without provisioned skills — acceptable for
  review (the task needs only the github MCP, which every agent auto-provisions), but a
  panelized template whose task depends on skills would need a per-agent setup story.
- **Workspace sharing is agent-relative**: each panelist's run activity resolves its OWN
  workspace dir under its agent service. Branches only truly share a filesystem when the
  workflow's prefix steps put one at the shared agent-neutral worktree path — the concurrency
  preamble is written for that case and harmless otherwise.

## Relation to what exists

- Reuses the parallel-group fan-out already in `generic.workflow.ts` + the one-declarer output
  contract — a generalization of `agent-panel`, not new fan-out machinery. Zero engine change.
- docs/plans/multi-agent-panel.md — the parallel-group machinery this builds on.
- docs/plans/reviewer-identity-security.md — the executor-pin trust context (decision 7).
- docs/plans/structured-workflow-outputs.md — the contract seam the synthesis preserves.

## Open questions (deferred, not blocking)

- `--panel N` / same-agent perspective assignment (prompt-engineering slice).
- Positional per-branch `--model` mirroring the roster.
- Write-panel sugar over `--parallel` stage composition (N implementations + a judge member).
- Per-branch worktree isolation if advisory read-only steering proves insufficient.

## Log

- 2026-07-23 — Stub created while running the codex e2e with a single claude reviewer; captured
  the reframing: a panel is a per-workflow MODIFIER, not a separate workflow.
- 2026-07-24 — Designed with the user. Key moves: `--panel` died before it was born — the roster
  form of `--agent` is the design (panel as CARDINALITY); in-workflow only (write kinds rejected —
  the two-substrate table); pure CLI-side `panelize` transform, zero engine change; synthesis
  guidance declared by the template (`panelSynthesis:`), judge pinned to claude; sync steering
  injected by the transform as the single author of branch prose.
- 2026-07-24 — v1 built (same day): slice items 1–6 done, 246 h-cli tests green (incl. new
  panelize unit tests + roster wire tests on both surfaces), pr-review golden re-blessed,
  CLAUDE.md updated. Confirmed zero engine change — no workflow-svc file touched. Deviations
  from the letter of the design, all shape-level: synthesis reuses the original step id;
  short-name branch ids; epilogue stripped from the quoted task; duplicate-executor rosters
  rejected. Remaining: e2e panel-review chain (item 8), then the agent-panel retirement cutover
  (item 7).
- 2026-07-24 — Item 7 done (same day, reordered before the e2e at the user's direction —
  finish implementation first, then one e2e exercising every parallelism substrate):
  `agent-panel` → `answer` cutover across template, engine kind (both sides), CLI tables, tests,
  goldens, CLAUDE.md, and a superseded-note on docs/plans/multi-agent-panel.md. The kind's
  contract simplified with the reshape: `task` in (unchanged), flat `answer` out (was
  `consensus`+`best` — `best` died with the fixed three-agent roster; the judge merges instead).
  multi-agent-panel.md's engine deliverable (the parallel step group) is untouched and now
  exclusively fed by panelize.
- 2026-07-24 — Item 8 done: container-mode e2e (two chains, hardening-audit A9 as the real
  workload) validated every parallelism substrate + the panel review loop; PR #64 driven
  through 3 review×revise iterations by a claude∥codex panel with risks-panel-steered focus.
  Five findings recorded above (worktree lifecycle being the substantive one). Also hardened
  along the way: compose daprd sidecars got `restart: on-failure` after the SQLite-NR
  Host-registration-lost fatal recurred and left the stack unsupervised for 5h.
