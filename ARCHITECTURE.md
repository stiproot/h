# Architecture

h runs agents as steps in durable [Dapr](https://dapr.io) workflows, and composes those workflows.
Small primitives; everything larger is a composition of them.

## Primitives

- **Workflow** — a durable run that does work. Never supervises or sequences itself.
- **Trigger** — anything that fires a workflow (HTTP, a `workflow-trigger` event, or the cron tick).
- **Registry** — durable rows under a single-writer prefix in the flat keyspace.
- **Watcher** — a registered policy + engine that *supervises* one workflow on the cron tick
  (terminate / retry / escalate). Registry `watch:*`; `h watch list`.
- **Chain** — a registered policy + engine that *sequences* workflows on the cron tick (fire the
  next workflow when the last lands, threading state by parsing each one's output). Registry
  `chain:*`; `h chain list`.

Watcher and Chain are the same shape — a policy row + a pure `decide` + a cron-tick scan,
single-writer, epoch-fenced — with different vocabularies. The invariant: **a workflow never
supervises or sequences itself; those live in engines outside it.**

## Composition

```
template ─(overlay ⊕)→ workflow definition ─(execute)→ workflow ─(chain)→ chain
```

- **Template** — a parameterized workflow.
- **Overlay (⊕)** — merge templates into one definition. *Spatial*: for units that share an agent's
  context (one worktree, one run), e.g. `feature ⊕ verify ⊕ create-pr`.
- **Workflow definition** — hydrated template(s), bound to params.
- **Workflow** — an executed definition (the durable run).
- **Chain** — sequence workflows. *Temporal*: for units that hand off to a fresh agent, e.g.
  `feature-pr → pr-review → revise`.

Overlay vs chain is *where the agent's context breaks* — and a performance call: shared-context units
must overlay, or you re-read context per chained workflow.

## Principles

- **Compose, don't fuse** — small atoms + an operator, not one big flag-selected thing.
- **Closed vocabularies, not config DSLs** — engine behavior is code over a fixed-struct policy.
- **Single-writer registries** — one writer per `prefix:`; everyone else reads.
- **Machines loop, agents judge** — supervision and sequencing are engines on a clock; agents only judge.
- **Fail loud** — surface missing inputs / cost gaps / unavailable tools; never a silent no-op.
- **Atomic cutovers** — delete the old in the same change that lands the new.
- **Thin services, reusable packages** — logic in `packages/*`; JS/Python parity.
- **One join key** — `workflowInstanceId` joins traces, logs, the run ledger, and every registry row.
- **Build what's needed** — no speculative machinery, no legacy kept "just in case".

Runtime detail, gotchas, and app layouts: [CLAUDE.md](./CLAUDE.md). The CLI: [cli/README.md](./cli/README.md).
