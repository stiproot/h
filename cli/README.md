# cli — the h CLI

This directory is the h CLI and its supporting machinery. The `h` command (Typer + rich, a uv
workspace member — `uv run h --help`) is the established operator surface for the runtime:
templates, workflows, chains, watches, crons, and schedules. **Worked, validated examples of
every surface live in [docs/cookbook.md](../docs/cookbook.md)** — real commands with the date
and artifact each produced.

Two construction layers co-exist, deliberately — and the `h` command wraps them:

```
cli/
├── scripts/    # strategy 1 — shell + envsubst/jq task payloads (the original design)
│   ├── run-*.sh                    # start each service under a dapr sidecar
│   ├── invoke-workflow-*.sh        # seed a task / POST a definition, then trigger + poll
│   ├── payloads/                   # task + workflow definitions (see payloads/README.md)
│   ├── _lib.sh · _workflow.sh      # shared shell helpers (idempotent restarts, submit/poll)
│   └── _render.sh                  # shared chart-rendering helpers (strategy 2's entrypoint)
├── charts/     # strategy 2 — helm as a client-side templating engine
│   └── workflows/                  # one chart; one template file per workflow
│       ├── values.yaml             # defaults; values.local.yaml (gitignored) for org overrides
│       ├── values.schema.json      # shape validation of inputs
│       └── templates/
│           ├── _helpers.tpl        # h.token (engine-token emitter), h.setupSteps
│           └── feature.yaml        # worktree → setup → plan → implement
└── h/          # the CLI itself — Python (Typer + rich), a uv workspace member
    └── src/h_cli/
        ├── main.py                 # composition root — Typer app, command groups
        ├── config.py               # env-derived settings, mirroring the scripts' defaults
        ├── commands/               # h feature, h workflow (run/pause/resume/…), h template, h chain, h watch, h cron (list + discover add), h schedule (one-shot cron:sched: list/rm)
        └── infrastructure/         # helm subprocess adapter, statestore/agent/svc HTTP clients
```

## Strategy 1 — scripts + payloads

Plain-English tasks (or explicit step-sequenced definitions) live in `scripts/payloads/`;
`invoke-workflow-agent.sh` renders `${VARS}` with an envsubst allowlist, and the
workflow-agent *reasons* the task into a workflow. Multi-line content (feature specs) needs
a dedicated jq `--rawfile` wrapper (`invoke-workflow-feature-request.sh`).

## Strategy 2 — charts (helm as the templating engine)

`helm template` renders a workflow template into a concrete **run_workflow request
body**. No cluster involved — helm is used purely client-side. Construction becomes
deterministic; the workflow-agent's job narrows to run + monitor + self-heal.

**YAML is the canonical rendered artifact.** Conversion to JSON is a *final processing step*
(`yaml_to_json` in `scripts/_render.sh`), applied only at the wire boundary because today's
consumers (workflow-svc, workflow-mcp `run_workflow`) speak JSON. Nothing upstream assumes
JSON, so a future YAML-speaking consumer skips that step.

What the chart machinery buys over envsubst/jq:

- `--set-file implement.spec=<path.md>` — arbitrary multi-line Markdown injected safely; no
  escaping gymnastics.
- `required` + `values.schema.json` — hard errors with real messages at render time, instead
  of grepping rendered output for leftover `${`.
- `_helpers.tpl` — shared step fragments (setup block, engine-token emitter) defined once.
- Token coexistence — agent-side `$VARS`, engine-side `{{step.field}}` / `$ref`, and helm's
  own `{{ }}` never collide: `h.token` builds engine tokens with `printf`, and shell vars are
  inert text.

Try it:

```sh
# render only (inspect the YAML artifact)
cli/scripts/invoke-workflow-feature-helm.sh <spec>.md --render-only

# render, seed the task (definition embedded), trigger workflow-agent
cli/scripts/invoke-workflow-feature-helm.sh <spec>.md [SLUG=<slug>]

# or drive helm directly
helm template implement cli/charts/workflows -s templates/implement.tmpl.yaml \
  --set implement.slug=dark-mode --set-file implement.spec=./dark-mode.md
```

`invoke-workflow-feature-helm.sh` is the chart-strategy sibling of
`invoke-workflow-feature-request.sh` — same spec resolution and slug rules, different
construction strategy. Org-specific defaults (real repo paths, model ids) belong in the
gitignored `charts/workflows/values.local.yaml`.

## The `h` CLI (`cli/h/`)

The scaffold of the tool both strategies converge into: Python, **Typer + rich**, installed
editable as a uv workspace member — so from the repo root:

```sh
uv sync --package h-cli        # once
uv run h --help
uv run h feature render <spec>            # canonical YAML artifact
uv run h feature render <spec> --json     # wire-format edge applied
uv run h feature run <spec> [--slug s]    # render → seed → trigger workflow-agent (legacy, blocking)
uv run h feature run <spec> --agent claude-agent   # render to RUN on that agent + submit (babysat, non-blocking)
uv run h template compose t1 t2 ... [--save key]   # overlay templates → ONE definition (spatial)
uv run h template list|get <t>            # the chart templates (overlay atoms)
uv run h agents list                      # the workflow-invokable agents + their {runActivity, agentId}
                                          # identities — i.e. what `--agent <name>` accepts
uv run h workflow list|get|status         # read-side views over workflow-svc
uv run h workflow publish <template>        # render publish-mode ({{params.*}} slots) → save_workflow
uv run h workflow run <key> [-p k=v]... [--agent A] [--model M] [--fresh] [--instance-id id] [--via name] [--cron CADENCE] [--max-fires N]  # fire a template — CONTENT values ride -p key=value; flags are machinery (--agent=executor, --model, --via=routing); --cron arms a recur cron on the RUN (§10 arm-* activity, not the handler)
uv run h workflow run <template> --inline [-p k=v]...   # operands are chart TEMPLATES, not a saved key: render and fire, no publish
uv run h workflow run implement verify create-pr --inline -p slug=x -p spec=@s.md  # SEVERAL overlay into ONE workflow (composable mode) — no --save needed
uv run h workflow terminate <instanceId>  # short-circuit a running instance
uv run h workflow run <key> --at <iso> | --in <dur>  # SCHEDULE the fire instead of firing now (arms a cron:sched one-shot)
uv run h workflow pause <instanceId> <key> --in <dur>  # terminate the run + arm a continuation reusing its workspaceId
uv run h workflow resume <schedId>        # fire a paused/scheduled continuation NOW
                                          # pause/resume is stop-and-continue: the continuation re-enters the
                                          # workflow FROM STEP 1 on the preserved worktree — not a frozen fiber
uv run h workflow run <key> --fallback-agent A [--fallback-model M] [--fallback-after DUR] [--fallback-max N]
                                          # on a usage-limited outcome, arm a deferred continuation under another identity
uv run h chain run --slug s -p spec=@f EXPR # register a chain (temporal); values ride -p; EXPR: -w KEY | -t ATOMS...
                                          #   with per-workflow --agent/--model/--fresh/--kind flags and structured-output
                                          #   threading mappings --capture BB=FIELD / --input PARAM=BB / --until PATH=VALUE
                                          #   (validated against the workflow's declared outputs schema at registration)
uv run h chain list                       # the durable chain registry + scan heartbeat
uv run h watch list|get|delete            # the watcher registry
uv run h cron list                        # the cron registry — recur crons + discovery/fan-out crons, with the scan heartbeat
uv run h cron rm <repo> <slug> <workflow>  # disarm a recur cron: set inactive+disabled, keep row for audit (idempotent; calls POST /cron/disarm — single-writer)
uv run h cron discover add <repo> --label L --cadence C [--workflow feature-pr] [--max-per-day N] [--run-budget-mins M] [--run-retries K] [-p k=v]  # arm a discovery cron: fires a provision workflow whose register-discover activity writes cron:discover (§10 — no POST /cron/discover). Each due tick fans out one <workflow> per newly-labeled issue, deduped vs wf:*; --run-budget-mins supervises each fired run
uv run h status [--json]                  # one-screen driver check-in: active chains, engine heartbeats (stale >5m flagged), verdict OK / ATTENTION
uv run h worktrees list [--json] [--repo PATH]  # both substrates' leftovers: prune + list, status graded dirty (tracked edits) / scratch (untracked only) / unpushed
uv run h worktrees rm BRANCH [--force] [--prune-untracked]    # remove one worktree + its branch; REFUSES while dirty or unpushed unless forced
uv run h worktrees sweep [--dry-run] [--force] [--prune-untracked]  # batch form: classify, skip the unsafe, report removed N / skipped M
#   --force discards tracked edits AND unpushed commits; --prune-untracked discards only files git
#   never tracked, naming each one first. Two flags because they accept different classes of loss —
#   and the narrow one is what reclaims a finished agent worktree held open by a leftover scratch file.

# ---- the LOCAL execution substrate: the same composition, executed in THIS process ----
# No Dapr, no services, no containers. Prerequisite: `bun run build`, plus CLIs you have
# already authenticated (credentials come from your shell, with the repo .env filling gaps).
uv run h delegate "TASK" --agent codex    # the atom: one task, one agent CLI as a local child process
uv run h delegate "TASK" --agent claude --agent codex   # a roster answers in parallel (no synthesis — see below)
uv run h delegate "TASK" --agent codex --worktree       # cut an isolated worktree per agent for WRITE work
uv run h workflow run <template> --local [-p k=v]...   # render the template and execute its steps here
uv run h workflow run answer --local --agent claude --agent codex   # a judged panel, nothing running
uv run h chain run --slug s --local EXPR # sequence the stages in-process; BLOCKS, prints the threaded chain data
                                          # --with-setup opts into the definition's setup steps (skipped by

# ---- the local substrate's EVENT FABRIC (POC): NATS JetStream + the relay ----
# One nats-server -js child (operator-installed binary; JetStream store beside the run ledger).
uv run h events up|down|status            # manage the fabric; status shows stream depths + relay consumers
uv run h events publish --max-steps N -p task=@t.md [--template answer] [--agent claude]  # seed a loop (budget MANDATORY)
uv run h events serve                     # the relay: compose-on-fire -> local executor -> forward the agent's publish hand-off
uv run h events tail 'h.result.>'         # watch loop terminals live (plain subscription, consumes nothing)
                                          #   default: they provision YOUR ~/.claude, not a container's)
                                          # flags needing an engine (--cron/--watch/--at/--in/--fallback-*/
                                          #   --fresh/--via, and a chain's --after) are REFUSED BY NAME
```

Helm is invoked as a subprocess (arg-list, no shell) — the established wrapper pattern
(helmfile does the same); the charts stay the single templating engine for both the shell
and Python paths, and `h feature render` is verified to produce output structurally
identical to `_render.sh`. The YAML-canonical / JSON-at-the-wire layering carries over
verbatim (`infrastructure/helm.py: render_workflow` vs `to_wire_json`).

### Tests (`cli/h/tests/`)

```sh
uv run --package h-cli pytest cli/h/tests   # from the repo root (or `uv run pytest` in cli/h)
uv run --package h-cli pytest cli/h/tests --snapshot-update   # re-bless goldens after INTENTIONAL chart changes
```

Layered: pure units (slug/spec resolution, wire edge) → respx-mocked statestore contract →
CliRunner behavior (exit codes, parseable output) → **golden snapshots of the rendered
workflow** (`tests/__snapshots__/`, via syrupy). The goldens are the chart's contract tests:
they render `tests/fixtures/hostile.md` — every token class that must survive (`$VARS`,
`{{engine.tokens}}`, quotes, backslashes) — hermetically from chart defaults
(`include_local=False`), in both the canonical YAML and wire-JSON forms, so any template
change surfaces as a reviewable diff. Golden tests skip when helm is absent; re-blessing is
a deliberate, reviewed act — never automate `--snapshot-update`. Rich presentation (tables,
spinners) is deliberately *not* snapshotted: assert behavior, not box-drawing characters.

## Where this is heading

The CLI subsumes both strategies one vertical slice at a time: chart-rendered definitions
for the known workflow templates, free-form tasks for everything else, with the
render → (optional) wire-format → seed → trigger → observe pipeline as subcommands.
`h feature` is the first slice; each shell script remains the executable spec for its flow
until the corresponding subcommand has demonstrably replaced it.
