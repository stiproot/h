# cli — early prototyping of the h CLI

This directory is the incubator for what will eventually become the h CLI. Nothing here is
the final tool; it is the machinery the CLI will be built from, kept runnable at every step.

Two workflow-construction strategies co-exist, deliberately — and the `h` command wraps them:

```
cli/
├── scripts/    # strategy 1 — shell + envsubst/jq task payloads (the original design)
│   ├── run-*.sh                    # start each service under a dapr sidecar
│   ├── invoke-workflow-*.sh        # seed a task / POST a definition, then trigger + poll
│   ├── payloads/                   # task + workflow definitions (see payloads/README.md)
│   ├── _lib.sh · _workflow.sh      # shared shell helpers (idempotent restarts, submit/poll)
│   └── _render.sh                  # shared chart-rendering helpers (strategy 2's entrypoint)
├── charts/     # strategy 2 — helm as a client-side templating engine
│   └── workflows/                  # one chart; one template per workflow family
│       ├── values.yaml             # defaults; values.local.yaml (gitignored) for org overrides
│       ├── values.schema.json      # shape validation of inputs
│       └── templates/
│           ├── _helpers.tpl        # h.token (engine-token emitter), h.setupSteps
│           └── feature.yaml        # worktree → setup → plan → implement
└── h/          # the CLI itself — Python (Typer + rich), a uv workspace member
    └── src/h_cli/
        ├── main.py                 # composition root — Typer app, command groups
        ├── config.py               # env-derived settings, mirroring the scripts' defaults
        ├── commands/               # h feature (render/run [--agent]), h workflow (list/get/status/publish/run/terminate)
        └── infrastructure/         # helm subprocess adapter, statestore/agent/svc HTTP clients
```

## Strategy 1 — scripts + payloads

Plain-English tasks (or explicit step-sequenced definitions) live in `scripts/payloads/`;
`invoke-workflow-agent.sh` renders `${VARS}` with an envsubst allowlist, and the
workflow-agent *reasons* the task into a workflow. Multi-line content (feature specs) needs
a dedicated jq `--rawfile` wrapper (`invoke-workflow-feature-request.sh`).

## Strategy 2 — charts (helm as the templating engine)

`helm template` renders a workflow family's template into a concrete **run_workflow request
body**. No cluster involved — helm is used purely client-side. Construction becomes
deterministic; the workflow-agent's job narrows to run + monitor + self-heal.

**YAML is the canonical rendered artifact.** Conversion to JSON is a *final processing step*
(`yaml_to_json` in `scripts/_render.sh`), applied only at the wire boundary because today's
consumers (workflow-svc, workflow-mcp `run_workflow`) speak JSON. Nothing upstream assumes
JSON, so a future YAML-speaking consumer skips that step.

What the chart machinery buys over envsubst/jq:

- `--set-file feature.spec=<path.md>` — arbitrary multi-line Markdown injected safely; no
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
helm template feature cli/charts/workflows -s templates/feature.yaml \
  --set feature.slug=dark-mode --set-file feature.spec=./dark-mode.md
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
uv run h feature run <spec> --agent claude-agent   # render → agent's POST /workflow (babysat, non-blocking)
uv run h workflow list|get|status         # read-side views over workflow-svc
uv run h workflow publish <family>        # render publish-mode ({{params.*}} slots) → save_workflow
uv run h workflow run <key> -p k=v [-p spec=@file] [--instance-id id] [--agent name]  # fire a family
uv run h workflow terminate <instanceId>  # short-circuit a running instance
```

Helm is invoked as a subprocess (arg-list, no shell) — the established wrapper pattern
(helmfile does the same); the charts stay the single templating engine for both the shell
and Python paths, and `h feature render` is verified to produce output structurally
identical to `_render.sh`. The YAML-canonical / JSON-at-the-wire layering carries over
verbatim (`infrastructure/helm.py: render_workflow` vs `to_wire_json`).

### Tests (`cli/h/tests/`)

```sh
uv run --package h-cli pytest              # from the repo root (or `uv run pytest` in cli/h)
uv run --package h-cli pytest --snapshot-update   # re-bless goldens after INTENTIONAL chart changes
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
for the known workflow families, free-form tasks for everything else, with the
render → (optional) wire-format → seed → trigger → observe pipeline as subcommands.
`h feature` is the first slice; each shell script remains the executable spec for its flow
until the corresponding subcommand has demonstrably replaced it.
