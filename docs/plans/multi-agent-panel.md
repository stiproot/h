# Multi-agent panel — parallel step groups in the generic workflow

## Position: augment agents, never replace them

h does not compete with what an agent runtime already does well — Claude Code's subagents,
planning, loops, and plugins (and their siblings in openhands/pi) are the *intelligence*
layer, and reimplementing any of it inside h would be reinventing the wheel badly. h's job
is the layer agents cannot provide for themselves: a durable execution environment
(workspaces, identity, supervision, recurrence, observability), a collaboration substrate
(workflows, chains, threading state between runs), and primitives delivered *to* the agents
(plugins, skills, MCP servers). Inside a step, the agent is sovereign; between steps, h is.
This principle graduates to ARCHITECTURE.md alongside the existing principles.

## The question that motivates this plan

"Can I use claude, openhands and pi in a single workflow step?"

What exists today:

- **Across steps** — yes. A template bakes a different run activity per step
  (`run-claude`, `run-openhands`, `run-pi` are sibling activities), or fire-time identity
  params retarget a whole run. Sequential only.
- **Across chain members** — yes. `h chain run -w a --agent claude -w b --agent openhands`
  gives each chained workflow its own executor, with structured threading between them.
  Sequential only.
- **In one step, concurrently** — no. `generic.workflow.ts` is a strict
  `for … yield callActivity` loop; the step model has no parallel construct. The Dapr JS
  SDK supports it (`ctx.whenAll`, SDK 3.17) — the gap is purely in our step model and engine.

## Design: the parallel step group

One new construct, deliberately minimal:

```yaml
steps:
  - id: panel                      # optional group id
    parallel:
      - id: claude
        activity: run-claude
        input: { task: "…" }
      - id: openhands
        activity: run-openhands
        input: { task: "…" }
      - id: pi
        activity: run-pi
        input: { task: "…" }
  - id: synthesize
    activity: run-claude
    input:
      task: |
        …{{claude.output}}…{{openhands.output}}…{{pi.output}}…
```

Semantics:

- A step is either a plain step (unchanged) or a **group**: `{id?, parallel: [plain steps]}`.
  Groups do not nest.
- The engine resolves every branch's input against the results map *before* any branch runs
  (branches cannot reference each other — that is what makes them parallelizable), then
  yields ONE `ctx.whenAll` over the branch activities. Deterministic and replay-safe: the
  fan-out is a single decision point in the generator.
- Results land under each branch's id exactly as if they were steps (`{{claude.output}}`),
  and — when the group has an id — also as a map under the group id.
- A branch failure fails the group (whenAll semantics), which fails the run — the same
  loud-failure contract as sequential steps. Partial-result tolerance is a later increment
  (whenAll surfaces per-task errors; a `tolerate: N` knob could keep a panel alive when
  one agent dies).
- The one-declarer output-contract rule is untouched: branches carry no `outputs`; the
  synthesis step (sequential, after the group) declares the contract. Chains see the panel
  workflow exactly like any other workflow.

## Increments

1. **Model** — `workflow.model.ts`: `ParallelGroup` schema (`{id?, parallel: StepDefinition[]}`),
   steps become `Union(StepDefinition, ParallelGroup)`. Stored workflows and `toRequest`
   pass groups through untouched.
2. **Engine** — `generic.workflow.ts`: group branch → resolve all branch inputs → `whenAll`
   → write branch results (+ group map). Unit test with a stub workflow context driving the
   generator (first engine-level test; the file has none today).
3. **Template** — `agent-panel.yaml` chart template (gated, publish-native): fire-time
   params `task` (+ optional `context`), three branches with per-branch model values, a
   claude synthesis step comparing the three answers under a declared output contract
   (`{consensus, disagreements, best}`), goldens re-blessed.
4. **Docs** — ARCHITECTURE.md principle ("augment, don't replace" + the group construct),
   CLAUDE.md app-layout line for generic.workflow.
5. **Live validation** — publish, bring up the three agent profiles in compose, fire one
   panel run, verify three concurrent run ledgers + one synthesis.

## Update (2026-07-21): agent-panel is now a first-class CHAIN kind

The panel began as a standalone publish-native workflow (`h workflow run agent-panel`). It is
now also a first-class **chain** kind, so the whole panel composes as a *concurrent chain
member* — the panel's in-process parallel step (claude ∥ openhands ∥ pi) running concurrently
with another workflow in a chain stage. A novel chain kind is added on BOTH sides (the standing
rule from `chain.model.ts`):

- **Engine** (`apps/workflow-svc/src/domain/`): `agent-panel` added to the `ChainWorkflowKind`
  literal (`models/chain.model.ts`) + a `capturePanel` contract in `WORKFLOW_KINDS`
  (`chain-workflows.ts`) — coded `buildParams` reads a `task` off the blackboard; `capture`
  threads the synthesis's `consensus` (+ `best`) back. Identity is pinned per-branch in the
  template, so there are no fire-time identity params to thread. A *parallel* panel member
  declares explicit `--capture` + an `--id`, which namespaces the captures under `data[id]` (D5)
  so concurrent panels never clobber the flat `consensus`.
- **CLI** (`cli/h/.../chain.py`): `agent-panel` added to `KNOWN_KINDS` / `WELL_KNOWN`
  (so `-w agent-panel` resolves with no `--kind`) / `KIND_FIRE` (prefix `panel`, fresh) /
  `KIND_MODEL_PARAMS` (empty — models bake at publish time, not fire-time).

Live-validated the same day: a `sequential` chain ran two panels concurrently in one stage
(`-w agent-panel --id design --parallel -w agent-panel --id testplan`), each capturing its
namespaced `design.consensus` / `testplan.consensus`, which then fed an inline
`feature ⊕ verify ⊕ create-pr` build stage that opened PR #53.

## Non-goals

- No agent-to-agent chat inside a step (that is the agents' own subagent machinery).
- No scatter-gather DSL beyond one flat group (nesting, map-over-list: not until a real
  use case demands them).
- No quorum/voting engine-side — judgment stays agent-side (the synthesis step).
