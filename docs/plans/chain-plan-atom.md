# A `plan` chain atom (distinct plan vs implement agents)

Status: **BUILT 2026-07-28** — `cli/charts/workflows/templates/plan.tmpl.yaml` (commit 868d080).
Captured 2026-07-13 as a stub, deferred in favour of testing the existing machinery first; built
when the deferral's cost came due (see below).

**What shipped:** `worktree → setup → plan`, stopping AT the plan and declaring it through an
output contract (`plan` required), so the plan is a chain-VISIBLE artifact. Panelizable like
`answer` (it carries a `panelSynthesis` join rule). Golden + structure tests in
`cli/h/tests/test_render.py`.

**What it unlocked, validated live the same day:** a chain of `-t plan` (claude) → `-t plan`
panelized (claude + openhands/DeepSeek) → `-t implement verify create-pr` (openhands) produced
stiproot/h#97. That is both halves of the gap below — a distinct planning agent, AND a review of
the plan before it becomes a prompt (docs/plans/spec-review-pipeline.md).

**Deviation from the sketch below:** the plan threads through the chain DATA (`--capture
plan=plan` → `--input spec=plan.plan`), not the file handoff this doc proposed as the cheaper
first cut. The blackboard route turned out to be the one that works, because a chain member's
worktree is not guaranteed to be the next member's.

**Known rough edge:** `-t plan` needs an explicit `--kind` (the closed `MEMBER_KINDS` literal has
no `plan`); it currently rides `--kind answer` with both threading halves declared explicitly,
which fully replaces the kind's coded contract. A first-class `plan` kind would remove that.

## The gap

A chain binds ONE executor per workflow (`-w feature --agent openhands`). The `feature` template is
`worktree → setup → plan → implement` under a single `runActivity`, so plan and implement always run
on the *same* agent. There is no first-class way to express **"Claude plans, then OpenHands
implements"** as two agent-distinct chain stages.

## The idea

Add a `plan.yaml` chart atom — essentially `feature`'s plan step without the implement step:

- `worktree → setup → plan` under its own `runActivity` (Claude by default).
- Writes the plan to `plan-<slug>.md` in the run-specific worktree AND emits a `===PLAN===` marker.
- The following `feature`/implement stage (OpenHands) **reuses the same worktree** (same
  `slug`/`workspaceId`) and implements from `plan-<slug>.md` — the file-handoff pattern the grooming
  workflow already uses, so no chain-engine change is required. (A tighter variant threads the plan
  through the blackboard via a `capturePlan` sibling of `capturePr`/`captureReview` in
  `chain-workflows.ts`; the file handoff is the cheaper first cut.)

Chain shape it unlocks:

```
h chain run --slug <slug> -p spec=@<spec>.md -p repo=stiproot/h \
    -t plan                --agent claude \
    -t feature create-pr   --agent openhands \
    -w pr-review \
    -w revise              --agent openhands
```

To avoid the `feature` stage re-planning, either (a) give `feature` an "implement-from-plan" mode
that skips its own plan pass when `plan-<slug>.md` is present, or (b) split a dedicated
`implement.yaml` atom. Decide when this is picked up.

## Why deferred

The first end-to-end test of the chain machinery does the planning **manually** (a human/Claude writes
the plan straight into the GitHub issue) and runs only the existing atoms
(`feature → pr-review → revise`). That exercises what already exists before we add a new atom. Pick
this up once that flow is proven.

Related: [[workflow-composition-plan]], the `feature`/`create-pr`/`pr-review`/`revise` templates in
`cli/charts/workflows/templates/`.
