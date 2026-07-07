**Status:** EXPLORATORY (2026-07-07) — design locked, not yet implemented. This plan tightens h's
workflow architecture by dissolving the "family" concept into a clean primitive stack (template →
workflow → chain) and adding two composition operators. It supersedes the flag-driven,
template-conditional style (`feature --pr`) with explicit composition.
**Living doc** — update Decisions as they resolve and append to the Progress log as phases land.

# Workflow composition: templates, overlays, and chains

## Framing

Today a "family" (a helm-templated workflow like `feature`) carries two things that don't belong to
it: **flags that mutate step *prose*** (`feature --pr` flips a template conditional that rewrites what
the final step's agent is told to do), and **no way to compose** — so conceptually separate operations
(implement, create-pr, review, revise) got fused into one template selected by flags. The goal here is
to make composition *explicit and first-class*, so the pieces stay independent and plug-and-play, yet
can be strung into "a feature all the way to a reviewed PR".

The insight that drives the whole design: **"family" was never a primitive — it was just a
parameterized workflow.** Once we (a) stop mutating step prose with flags and (b) add real composition
operators, "family" dissolves into "template", and the architecture tightens.

---

## 1. Vocabulary (adopt into core docs)

These terms replace "family" and must land in [CLAUDE.md](../../CLAUDE.md),
[README.md](../../README.md), and [WORKFLOWS.md](../../WORKFLOWS.md) as part of this work.

- **Template** — the authored, parameterized, composable unit (what a "family" pretended to be). A
  blueprint. A helm chart is *one way to author a template*; it is not the template itself.
- **Workflow definition** — a template (or an *overlay* of templates) rendered and bound to params:
  the concrete `{instanceId, steps}` body handed to the engine. The artifact at the wire boundary.
- **Workflow** — a workflow definition *executed*: a durable run with an instanceId, run-ledger
  records, spans, and a `watch:` row. The runtime instance.
- **Overlay** — *spatial* composition: merge N templates into **one** workflow definition (compose-file
  semantics, `docker compose -f a -f b`). Shares context within a single run.
- **Chain** — *temporal* composition: run N workflows in sequence/parallel under a **strategy**. Shares
  context across runs via the chain actor.
- **Chain actor** — a Dapr actor, keyed by the chain's `slug`, holding the shared-context blackboard
  (`data`) that chained workflows read and write.
- **Strategy** — how a chain executes its members: `sequential`, `parallel`, `loop-until-clean`.

The stack: **templates —(overlay)→ workflow definition —(execute)→ workflow —(chain)→ chain.**
"Family" retires.

---

## 2. The two composition axes

The two operators are not redundant — they map onto a real technical boundary: **where the agent's
context breaks.**

- **Overlay** composes units that run in the **same context** — the same worktree, one continuous
  agent run. `implement ⊕ create-pr ⊕ verify`: the agent commits what it just wrote; no context
  re-establishment. One workflow, one instanceId.
- **Chain** composes units across a **context handoff** — a *different* agent, reading fresh.
  `review` runs as `claude-coder` reading the PR; `revise` is a separate run addressing comments.
  Separate workflows, separate instanceIds.

The canonical "feature → reviewed PR" decomposition:

```
[ implement ⊕ create-pr ⊕ verify ]  →  [ review ]  →  [ revise ]
        one workflow (overlay)          chain           chain
```

Overlay is chosen partly for **performance** (avoid N context re-reads), not only aesthetics — this is
why `implement`+`create-pr` must overlay, not chain.

---

## 3. Shared state: the chain actor (generic by design)

Cross-workflow sharing is the load-bearing problem. Decision: a **Dapr actor keyed by the chain
`slug`** is the shared-context object. Params carry only the *handle* (the slug → the actor address);
the actor carries the *state*. Precedent: `issue-sweep` already keys shared findings by a stable id.

The schema is deliberately **generic and dynamic** — a free-form blackboard, not a fixed struct:

```ts
// The chain actor's state, addressed by actorId = `chain-${slug}`.
interface ChainState {
  slug: string;                    // stable chain id + git-branch token
  data: Record<string, unknown>;   // the shared blackboard; templates key out what they need
}
```

`data` maps directly onto the actor's key/value state: a template writes `actor_state_set(actorId=
chain-${slug}, key=<k>, value=<v>)` and reads `actor_state_get(...)`. Each template **keys out of
`data` exactly what it expects** and writes back what it produces. Conventional keys (not enforced):
`worktreePath`, `branch`, `spec`, `plan`, `prNumber`, `prUrl`, `reviewFindings`, `sha`.

**Tradeoff (accepted deliberately):** a dynamic `Record` means the port contract — which keys a
template consumes/produces — is **convention + documentation, not a compile-checked schema.** We buy
maximum flexibility (any template composes with any other; no schema migration to add a key) at the
cost of static guarantees. Each template's header MUST document its `data` inputs/outputs so the
contract stays legible. A missing expected key is a runtime concern the template handles (fail loud,
never silent).

### Two sharing mechanisms, one per axis

| Composition | Shares state via | Scope |
|---|---|---|
| **Overlay** (templates → one workflow) | `{{step.output}}` / `$ref` (existing engine) | within one workflow |
| **Chain** (workflows → sequence) | **the chain actor's `data`** | across workflows |

The actor's `data` *is* the chain's port surface. In a **parallel** strategy it is also the
aggregation point: each fan-out member appends to `data` (actor turn-based writes serialize, so no
race), and the join reads the merged result.

---

## 4. Composition is two flag axes over one `-t` list

Templates are named with a repeated `-t` flag (compose's `-f` ergonomic). Two independent selectors
act over the same list, and **chain-level flags apply to every member** (`--watch`, `--agent`,
`--slug`, `--model`), with per-member override left for later:

- **Composition mode** — overlay (merge → one workflow) vs chain (sequence).
- **Chain strategy** — `sequential` | `parallel` | `loop-until-clean`.

```sh
# Overlay: merge templates into one workflow (replaces `feature --pr`)
h workflow run -t implement -t create-pr -t verify --slug dark-mode --agent openhands

# Chain: sequence workflows to a reviewed PR
h chain run -t feature -t pr-review -t revise \
    --strategy loop-until-clean --slug dark-mode --agent openhands --watch
```

`--pr` is gone: opening a PR is `-t create-pr`, not a flag that rewrites prose.

### The overlay-inside-a-chain-hop corner

If `--chain` made *every* `-t` a separate workflow, `implement` and `create-pr` would split into
separate runs — re-introducing the context re-establishment overlay exists to avoid. Resolution for
v1: **overlay is authoring-time, chain is invocation-time.** Pre-compose `implement ⊕ create-pr ⊕
verify` into a named template, then chain flat single-template hops. This mirrors compose exactly (`-f`
merges *before* `up`; you don't nest merges inside a sequence). Inline overlay-in-a-hop is a possible
v2 nicety, deferred until needed.

---

## 5. Who runs the chain: chain-as-policy (mirrors watch)

A chain must not be "an agent looping `await_workflow`" — the watcher-primitive ruling
([watcher-primitive.md](./watcher-primitive.md)) says machines run durable loops, agents are for
judgment. The destination is therefore the **same shape as watch**:

> A chain is a registered policy `{workflows: […], strategy, slug}` in a `chain:` registry, evaluated
> by an engine on the `workflow-events` clock, that fires the next workflow(s) per strategy when the
> previous reach terminal — acting through a closed vocabulary (fire-next, fan-out, join, finalize).

This resolves the "who supervises the chain?" tension: workflows still never supervise (the doc's
invariant holds); the **chain engine** does the sequencing, exactly as the **watch engine** does
budgets. A chain is to sequencing what a watcher is to supervision — one more registry beside
`watch:` (`chain:`), one more engine on the same tick.

**Staging note:** an interactive CLI chain (blocks + polls, non-durable) is the cheap way to feel the
ergonomics first; the durable policy engine is the destination that makes a chain a first-class
primitive rather than a script. See Phase 1 vs Phase 4.

---

## 6. Strategies (the concurrency experiments)

`strategy` is a field on the chain policy:

- **sequential** — fire next on terminal. The event-driven baseline.
- **parallel** — fan out N members on the shared context at once (e.g. `review-security` ∥
  `review-perf` ∥ `review-correctness`), each appending to the chain actor's `data`, then a **join**
  barrier before the next hop.
- **loop-until-clean** — `review → revise → review …` until a **predicate** holds (the reviewer emits
  `===REVIEW=== CLEAN`) or a **budget** trips (max iterations). The budget is the watch engine's
  concern — another place chain and watch rhyme. Without the budget an implementer/reviewer
  disagreement could spin forever.

---

## 7. Phased rollout

Each phase is independently shippable; the riskiest concept (the actor contract) is proven first for
almost nothing.

**Phase 1 — Chain the workflows we already have (cheap probe).** No template surgery. Chain the
existing `feature` → `pr-review` → `revise` via a `-t` CLI command, a chain actor keyed by `slug`,
and `--strategy sequential`. Proves the two things that can kill the design — the **actor-as-shared-
context contract** and **cross-workflow output handoff** — before touching a single prompt. Runs on
the CLI (blocks/polls). Exit criterion: a feature taken to a reviewed PR by one command, state flowing
through the chain actor.

**Phase 2 — Harden the template primitive; kill `--pr`.** Decompose `feature` into overlayable atoms
(`implement`, `create-pr`, `verify`); implement the **overlay** operator (merge templates → one
workflow definition; `{{step.output}}` handoff preserved). `feature --pr` becomes `-t implement -t
create-pr`. "Family" is fully retired here. Re-bless chart goldens.

**Phase 3 — Land the vocabulary in core docs.** CLAUDE.md / README.md / WORKFLOWS.md adopt
template/workflow-definition/workflow/overlay/chain/chain-actor/strategy. (Can land alongside Phase 2.)

**Phase 4 — Chain-as-policy engine.** Lift sequencing off the CLI into a durable `chain:` registry +
engine on the `workflow-events` clock (mirrors the watch engine). Now chains survive a closed laptop
and are inspectable like watches (`h chain list`).

**Phase 5 — Strategies.** Add `parallel` (fan-out → actor aggregation → join) and `loop-until-clean`
(predicate + budget). The concurrency experiments live here.

---

## 8. Invariants & gotchas

- **Workflows never supervise** (unchanged). The chain engine sequences; workflows stay pure runs.
- **One writer per registry prefix.** A new `chain:` registry follows the flat-keyspace convention —
  only the chain engine writes `chain:*`.
- **The chain actor's `data` is a convention contract, not a schema.** Every template documents the
  `data` keys it reads/writes; a missing expected key fails loud, never silent (cf. the "MCP tool
  unavailable must be reported" gotcha).
- **Actor keying.** `actorId = chain-${slug}` shares the composite-key space with dapr-mcp's
  GenericActor and the workflow runtime's internal actors — composite keying (`appID||type||id||key`)
  keeps them from colliding, as today.
- **Overlay vs chain is also a performance decision.** Units that share an agent's context (worktree +
  continuation) must overlay; splitting them into a chain pays a context re-read per hop.
- **Chain-level flags apply to all members** (`--watch`, `--agent`, `--slug`); per-member override is a
  deliberate later addition, not v1.

---

## 9. Decisions

1. **Adopt template/workflow/chain vocabulary, retire "family"?** (Locked: yes.)
2. **Generic dynamic chain-actor state (`{slug, data: Record<string, any>}`)** over a typed struct?
   (Locked: yes — flexibility over static guarantees; contract is documented convention.)
3. **Overlay = authoring-time, chain = invocation-time (flat hops) for v1?** (Locked: yes; inline
   overlay-in-hop deferred to v2.)
4. **Actors as the cross-workflow sharing mechanism?** (Locked: yes.)
5. **Chain's durable home is a `chain:` policy engine mirroring watch?** (Locked as destination;
   prototype on the CLI first.)
6. **Open — the chain actor's conventional key set.** First cut: `worktreePath, branch, spec, plan,
   prNumber, prUrl, reviewFindings, sha`. Refine during Phase 1.
7. **Open — `loop-until-clean` predicate + budget wiring.** Predicate = reviewer `===REVIEW=== CLEAN`
   marker; budget via the watch engine or a chain-local cap. Settle in Phase 5.
8. **Open — reviewer independence.** Enforce that the review member uses a different agent/model than
   the implement member (implement on openhands/DeepSeek, review on claude-coder)?

---

## Progress log

- **2026-07-07** — Design brainstormed and locked into this plan. No code yet. Next: Phase 1 — chain
  the existing `feature`/`pr-review`/`revise` workflows via a CLI `-t` command + a `chain-${slug}`
  actor, proving the shared-context contract.
