# Panels as a modifier: the `--agent` roster

Status: Designed — decisions locked, v1 slice enumerated; ready to implement
Established: 2026-07-23 · Designed: 2026-07-24

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

1. `cli/h/src/h_cli/infrastructure/chain_expr.py` — `--agent` moves from `VALUE_FLAGS` to a
   greedy multi-value class (the `-t` atom loop, reused); `WorkflowConfig.agent: str | None` →
   `agents: tuple[str, ...] = ()`; a single agent stays legal as a chain-wide default, a roster in
   the prefix is rejected ("a panel is one member's shape — place the roster after a -w/-t
   workflow", the `--kind` per-workflow-only spirit). Failure mode stays loud: a forgotten `-w`
   swallows the next word into the roster and dies at `AGENT_IDENTITY` validation with
   `unknown agent '<word>'`.
2. `cli/h/src/h_cli/infrastructure/panelize.py` — NEW, pure, dependency-free:
   `panelize(steps, outputs, roster, judge, panel_synthesis) -> steps'` per decision 3. Unit
   tests assert the parallel-group shape, contract stripping, preamble injection, judge pinning.
3. `cli/h/src/h_cli/commands/chain.py` — `_resolve_workflow`: `len(agents)==1` byte-for-byte
   today's path; `len(agents)>1` → panelize branch (force compose-on-fire; `-w` fetches stored
   steps; reject write kinds `feature-pr`/`revise`; reject `--model`; relax the pr-review freeze
   for rosters). `_identity_params` takes the roster.
4. `cli/h/src/h_cli/commands/workflow.py` — `--agent` becomes repeatable; roster → fetch +
   panelize + run inline.
5. `cli/charts/workflows/templates/pr-review.yaml` — declare `panelSynthesis:` (verdict rule:
   CLEAN only if every panelist is CLEAN and no blocker survives; merge all blockers otherwise).
6. Docs/tests ripple — grammar docstrings (`chain_expr.py`, `chain.py` help), the CLAUDE.md chain
   bullet, parser tests, panelize goldens; the kind-sync guard is untouched (no new kind).
7. Migration of the prior art — `agent-panel` (template + chain kind) becomes the degenerate case
   (a bare "answer this task" template run with a roster); keep it working through v1, retire in a
   follow-up cutover once the roster path is validated e2e ([[atomic-cutovers]] applies to the
   retirement, not to coexistence-while-designing).

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
