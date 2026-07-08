# Architecture

h is an orchestration runtime: it runs agents as steps in durable [Dapr](https://dapr.io) workflows,
and composes those workflows into larger units. This doc is the conceptual map — the foundational
building blocks and the principles that keep them composable. For runtime detail and gotchas see
[CLAUDE.md](./CLAUDE.md); for the workflow patterns and the CLI, [WORKFLOWS.md](./WORKFLOWS.md) and
[cli/README.md](./cli/README.md); for the design records behind these rulings,
[docs/plans/](./docs/plans/) (notably `watcher-primitive.md` and `workflow-composition.md`).

## Building blocks (the primitives)

A small, closed set of primitives, each with one job. Everything larger is a *composition* of these
— never a bigger primitive.

- **Workflow** — a durable step sequence that does work and leaves durable traces (Dapr instance
  status, run ledger + `run:<id>` mirrors, Zipkin spans, all joined on `workflowInstanceId`). A
  workflow is a **pure run**: it never supervises or sequences anything, including itself.

- **Watcher** — a durable registration `{subject, policy}` + a shared engine that, on the cron tick,
  reads a subject's already-persisted state and acts through a closed **supervision** vocabulary:
  *terminate / record / publish / escalate* (budgets, retries, escalations). Judgment stays
  agent-side. Registry `watch:*`; inspect with `h watch list`.

- **Chain** — a durable registration `{hops, strategy, data}` + a shared engine that, on the same
  cron tick, reads the current hop's state and acts through a closed **sequencing** vocabulary:
  *advance (fire the next hop) / join / finalize*. State threads hop-to-hop through the row's `data`,
  which the engine fills by **parsing each completed hop's output** — so the chained workflows stay
  chain-agnostic (params in, `===MARKER===` out; runnable standalone). Registry `chain:*`; inspect
  with `h chain list`.

- **Trigger** — anything that fires a workflow: HTTP `/workflow/run*`, a `workflow-trigger` event
  `{key, params}`, or the cron tick over saved schedules. Triggers are data; one well-known topic.

- **Registry** — durable rows under a claimed prefix in the flat Redis keyspace plus an index key.
  The convention: a prefix names the **single component** that owns writing it (`watch:`, `chain:`,
  `sweep:`, saved workflows, `run:` mirrors). Everyone else reads.

**Watcher and Chain are two instances of one build-pattern:** a policy row in a registry, evaluated
by a pure `decide` function on the cron-tick clock, acting on workflows through a closed vocabulary,
epoch-fenced, single-writer. The Watcher *supervises*; the Chain *sequences*. Neither is a new
runtime concept — each is a composition of Workflow + Trigger + Registry that earns its own name
because its job recurs often enough to deserve one home. The invariant that keeps this clean:

> **A workflow never supervises or sequences itself — those live in engines *outside* it.**

That is precisely why sequencing became the **Chain** primitive rather than being smuggled into the
watcher's `escalate` hook: firing one follow-up on a bad outcome (supervision) is a different act
from running an ordered, state-threaded pipeline (sequencing), so it got its own primitive instead
of overloading the watcher into an orchestrator.

## Composition: the stack

The primitives stay small because **composition — not bigger primitives — is how you build larger
things.** There are two composition axes, and they map onto a real technical boundary: *where the
agent's context breaks.*

```
templates ──(overlay ⊕)──► workflow definition ──(execute)──► workflow ──(chain)──► chain
```

- **Template** — an authored, parameterized, composable blueprint. (A helm-rendered chart is one way
  to author one; it is not the template itself.) The atoms today: `feature`, `verify`, `create-pr`,
  `pr-review`.
- **Overlay (⊕) — *spatial* composition.** Merge N templates into **one** workflow definition
  (compose-file semantics, `docker compose -f a -f b`). Used when the units share an agent's context
  — the same worktree, one continuous run: `feature ⊕ verify ⊕ create-pr` is **one** implement agent
  that codes, runs the acceptance check, and opens the PR, with no context re-read.
- **Workflow definition** — a template (or an overlay of templates) rendered and bound to params:
  the concrete `{instanceId, steps}` handed to the engine.
- **Workflow** — a workflow definition *executed*: the durable run.
- **Chain — *temporal* composition.** Sequence N workflows across a **context handoff** — a
  *different* agent, reading fresh: `feature-pr → pr-review → revise`. Separate runs, separate
  instanceIds; state threaded through the chain row.

Overlay vs chain is not a stylistic choice — it is *where context breaks*, and therefore also a
performance decision: units that share an agent's context **must** overlay, or you pay a context
re-read per hop.

## Principles

1. **Compose, don't fuse.** Prefer small atoms + an operator over one big parameterized thing
   selected by flags. `feature --pr` (a flag that rewrote step prose) became `-t feature -t
   create-pr` (explicit overlay); a "family" became a "template".
2. **Closed vocabularies, never a config DSL.** An engine's behavior is *code* over a fixed-struct
   policy — not logic expressed in config. The watcher's policy is a struct; the chain's hop
   contracts are engine code (`chain-hops.ts`), not a rules language.
3. **Single-writer registries.** Each `prefix:` in the flat keyspace has exactly one writer; everyone
   else reads. A collision is a design error, not a race to be managed.
4. **Machines run durable loops; agents judge.** Supervision and sequencing are engines on a clock —
   they survive a closed laptop. Agents are only for judgment; never build orchestration on an agent
   looping `await`.
5. **Fail loud, never silent.** A missing input, an unmatched cost mirror, an unavailable MCP tool —
   surface it (`costGap` instead of a silent `$0`, a failed-chain finalize with a reason), never a
   quiet no-op.
6. **Atomic cutovers.** Delete the old machinery in the *same* change set that lands the new — no
   migration windows, no both-at-once (the `--pr` kill, the babysitter → watcher cutover, the chain
   CLI cutover).
7. **Thin services, reusable packages, cross-stack parity.** Logic lives in shared packages
   (`packages/js/*`, `packages/py/*`); services are thin wrappers over one HTTP contract. The JS and
   Python `agent-server` mirror each other.
8. **One join key, fully observable.** `workflowInstanceId` joins traces, logs, the run ledger, and
   every registry row — so what a run did is reconstructable from durable evidence, not memory.
9. **Build what's needed.** No speculative machinery ahead of a real use case (`parallel` fan-out is
   deferred until a multi-reviewer chain exists); no legacy accommodation kept "just in case".

## Where next

- **Runtime, gotchas, app + k8s layouts** → [CLAUDE.md](./CLAUDE.md)
- **Workflow patterns, the `h` CLI, composition/chain usage** → [WORKFLOWS.md](./WORKFLOWS.md),
  [cli/README.md](./cli/README.md)
- **Design records and the rulings behind the primitives** → [docs/plans/](./docs/plans/)
