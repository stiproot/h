# execution-substrates-c4-container — one composition, two executors

h composes work ONE way and executes it TWO ways. The `h` CLI renders a template into a workflow
definition — `{params, steps, outputs}` — and then either fires that definition at workflow-svc
(the SERVICE substrate: Dapr engine, agent fleet, registries, supervision) or executes it in its
own process (the LOCAL substrate: agent CLIs as child processes, no infrastructure at all).

This diagram exists to answer the question that kept getting answered in prose: *what actually
differs between them, and how do they relate?* The service side is drawn in full in
[system-c4-container](./system-c4-container.md) — it is collapsed here to one box on purpose. One
local run step by step: [local-run-sequence](./local-run-sequence.md).

```mermaid
C4Container
  title h — the two execution substrates

  UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="2")

  Person(op, "Operator", "terminal, or a Claude session")
  Container(hcli, "h CLI", "Python + helm", "template ⊕ overlay → workflow definition")

  Container_Boundary(localsub, "LOCAL substrate — the operator's own machine") {
    Container(runner, "h-local runner", "TypeScript/Node.js", "Walks the steps in-process. The driver IS the supervisor.")
    Container(dclis, "agent CLI children", "claude / codex / pi / openhands", "One child per step, running AS THE OPERATOR")
    Container(ehost, "engine host", "h-local --engines", "Holds the tick, runs the SAME five decide functions. KV-lease singleton.")
    ContainerQueue(nats, "event fabric", "nats-server -js", "h-tasks / h-results / h-journal + the KV registries")
  }

  Container_Boundary(svc, "SERVICE substrate — durable and supervised") {
    Container(wfsvc, "workflow-svc + Dapr", "TypeScript", "Hosts the engines: supplies adapters, runs the scans on the Dapr tick")
    Container(fleet, "agent fleet + MCP servers", "containers", "Containerised agents under a dropped uid")
  }

  Container(core, "workflow-core", "shared package", "What a DEFINITION means: $ref/token resolution, the output contract, stage arithmetic")
  Container(ecore, "engine-core", "shared package", "What an ENGINE decides: the rows, the ports, the five pure decide functions, the per-tick scans")
  Container(ledger, "run ledger", "shared filesystem", "summary.json / events.jsonl / output.txt per agent run")

  Rel(op, hcli, "h workflow run · h chain run · h delegate")
  Rel(hcli, runner, "--local: the definition, on stdin")
  Rel(hcli, wfsvc, "default: the SAME definition, POSTed")
  Rel(runner, dclis, "spawn (agent-cli)")
  Rel(wfsvc, fleet, "sidecar invoke")
  Rel(dclis, wfsvc, "may fire DURABLE work (workflow-mcp)")
  Rel(runner, core, "imports")
  Rel(wfsvc, core, "imports")
  Rel(ehost, ecore, "imports")
  Rel(wfsvc, ecore, "imports")
  Rel(ehost, nats, "reads/writes KV rows")
  Rel(runner, nats, "journals each step/stage")
  Rel(runner, ledger, "writes")
  Rel(fleet, ledger, "writes")

  UpdateElementStyle(runner, $bgColor="#2e7d32", $borderColor="#1b5e20")
  UpdateElementStyle(dclis, $bgColor="#2e7d32", $borderColor="#1b5e20")
  UpdateElementStyle(ehost, $bgColor="#2e7d32", $borderColor="#1b5e20")
  UpdateElementStyle(nats, $bgColor="#2e7d32", $borderColor="#1b5e20")
  UpdateElementStyle(core, $bgColor="#6a1b9a", $borderColor="#4a148c")
  UpdateElementStyle(ecore, $bgColor="#6a1b9a", $borderColor="#4a148c")
  UpdateRelStyle(dclis, wfsvc, $textColor="#b26a00", $lineColor="#b26a00", $offsetY="-10")
  UpdateRelStyle(op, hcli, $offsetY="-40", $offsetX="-30")
  UpdateRelStyle(runner, core, $textColor="#6a1b9a", $lineColor="#6a1b9a", $offsetX="-40")
  UpdateRelStyle(wfsvc, core, $textColor="#6a1b9a", $lineColor="#6a1b9a")
  UpdateRelStyle(ehost, ecore, $textColor="#6a1b9a", $lineColor="#6a1b9a", $offsetX="-40")
  UpdateRelStyle(wfsvc, ecore, $textColor="#6a1b9a", $lineColor="#6a1b9a")
```

## Reading notes

- **The two purple boxes are the whole symmetry claim, and there are two of them for a reason.**
  `workflow-core` owns what a DEFINITION means; `engine-core` owns what an ENGINE decides — the
  rows, the ports, the five pure `decide` functions and the per-tick scans. Both hosts import
  both, and `scripts/check-runtime-parity.mjs` fails the build if either grows a private copy.
  The split matters because it is what made the engine host possible at all: while the engines
  lived inside `apps/workflow-svc/src/domain/`, a second substrate could not reach them. That
  directory no longer exists — workflow-svc is adapters, routers and a composition root, which is
  the thesis stated structurally rather than argued.
- **workflow-svc is a HOST, not the owner of the engines.** It supplies one adapter set and runs
  the scans on the Dapr cron tick; `h-local --engines` supplies another and runs the same
  `decide` against KV rows. A pure decision found sitting in an `apps/*` domain folder that both
  hosts need is a parity bug that has not happened yet.
- **The local boundary now contains infrastructure, and that is the change.** It was once true
  that the local substrate simply had no engines. Today `h events up` brings up a nats-server
  with JetStream (three streams plus the KV registries) and the engine host beside it, so
  `--cron`, `--at`/`--in`, `--watch` and discovery fan-out all run here. What is still refused,
  and each names what it lacks rather than saying "not supported":
<!-- local-refusals:begin -->
  - `--retry` and `--fallback-*` — both RE-FIRE, which needs something that outlives the run, and
    nothing outlives a foreground shell.
  - `--via` — no agent service to route through. `--fresh` — no durable Dapr instance to purge.
<!-- local-refusals:end -->
  - `--budget` is NOT refused: the driver enforces it between steps. It declines to start more
    work past the deadline but cannot kill a running agent — `--timeout` bounds that instead, the
    same weaker-by-one-step rule the chain-wide budget applies between stages.
  - Activities: `run-itest` (needs an ephemeral k8s namespace and always will) and the
    service-only agents. `write-wf-row` and `register-cron` are refused for a DIFFERENT reason
    worth keeping straight — both are implemented here, but they are engine BRACKETS on either
    substrate, so a template naming one is a composition error, not a capability gap.
    `register-discover` is a builtin: `h cron discover add --local` runs the same one-step
    provision workflow, so the activity really does write the row.
  The refusals are classified `pending` vs `permanent` in `local-runtime/domain/activities.ts`,
  and `scripts/check-refusal-classification.mjs` fails the build if a refusal outlives the engine
  it was waiting for — which is why this list shrinks by deletion rather than by anyone
  remembering to revisit it.
- **The amber edge is the composition point** (and the answer to "can local agents create
  workflows in container mode?" — yes). A local agent inherits the repo's `.mcp.json` (local execution
  deliberately does not rewrite it), and compose publishes workflow-mcp on the same localhost port
  that file names. Triggers are data, so nothing cares who fired them. **Local execution does not lack
  access to durability; it lacks durability of its own.**
- **One ledger, both substrates.** `h runs`, obs-mcp and the viz read local runs beside service
  runs, because the ledger moved into its own package rather than staying inside the HTTP server.
  With no watcher on the local side, that ledger is also its ONLY cost accounting — which is why a
  cost the agent did not report shows as `—`, never as `$0`.
- **The security asymmetry is the boundary, read literally.** A fleet agent runs containerised
  under a dropped uid (`SUB_AGENT_UID`); a local agent runs as the OPERATOR, with their
  environment, credentials and checkout. `--worktree` and `--plan` contain the blast radius;
  neither is a sandbox.
- **Choose by lifetime, not by weight.** Work that must outlive the session, recur, or be
  supervised belongs on the service substrate however heavy it feels. Work you are waiting on
  belongs here.
