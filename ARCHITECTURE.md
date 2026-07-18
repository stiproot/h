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
  next workflow when the last lands, threading state by reading each one's machine-validated
  structured output — every chained template declares an `outputs:` schema and ends its agent step
  with a fenced json block validated against it; the workflow's contract is "params in, declared
  output out", runnable standalone — docs/plans/structured-workflow-outputs.md). Registry `chain:*`; `h chain list`.
- **Cron** — a registered policy + engine that *recurs* one workflow on the cron tick (re-fire until
  its goal resolves or a budget trips). Registry `cron:*`; `h cron list`. Two more variants share the
  family (same tick, same store, same kill-switch/ledger, each its own row schema + pure decide +
  scan): a **discovery** variant fans out instead of re-firing — it reads a source (open issues on a
  label) and fires one workflow per newly-seen item, deduped against `wf:*` (the h-builds-h issue
  loop); and a **scheduled-fire** variant (`cron:sched:*`; `h schedule list`) fires one workflow
  exactly ONCE at an absolute time, then deactivates — no cadence, no budget, no goal handshake. The
  one-shot is the spine for scheduling-at-a-time, pause/resume (fire a continuation after a delay,
  reusing the workspace), and the usage-limit fallback (the watcher arms a deferred continuation under
  a different agent) — docs/plans/schedule-and-fallback.md.

Watcher, Chain, and Cron are the same shape — a policy row + a pure `decide` + a cron-tick scan,
single-writer, epoch-fenced — differing only in the action (supervise / sequence / recur). The
invariant: **a workflow never supervises, sequences, or recurs itself; those live in engines outside
it.** A workflow may *register* an engine for another workflow (arm a cron), acting as a client of the
primitive — that is not the same as being the engine.

## Composition

```
template ─(overlay ⊕)→ workflow definition ─(execute)→ workflow ─(chain)→ chain
```

- **Template** — a parameterized workflow.
- **Overlay (⊕)** — merge templates into one definition. *Spatial*: for units that share an agent's
  context (one worktree, one run), e.g. `feature ⊕ verify ⊕ create-pr`.
- **Workflow definition** — hydrated template(s), bound to params at fire time — including
  identity (agent/model): published slots with values-baked defaults, overridable per fire.
- **Workflow** — an executed definition (the durable run).
- **Chain** — sequence workflows. *Temporal*: for units that hand off to a fresh agent, e.g.
  `feature-pr → pr-review → revise`.

Overlay vs chain is *where the agent's context breaks* — and a performance call: shared-context units
must overlay, or you re-read context per chained workflow.

The CLI projects the stack 1:1 — each noun's verb is the arrow: `h template compose` (overlay),
`h workflow run` (execute), `h chain run` (chain — an ordered expression of `-w KEY` / `-t ATOM…`
members with position-scoped per-workflow flags; a `-t` group overlays inline, composed-on-fire).

## Principles

- **Compose, don't fuse** — small atoms + an operator, not one big flag-selected thing.
- **Closed vocabularies, not config DSLs** — engine behavior is code over a fixed-struct policy.
- **Single-writer registries** — one writer per `prefix:`; everyone else reads.
- **Registry rows are created by activities** — a workflow registers its own follow-on state (arm a
  cron) through a workflow *activity*, idempotently (ensure-exists, so a re-fire doesn't reset it) and
  audited by its `wf:` row. WHERE a row is written is an ordering question, not an edge-vs-activity
  one: the **watcher** alone registers *in the fire handler before the run* (persist-then-invoke),
  because supervision must precede what it supervises; everything else is armed by the run itself.
- **Machines loop, agents judge** — supervision and sequencing are engines on a clock; agents only judge.
- **Augment agents, never replace them** — an agent runtime's own capabilities (subagents, planning,
  loops, plugins) are the intelligence layer; h never reimplements them. h owns what agents cannot
  give themselves: the durable execution environment (workspaces, identity, supervision, recurrence,
  observability), the collaboration substrate between runs (workflows, chains, parallel step groups,
  threaded state), and the primitives delivered *to* agents (plugins, skills, MCP servers). Inside a
  step the agent is sovereign; between steps h is (docs/plans/multi-agent-panel.md).
- **Fail loud** — surface missing inputs / cost gaps / unavailable tools; never a silent no-op.
- **Atomic cutovers** — delete the old in the same change that lands the new.
- **Harden by encoding** — an invariant worth stating is worth a lint rule, not a review habit. When
  you add a boundary — or spot an unenforced one — add or extend the rule that guards it, in the same
  change. Prefer a check a machine runs every time over a convention a human must remember. Actively
  look for these opportunities; an unguarded boundary drifts.
- **Thin services, reusable packages** — logic in `packages/*`; JS/Python parity.
- **One join key** — `workflowInstanceId` joins traces, logs, the run ledger, and every registry row.
- **Build what's needed** — no speculative machinery, no legacy kept "just in case".

## Boundaries (enforced)

Every service is hexagonal, and the layout **is** the contract: `domain/` is the pure core plus
its ports (interfaces the core defines), `infrastructure/` holds outbound adapters, `presentation/`
holds inbound adapters, and the composition root (`index.ts` / `main.py`) is the sole place that
wires concrete adapters behind ports. These arrows are machine-checked, not just conventional:

- **`domain/` is pure** — it imports neither adapter layer, nor any runtime/I-O library. A boundary
  the core touches is a **port** (an `effect` `Context.Tag` / a Python `Protocol` in `domain`); the
  driver lives in `infrastructure/` and is injected at the root.
- **Adapters are independent** — `presentation/` and `infrastructure/` never import each other; they
  meet only at the composition root, behind ports.
- **No cycles** — a dependency cycle crosses a boundary that should be one-directional.

The dependency arrow always points *into* the domain. Enforcement is part of `make lint`:
[`dependency-cruiser`](./.dependency-cruiser.cjs) for the TS services (`bun run lint` per package)
and `import-linter` contracts (the `[tool.importlinter]` blocks in each hex agent's `pyproject.toml`)
for the Python agents — the same invariants expressed in each stack's dialect. A new hex service
inherits the TS rules for free; a new Python hex agent adds its own contract block.

Runtime detail, gotchas, and app layouts: [CLAUDE.md](./CLAUDE.md). The CLI: [cli/README.md](./cli/README.md).
