# Architecture

h runs agents as steps in durable [Dapr](https://dapr.io) workflows, and composes those workflows.
Small primitives; everything larger is a composition of them.

## Primitives

- **Workflow** — a durable run that does work. Never supervises or sequences itself.
- **Trigger** — anything that fires a workflow (HTTP, a `workflow-trigger` event, or the cron
  tick). Triggers are data: a trigger's *payload* is the **fire descriptor** — `{key|steps, params,
  instanceId, workspaceId?, watch?}`, the one shape every fire carrier embeds (the run request, the
  chain member) or projects per fire (the discovery cron's row per issue, the sched row's resubmit).
  `instanceId` is required-or-derived: the caller's id wins, else the fire choke point derives a
  readable `<key>-<yymmdd>-<hhmmss>` (loud `-N` collision suffix) — no fire path waits for Dapr to
  mint a UUID, so mark-before-fire supervision holds universally. The type is `Trigger`
  (workflow.model.ts); the `workflow-trigger` topic's `{key, params}` is its degenerate form.
- **Registry** — durable rows under a single-writer prefix in the flat keyspace.
- **Watcher** — a registered policy + engine that *supervises* one workflow on the cron tick
  (terminate / retry / escalate). Registry `watch:*`; `h watch list`.
- **Chain** — a registered policy + engine that *sequences* workflows on the cron tick as ordered
  STAGES, each stage a concurrent set the engine joins before advancing (fire the next stage when the
  last lands, threading state by reading each one's machine-validated structured output into a
  two-level namespaced chain data — every chained template declares an `outputs:` schema and ends its
  agent step with a fenced json block validated against it; the workflow's contract is "params in,
  declared output out", runnable standalone). A member may
  be a saved key, embedded inline steps, or a cron member the chain only OBSERVES (it self-arms its own
  recurrence via §10; the chain reads `wf:resolved`, never writes `cron:sub`); a chain fails as a unit
  (terminate siblings + publish cron-disarm). Registry
  `chain:*`; `h chain list`.
- **Cron** — a registered policy + engine that *recurs* one workflow on the cron tick (re-fire until
  its goal resolves or a budget trips). Registry `cron:*`; `h cron list`. Two more variants share the
  group (same tick, same store, same kill-switch/ledger, each its own row schema + pure decide +
  scan): a **discovery** variant fans out instead of re-firing — it reads a source (open issues on a
  label) and fires one workflow per newly-seen item, deduped against `wf:*` (the h-builds-h issue
  loop); and a **scheduled-fire** variant (`cron:sched:*`; `h schedule list`) fires one workflow
  exactly ONCE at an absolute time, then deactivates — no cadence, no budget, no goal handshake. The
  one-shot is the spine for scheduling-at-a-time, pause/resume (fire a continuation after a delay,
  reusing the workspace), and the usage-limit fallback (the watcher arms a deferred continuation under
  a different agent).

Watcher, Chain, and Cron are the same shape — a policy row + a pure `decide` + a cron-tick scan,
single-writer, epoch-fenced — differing only in the action (supervise / sequence / recur). The
invariant: **a workflow never supervises, sequences, or recurs itself; those live in engines outside
it.** A workflow may *register* an engine for another workflow (arm a cron), acting as a client of the
primitive — that is not the same as being the engine.

## Glossary

The same authored-slot/target pattern appears at two levels:

| Level | Container | Slot (authored, positioned) | Target (invoked) |
| --- | --- | --- | --- |
| Inside a workflow | workflow definition | **step** `{id, activity, input}` | **activity** (registered function) |
| Inside a chain | chain | **member** `{kind, key\|steps, captures…}` | **workflow** |

- **Template** — the authored, parameterized, composable unit. A Helm *chart* is the current
  authoring technology for templates, never a concept term.
- **Workflow definition** — the steps blob a template renders to. **Saved workflow** — a definition
  stored under a key. **Instance** — one durable execution (`instanceId`).
- **Step** — a definition's authored slot `{id, activity, input}`. **Activity** — a registered
  function (`run-claude`, `setup`, `write-wf-row`) a step invokes.
- **Parallel group** — a step whose `parallel:` fans branch steps through one whenAll.
  **Branch** — one step inside it.
- **Member** — a chain's authored slot `{kind, key|steps, stage?, id?, captures/inputs/until}`.
  **Stage** — the set of members that run concurrently (the cursor advances stage by stage).
  **Kind** — a member's coded threading-contract selector.
- **Chain data** — the chain's threaded state (the row's `data` field), two-level per D5. Captures
  write it; inputs read it via dotted data paths.
- **Panel** — a roster-generated parallel group. **Roster** — the plural `--agent` value.
  **Panelist/branch** — one roster agent's step. **Judge** — the pinned synthesis executor.
  **Synthesis** — the judge step emitting the workflow's own contract.
- **Fire descriptor / trigger payload** — the data a trigger carries: `{key|steps, params,
  instanceId (required-or-derived), workspaceId?, watch?}` — the core embedded by the run request
  and the chain member, projected per fire by the discover/sched rows (the `Trigger` type,
  `engine-core`'s workflow.model.ts, mirrored in both agent-server packages). Carriers add their own
  decorations: sequencing on a member (`kind`, `stage`, `id`, `captures`/`inputs`/`until`, `cron`),
  fire-time mechanics on a request (`fresh`, `at`/`in`, `armCron`, wf identity, `watchMeta`).
- **Fire / run / invoke** — *fire* starts a workflow (including fire-and-forget registration);
  *run* is reserved for agent runs and the literal `h workflow run` command; *invoke* is Dapr
  transport only. **Agent run** is one activity's agent invocation (run ledger, `run:` mirrors,
  cost tally).
- **Engine host** — the process that holds the tick and runs the engines' `decide` against durable
  rows, supplying their adapters. Substrate-NEUTRAL by design: workflow-svc is the service
  substrate's engine host (Dapr cron tick, Redis rows). The engines themselves — rows, ports,
  `decide`, and the per-tick scans — live in `packages/js/engine-core`, imported by every host, so
  a host chooses adapters and a clock, never semantics.
- **Substrate** — what EXECUTES a composed definition: the **service** substrate (Dapr engine +
  containerised fleet, durable and supervised) or the **local** substrate (the `h` CLI's own
  process driving agent CLIs as children, no infrastructure). Orthogonal to *deployment mode*
  (host / container / k8s), which is how the SERVICE substrate is hosted — local execution needs
  none of them. See Execution substrates below.
- **Workspace** — an agent service's provisioned directory (`workspaceId ?? instanceId`).
  **Worktree** — a git worktree inside the shared repository checkout.
- **Cron siblings** — recur, discovery/fan-out, and one-shot
  (`cron:sub`/`cron:discover`/`cron:sched`).

Workflow template names are imperative verb phrases in kebab-case: they say what the template
does (`implement`, `review-pr`, `improve-plugin`). Files carry the type marker
`<name>.tmpl.yaml`; CLI operands, gates, and saved keys use the bare name. Every template declares
one top-level `role:`: `standalone` is complete, `base` is complete and composable, and `overlay`
must be composed onto a base.

## Composition

```
template ─(overlay ⊕)→ workflow definition ─(execute)→ workflow ─(chain)→ chain
```

- **Template** — a parameterized workflow.
- **Overlay (⊕)** — merge templates into one definition. *Spatial*: for units that share an agent's
  context (one worktree, one run), e.g. `implement ⊕ verify ⊕ run-itest ⊕ create-pr ⊕ arm-revise-pr`.
- **Workflow definition** — hydrated template(s), bound to params at fire time — including
  identity (agent/model): published slots with values-baked defaults, overridable per fire.
- **Workflow** — an executed definition (the durable run).
- **Chain** — sequence workflows. *Temporal*: for units that hand off to a fresh agent, e.g.
  `implement-pr → review-pr → revise-pr`.

Overlay vs chain is *where the agent's context breaks* — and a performance call: shared-context units
must overlay, or you re-read context per chained workflow.

The CLI projects the stack 1:1 — each noun's verb is the arrow: `h template compose` (overlay),
`h workflow run` (execute), `h chain run` (chain — an ordered expression of `-w KEY` / `-t ATOM…`
members with position-scoped per-member flags; `--parallel`/`--stage` group a concurrent stage,
`--inline`/`--cron` make a member embedded/recurring, `--id`/dotted `--input` namespace the threading;
a `-t` group overlays inline, composed-on-fire).

## Execution substrates

The stack above says how work is COMPOSED. It says nothing about what executes it — and h has two
executors for the one composition. Picture:
[execution-substrates-c4-container](./docs/diagrams/execution-substrates-c4-container.md).

| | **Service substrate** (default) | **Local substrate** (`--local`, `h delegate`) |
| --- | --- | --- |
| Executes | Dapr workflow engine in workflow-svc | the `h` CLI's own process |
| Agents | containerised fleet, dropped uid | agent CLIs as child processes, as the OPERATOR |
| Needs | Dapr, Redis, the services | a built workspace and authenticated CLIs |
| Durability | survives process death, machine death | dies with the process |
| Engines | watcher, chain, cron, sched | none — the driver is the supervisor |

**The definition is the seam.** A template renders to `{params, steps, outputs}`, and that same
artifact is either POSTed to workflow-svc or handed to the local runner on stdin. Symmetry is
STRUCTURAL: the definition shapes and the semantics that give them meaning — `$ref`/`{{token}}`
resolution, the output contract, chain threading contracts, stage arithmetic — live once in
`packages/js/workflow-core` and are imported by both, with `scripts/check-runtime-parity.mjs`
failing the build if either grows a private copy. (It found two live drifts the day it was added.)

**The engines are what does not transfer, and that is the load-bearing invariant restated.** They
exist precisely so a workflow never supervises, sequences or recurs itself; run in-process, the
driver IS the supervisor, so there is nothing for them to be. The local substrate therefore
REFUSES what needs them — by name, never by silently skipping: the machinery flags
(`--cron/--watch/--budget/--retry/--at/--in/--fallback-*/--fresh/--via`, plus a chain's `--after`
and cron members) and the engine/registry/cluster activities (`register-cron`, `write-wf-row`,
`register-discover`, `run-itest`, the service-only agents). A silently-skipped `register-cron`
would report a recurrence that was never armed.

**Choose by lifetime, not by weight.** Unattended, recurring, long-horizon or supervised work
belongs on the service substrate however heavy it feels; work you are sitting and waiting on
belongs on the local one. They compose rather than compete: a local agent inherits the repo's
MCP config and can fire durable workflows onto a running service stack — triggers are data, so
nothing cares who fired them. Local execution does not lack access to durability; it lacks
durability of its own. Two asymmetries follow from having no engines and no containers: there is
no cost fence (the run ledger both substrates write is the only accounting), and there is no
process isolation (`--worktree`/`--plan` contain the blast radius; neither is a sandbox).

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
  step the agent is sovereign; between steps h is.
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
- **A shared core is a package, and it is pure by the same rule.** When domain logic is needed by
  more than one host it moves to `packages/js/*` and the hosts import it — `workflow-core` (what a
  definition MEANS) and `engine-core` (rows, ports, `decide`, the per-tick scans). Such a package
  has no `domain/` directory because it is domain all the way down, so it carries its own
  dependency-cruiser config asserting the same purity. The corollary is the useful one:
  **workflow-svc has no `domain/` at all** — its domain is `engine-core`, and what remains is
  adapters, routers and a composition root. Domain logic sitting in one app's `domain/` that a
  second host needs is a boundary problem that has not surfaced yet.

The dependency arrow always points *into* the domain. Enforcement is part of `make lint`:
[`dependency-cruiser`](./.dependency-cruiser.cjs) for the TS services (`bun run lint` per package)
and `import-linter` contracts (the `[tool.importlinter]` blocks in each hex agent's `pyproject.toml`)
for the Python agents — the same invariants expressed in each stack's dialect. A new hex service
inherits the TS rules for free; a new Python hex agent adds its own contract block.

Runtime detail, gotchas, and app layouts: [CLAUDE.md](./CLAUDE.md). The CLI: [cli/README.md](./cli/README.md).
