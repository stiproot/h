# h

A lab for experimenting with AI agent frameworks coordinated via [Dapr Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/). A generic workflow orchestrator sequences activities across multiple agents; each agent implements the same HTTP contract (`POST /run`, `POST /setup`, `GET /dapr/subscribe`) behind a Dapr sidecar, so any agent can be dropped into any workflow step.

The agents span several frameworks — Claude Code CLI, OpenHands, Dapr Agents SDK, raw Anthropic SDK, and Claude Managed Agents — demonstrating that the orchestration layer is framework-agnostic.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the foundational building blocks — the primitives, the
composition stack, and the design principles.

## Run modes

The same stack runs three ways. **Host and container are the defaults — neither needs Kubernetes,
and everything except the integration gate works in both.** Pick k8s mode only when you specifically
want to exercise the Kubernetes deployment path.

| Mode | What it is | Bring-up | Needs a cluster? |
| --- | --- | --- | --- |
| **Host** | App services on the host via `dapr run`; infra in Docker | `make infra-up && make up-host-wait` ([details](#running-in-host-mode-host-side-dapr-cli)) | No |
| **Container** | Everything in Docker Compose | `make up` ([details](#running-in-docker)) | No |
| **k8s (Tilt)** | Manifests deployed to k3d/Rancher Desktop | `make k3d-up && make dapr-install && make tilt-up` ([details](#running-in-kubernetes-tilt--optional-the-heavy-path)) | Yes |

The one capability exclusive to k8s mode is **`make itest`**, the integration gate — it deploys an
ephemeral `h-itest-<id>` namespace, so it needs k3d + Dapr. Unit tests (`make test`) and both lint
stacks (`make lint`) are fully available in host and container mode. See
[Dev commands](#dev-commands) for the test/lint entry points.

## Driving h — the `h` CLI

**`h` is the operator surface.** Once a stack is up, everything you do to the runtime — publish a
workflow, fire it, compose a chain, inspect the registries — goes through this one command. It
supersedes the older per-scenario `cli/scripts/invoke-workflow-*.sh` shell scripts, which remain
for reference (see [Shell scripts](#shell-scripts)).

```sh
uv sync --package h-cli     # once
uv run h --help
uv run h status             # one-screen check-in: chains, engine heartbeats, verdict OK/ATTENTION
```

| Command | What it does |
| --- | --- |
| `h workflow publish <template>` | render a chart template in publish mode (`{{params.*}}` slots) and save it |
| `h workflow run <key> [-p k=v]…` | fire a saved workflow. **Content** rides `-p`; **flags are machinery**: `--agent` (executor), `--model`, `--fresh`, `--instance-id`, `--at`/`--in` (schedule), `--cron` (arm a recurrence) |
| `h workflow status\|list\|get\|terminate` | read-side views over workflow-svc; short-circuit a running instance |
| `h workflow pause\|resume` | stop-and-continue on the preserved worktree |
| `h chain run --slug s -p spec=@f EXPR` | register a chain. `EXPR` is `-w KEY` / `-t ATOM…` members with per-member `--agent/--model/--kind/--stage` and `--capture/--input/--until` threading. Several `--agent` names panelize that member |
| `h template compose t1 t2 … [--save k]` | overlay templates into ONE definition |
| `h agents list\|deny\|allow\|budget` | the invokable agents and the executor policy |
| `h chain\|watch\|cron\|schedule list` | the durable registries + their scan heartbeats |

Two references, both worth having open:

- **[cli/README.md](./cli/README.md)** — the complete command reference, flag semantics, and the
  content-values-vs-machinery split that governs the whole surface.
- **[docs/cookbook.md](./docs/cookbook.md)** — **h BY EXAMPLE**: real, validated commands, each
  stamped with a date and the artifact it produced. Start here when you want a working invocation
  rather than a flag list. When an e2e validates a new composition, lift its command there.

## Agents

| Service | Framework | Notes |
| --- | --- | --- |
| `claude-agent` | Claude Code CLI | Full agentic coding loop; uses Tessl MCP for skill search |
| `openhands-agent` | OpenHands CLI | General-purpose coding agent |
| `pi-agent` | pi CLI (`@earendil-works/pi-coding-agent`) | Lean four-tool coding agent (Read/Write/Edit/Bash); BYOK across 20+ providers |
| `dapr-agent` | Dapr Agents SDK | ReAct tool loop via `OpenAIChatClient` → LiteLLM proxy |
| `dapr-claude-loop-agent` | Anthropic SDK | Self-contained tool-calling loop in Python; no Dapr Agents SDK |
| `claude-managed-agent` | Claude Managed Agents | Anthropic-native agent orchestration + Dapr Workflow |
| `langgraph-agent` | LangChain / LangGraph | Config-driven ReAct graph (`create_react_agent`) via `ChatAnthropic` → LiteLLM proxy; no Dapr Agents SDK |
| `workflow-agent` | Dapr Agents SDK | Cron-triggered orchestrator; builds/tests/persists/runs workflows via the workflows MCP |
| `codex-agent` | OpenAI Codex CLI | Lean coding agent; same Fastify + Dapr sidecar contract as claude-agent |
| `kimi-agent` | Claude Code CLI (Moonshot) | Anthropic-compat endpoint; claude CLI routed to Moonshot AI; opt-in profile |
| `stub-agent` | Deterministic stub (itest-only) | Canned structured output; no LLM, no secrets; used by the integration-test gate harness |

## Workspace layout

```
h/
├── apps/
│   ├── claude-agent/           # claude-agent — Claude Code CLI (Fastify + Dapr sidecar)
│   ├── openhands-agent/        # openhands-agent — OpenHands CLI (Fastify + Dapr sidecar)
│   ├── pi-agent/               # pi-agent — pi CLI (Fastify + Dapr sidecar)
│   ├── dapr-agent/             # dapr-agent — Dapr Agents SDK (FastAPI + Dapr sidecar)
│   ├── dapr-claude-loop-agent/ # dapr-claude-loop-agent — Anthropic SDK agentic loop + Dapr
│   ├── claude-managed-agent/   # claude-managed-agent — Claude Managed Agents + Dapr Workflow
│   ├── langgraph-agent/        # langgraph-agent — pure LangChain/LangGraph ReAct + Dapr
│   ├── workflow-agent/         # workflow-agent — Dapr Agents SDK orchestrator (cron-triggered)
│   ├── workflow-svc/           # workflow-svc — Dapr Workflow orchestrator
│   ├── workflow-mcp/           # workflow-mcp — MCP server exposing workflow tools to agents
│   ├── dapr-mcp/               # dapr-mcp — MCP server for Dapr state-store inspection
│   ├── obs-mcp/                # obs-mcp — read-only observability MCP (traces, logs, run ledger)
│   ├── codex-agent/            # codex-agent — OpenAI Codex CLI (Fastify + Dapr sidecar)
│   ├── kimi-agent/             # kimi-agent — Claude Code CLI × Moonshot (Fastify + Dapr sidecar)
│   └── stub-agent/             # stub-agent — deterministic itest-only agent (no LLM, Fastify + Dapr sidecar)
├── packages/            # shared libs, partitioned by language ecosystem
│   ├── js/              # TypeScript (npm workspace — root package.json)
│   │   ├── agent-cli/        # Shared agent invocation logic (CLI strategies, stream parsing)
│   │   ├── agent-server/     # Shared agent HTTP routes (run/setup/dapr-subscribe + opt-in clone) + run ledger
│   │   ├── core/             # Shared types (AgentRequest, AgentResponse)
│   │   ├── core-dapr/        # Dapr-specific shared types and helpers
│   │   ├── core-vercel/      # Vercel AI SDK client wrapper (ILlmClient → LiteLLM)
│   │   ├── local-runtime/   # Local execution substrate — agent CLIs as local child processes (`h delegate`), no Dapr/services
│   │   ├── logger/           # Pino logger wrapper
│   │   ├── run-ledger/       # The run ledger — per-run summary/events/output + statestore mirror; shared by every agent host
│   │   ├── workflow-core/    # Substrate-independent workflow semantics — definition shapes, $ref/{{token}} resolution, the output contract
│   │   └── telemetry/        # OTel/Zipkin tracing — makeTracingLive layer + W3C propagation helpers
│   └── py/              # Python (uv workspace — root pyproject.toml)
│       ├── agent-server/     # Shared FastAPI agent routes (run/setup/dapr-subscribe) + run ledger
│       └── agent-core/       # Shared agent machinery (ReAct loop, LLM adapters, workflow-mcp toolset)
├── dapr/                 # Dapr component YAMLs — Docker / docker-compose mode
│   └── host/             # Dapr component YAMLs — host mode via dapr CLI
├── k8s/                  # Kubernetes manifests — Tilt mode
│   ├── apps/             # App Deployments + Services
│   ├── dapr/             # Dapr Component / Resiliency / Configuration CRDs
│   ├── infra/            # Infrastructure (Redis)
│   └── secrets/          # Generated secrets (gitignored — see cli/scripts/gen-k8s-secrets.sh)
├── config/
│   ├── alloy/            # Grafana Alloy config (Docker log scraping → Loki)
│   ├── grafana/          # Grafana provisioning (Loki datasource)
│   └── loki/             # Loki config
├── cli/                  # The h CLI + charts + run scripts (see cli/README.md; examples: docs/cookbook.md)
│   ├── scripts/          # Run, test, and utility scripts (shell + payload strategy)
│   ├── charts/           # Helm-templated workflow definitions (client-side helm template)
│   └── h/                # The `h` command — Python (Typer + rich), uv workspace member
├── skills/               # Harness agent skills, copied into an agent's ~/.claude/skills at setup
│                         #   (linear, analyze-workflow-run, workflow-orchestrator, h-issues,
│                         #    author-workflow-template) — see CLAUDE.md "h skills"
├── docs/                 # Plans discipline (docs/plans/, archived under docs/plans/impl/),
│                         #   the h-builds-h runbook, DRIVER.md, and the validated-command cookbook
├── web/                  # EXPERIMENTAL runtime-viz sandbox (D3). Deliberately OUTSIDE the apps/*
│                         #   workspace glob — own package.json, `bun install` inside it. See web/README.md
├── scripts/              # Repo content guards run by `bun run lint` (check-*.mjs)
├── Tiltfile              # Tilt dev stack definition (k8s mode)
├── Makefile              # Lifecycle commands — see `make help`
├── turbo.json            # Turborepo pipeline (build ordering for workspace packages)
└── docker-compose.yml
```

Agent workspaces live outside the repo at `../h-workspace/` to prevent Claude Code from treating h as the project root. In Docker the equivalent is the `/workspace` volume; in Kubernetes it is a `hostPath` volume pointing to the same absolute path.

## Running in Kubernetes (Tilt) — optional; the heavy path

Runs `workflow` and `claude-agent` in a local Kubernetes cluster (Rancher Desktop) with Dapr installed via Helm. Tilt manages image builds, deployment, and port-forwards.

> **k8s mode is the resource-hungry option — budget for it.** On top of the cluster itself
> (k3s server + loadbalancer + registry), Tilt stamps a fresh immutable `tilt-<hash>` tag on every
> rebuild and **never collects the old ones**. The agent images are large (claude-agent ~2.8GB,
> openhands-agent ~2.0GB), so a machine that runs Tilt across a few sessions accumulates tens of GB
> of dead tags plus a build cache of the same order. Sweep it with **`make tilt-gc`** (see
> [Full teardown](#full-teardown)); `make itest-gc` does *not* cover Tilt's images. If the machine
> is short on disk or RAM, prefer [host mode](#running-in-host-mode-host-side-dapr-cli) or
> [container](#running-in-docker) mode — both run the same stack without a cluster.

### Prerequisites (one-time)

1. A Kubernetes cluster:
   - **macOS** — enable Kubernetes in Rancher Desktop (Settings → Kubernetes)
   - **Linux** — `make k3d-up` creates an equivalent k3d cluster in Docker. It also creates a
     cluster-attached **registry**, which is load-bearing: Tilt detects it via the standard
     `local-registry-hosting` ConfigMap and pushes images there. Without one, Tilt tries to push
     to Docker Hub and every build fails with `push access denied`.
2. Install [Tilt](https://docs.tilt.dev/install.html): `brew install tilt` (Linux: the release
   tarball; `kubectl`, `k3d` and `tilt` are all single static binaries needing no root)
3. Install Dapr control plane:
   ```sh
   make dapr-install
   ```

### Start / stop

```sh
# Generate k8s secrets from .env (re-run if .env changes)
./cli/scripts/gen-k8s-secrets.sh

make tilt-up    # opens Tilt UI at http://localhost:10350
make tilt-down  # tears down the app stack (Dapr control plane stays up)
```

See `make help` for all available targets.

### Port forwards (active while `tilt up` is running)

| Service | Host port | Target |
| --- | --- | --- |
| `workflow-svc` app | 8003 | pod:8000 |
| `workflow-svc` Dapr sidecar | 3503 | pod:3500 |
| `claude-agent` app | 8002 | pod:8000 |
| `redis` | 6379 | pod:6379 |

### Run a test

```sh
uv run h workflow publish answer
uv run h workflow run answer -p task='what services are in this repo?' --agent claude
```

See [Driving h — the `h` CLI](#driving-h--the-h-cli) and
[docs/cookbook.md](./docs/cookbook.md).

### Full teardown

```sh
make down             # tears down EVERYTHING, whichever mode you started
```

`make down` is mode-agnostic and safe to re-run from any state — host-mode services, Compose
infra, Tilt and the k3d cluster. Use it when you do not want to remember what you started.
The granular targets remain for partial teardown:

```sh
make tilt-down        # app stack only (Dapr control plane and cluster stay up)
make k3d-down         # delete the k3d cluster + its registry
make dapr-uninstall   # removes Dapr control plane + CRDs
make worktrees-purge  # remove worktrees cut by chain runs
make tilt-gc          # prune Tilt-pushed images older than 7d (TILT_GC_DAYS to override)
```

`make tilt-gc` is disk hygiene, not teardown — it is safe to run at any time, including while the
stack is up, since it only removes tags older than the cutoff. Tilt has no built-in image GC, so
without it the registry grows by one full agent image per rebuild, forever.

## Running in host mode (host-side dapr CLI)

Infrastructure runs in Docker; app services run on the host via `dapr run`.

### 1. Install dependencies

```sh
bun install --frozen-lockfile
```

### 2. Start infrastructure

```sh
cli/scripts/compose.sh -f docker-compose.yml -f docker-compose.host.yml --profile infra up -d
```

Starts `placement` (50006), `scheduler` (50007), `redis` (6379), `redis-commander` (16379), `zipkin` (9411), and the logging stack (Loki, Alloy, Grafana).

`docker-compose.host.yml` overrides the scheduler's broadcast address to `localhost:50007` so host-side `daprd` processes can reconnect after the initial handshake.

Tear down (always pass `-v` to clear the scheduler's etcd volume):

```sh
cli/scripts/compose.sh -f docker-compose.yml -f docker-compose.host.yml --profile infra down -v
```

### 3. Environment variables

Copy `.env.example` to `.env` and fill in the required values. Scripts source `.env` automatically.

In container mode, `.env` is the exclusive env source: always start compose via
`cli/scripts/compose.sh` (a `docker compose` pass-through that strips every key defined in `.env`
from the process environment first). Raw `docker compose` lets a var exported in your shell
profile silently shadow an edited `.env` on recreate — compose gives the process env precedence.

| Variable | Used by | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | all Python agents + claude-agent | Required |
| `LLM_API_KEY` | openhands-agent | Required |
| `TESSL_API_KEY` | agent scripts | Required for non-interactive `tessl install` in agent workspaces |
| `ANTHROPIC_BASE_URL` | all agents + Dapr conversation components | Required — no code default. The Anthropic-compatible endpoint (e.g. `https://api.anthropic.com` or your LiteLLM proxy) |
| `LLM_BASE_URL` | openhands-agent | Required — no code default. Usually the same proxy URL as `ANTHROPIC_BASE_URL` |
| `GH_TOKEN` | claude-agent | GitHub PAT for private-repo clones and worktree fetch (`git-core` injects it in-process; unset for public repos) |
| `LINEAR_API_KEY` | linear skill | Personal API key for headless Linear reads (`get-issue.sh`) and write-backs (`add-comment.sh`) |
| `NOTION_API_KEY` | claude-agent (notion MCP) | Notion PAT (`secret_…`); wired into the notion MCP server that claude-agent connects to — expires after 1 year |

### 4. Start services (separate terminals)

```sh
./cli/scripts/run-workflow-svc.sh
./cli/scripts/run-workflow-mcp.sh
./cli/scripts/run-dapr-mcp.sh
./cli/scripts/run-obs-mcp.sh
./cli/scripts/run-claude-agent.sh
./cli/scripts/run-openhands-agent.sh
./cli/scripts/run-pi-agent.sh
./cli/scripts/run-codex-agent.sh
./cli/scripts/run-kimi-agent.sh
./cli/scripts/run-dapr-agent.sh
./cli/scripts/run-dapr-claude-loop-agent.sh
./cli/scripts/run-claude-managed-agent.sh
./cli/scripts/run-langgraph-agent.sh
./cli/scripts/run-workflow-agent.sh
```

Not all services need to run simultaneously — start only what a given test requires.

Each `run-*.sh` runs in the **foreground** and blocks. For an interactive dev view use the
zellij layouts (`make dev` / `make dev-tab`) — one pane per service, for visualization.

#### Headless / agent-driven bring-up (no TTY, no zellij)

For an agent (or CI) that needs to stand the stack up **unattended** and know when it is ready,
use the detached launcher — the non-interactive sibling of `make dev`, reusing the same run
scripts, `stop_stale` idempotency, and `_supervise.sh` restart logic:

```sh
make up-host-wait            # infra-up → launch all services detached → block until every one is UP
make down-host               # stop them (leaves infra up; `make infra-down` stops infra)
# MODE=h-builds-h selects the supervised loop set instead of the full dev set
```

`make up-host` returns immediately (services run under `cli/scripts/_supervise.sh` in detached
process groups, logs → `.host-logs/<service>.log`); `make wait-host` gates readiness by
TCP-probing each service's app port. Service membership per mode lives in `cli/scripts/_services.sh`
(the single source of truth the launcher and the zellij layouts share — kept in step by
`scripts/check-services.mjs` at lint time). See docs/plans/impl/agent-host-mode-bringup.md.

### 5. Run a test

Use the [`h` CLI](#driving-h--the-h-cli) — publish a template, then fire it:

```sh
uv run h workflow publish answer
uv run h workflow run answer -p task='what services are in this repo?' --agent claude
uv run h status                       # engines ticking? chains active?
```

[docs/cookbook.md](./docs/cookbook.md) carries validated end-to-end invocations, chains included.

#### Shell scripts

`cli/scripts/invoke-workflow-*.sh` are **worked examples**, kept for reference. Each seeds a payload
and POSTs it, so it documents one scenario's exact wire shape — useful when debugging the edge or
authoring a new template. They are not the recommended driving surface: the CLI covers the same
ground with fire-time params, agent/model selection, chains, and the registries.

The set covers per-agent skill-discovery runs (`-skill-search-{claude,dapr,dapr-loop,langgraph}`),
multi-agent handoffs (`-hex-api-test`, `-hex-api-summary`), workflow persistence, a code review, and
the Linear grooming flow (`-grooming <ISSUE_ID> [context] [--dry-run]`, which reads a Linear issue,
analyses the worktree, resolves Notion links, and writes findings back as a comment). Run
`ls cli/scripts/invoke-workflow-*` for the current set; [cli/README.md](./cli/README.md) documents
the layering they sit in.

## Observability

`workflowInstanceId` ties every surface together — it's the workflow instance id, the default agent workspace key, a Zipkin span attribute, and the run-ledger group key.

- **Traces** → Zipkin (`http://localhost:9411`). All services report, W3C-propagated, so a run is one trace end-to-end (including cron-fired runs).
- **Run ledger** → every agent run writes `summary.json` (status, model, turns, tokens, cost, tool calls, sessionId), `events.jsonl`, and `output.txt` under `../h-workspace/.runs/<instanceId>/<agent>-<ts>/`, and mirrors a compact `run:<id>` record to the state store (so it's queryable via `dapr-mcp`).
- **Logs** → Loki (`http://localhost:3100`), Docker-infra only; host-run app logs aren't scraped — use traces + the run ledger.
- **From Claude Code** → opening the repo wires three MCP servers (`dapr`, `workflows`, `obs`) via root `.mcp.json`. The `obs` server (`run-obs-mcp.sh`, port 8013) exposes `trace_search`/`trace_get`, `logs_query`, `runs_list`/`run_get`, `system_overview`. Slash commands `/observe`, `/runs`, `/run`, `/trace`, `/logs`, `/workflow` and the `observe-h` skill drive them.

## Running in Docker

`cli/scripts/compose.sh` is `docker compose` with deterministic env — `.env` wins over shell
exports for every key it defines (see §3). Use it for every compose invocation.

| Command | What starts |
| --- | --- |
| `cli/scripts/compose.sh --profile all up --build` | Everything |
| `cli/scripts/compose.sh --profile infra up -d` | Dapr infra + logging stack only |
| `cli/scripts/compose.sh --profile claude-agent up --build` | claude-agent only |
| `cli/scripts/compose.sh --profile openhands-agent up --build` | openhands-agent only |
| `cli/scripts/compose.sh --profile pi-agent up --build` | pi-agent only |
| `cli/scripts/compose.sh --profile dapr-agent up --build` | dapr-agent only |
| `cli/scripts/compose.sh --profile dapr-claude-loop-agent up --build` | dapr-claude-loop-agent only |
| `cli/scripts/compose.sh --profile claude-managed-agent up --build` | claude-managed-agent only |
| `cli/scripts/compose.sh --profile langgraph-agent up --build` | langgraph-agent only |
| `cli/scripts/compose.sh --profile kimi-agent up --build` | kimi-agent only |
| `cli/scripts/compose.sh --profile workflow-agent up --build` | workflow-agent only |
| `cli/scripts/compose.sh --profile mcps up --build` | MCP servers only |

Tear down (always pass `-v`):

```sh
cli/scripts/compose.sh --profile all down -v
```

## Stack (Docker mode)

| Service | Image / build | Port(s) | Purpose |
| --- | --- | --- | --- |
| `placement` | `daprio/placement:edge` | `50006` | Actor placement – required for Dapr Workflows |
| `scheduler` | `daprio/scheduler:edge` | `50007` | Workflow scheduling; etcd volume at `./dapr-etcd/` |
| `redis` | `redis:7-alpine` | `6379` | State store and pub/sub broker |
| `redis-commander` | `ghcr.io/joeferner/redis-commander` | `16379` | Statestore web UI at `http://localhost:16379` |
| `zipkin` | `openzipkin/zipkin` | `9411` | Distributed traces – UI at `http://localhost:9411` |
| `loki` | `grafana/loki:3.0.0` | `3100` | Log aggregation backend |
| `alloy` | `grafana/alloy:latest` | — | Scrapes Docker container stdout → Loki |
| `grafana` | `grafana/grafana:latest` | `3000` | Log viewer – UI at `http://localhost:3000` |
| `workflow-svc` | local build | `8003` (app), `3503` (sidecar) | Dapr Workflow orchestrator |
| `workflow-mcp` | local build | `8005` (app), `3505` (sidecar) | Workflow MCP server |
| `dapr-mcp` | local build | `8011` (app), `3511` (sidecar) | Dapr state-store MCP server |
| `obs-mcp` | local build | `8013` (app, no sidecar) | Observability MCP – traces, logs, run ledger |
| `claude-agent` | local build | `8002` (app), `3502` (sidecar) | Claude Code CLI agent |
| `openhands-agent` | local build | `8004` (app), `3504` (sidecar) | OpenHands CLI agent |
| `pi-agent` | local build | `8015` (app), `3515` (sidecar) | pi CLI coding agent |
| `codex-agent` | local build | `8016` (app), `3516` (sidecar) | OpenAI Codex CLI agent |
| `kimi-agent` | local build | `8017` (app), `3517` (sidecar) | Claude Code CLI × Moonshot AI |
| `dapr-agent` | local build | `8006` (app), `3506` (sidecar) | Dapr Agents SDK ReAct loop |
| `dapr-claude-loop-agent` | local build | `8007` (app), `3507` (sidecar) | Anthropic SDK agentic loop |
| `claude-managed-agent` | local build | `8008` (app), `3508` (sidecar) | Claude Managed Agents |
| `langgraph-agent` | local build | `8009` (app), `3509` (sidecar) | LangChain/LangGraph ReAct agent |
| `workflow-agent` | local build | `8010` (app), `3510` (sidecar) | Dapr Agents SDK workflow orchestrator |

## Port allocation (host mode)

| Service | App port | Dapr HTTP | Dapr gRPC | Dapr internal gRPC |
| --- | --- | --- | --- | --- |
| `claude-agent` | 8002 | 3502 | 36002 | 61002 |
| `workflow-svc` | 8003 | 3503 | 36003 | 61003 |
| `openhands-agent` | 8004 | 3504 | 36004 | 61004 |
| `workflow-mcp` | 8005 | 3505 | 36005 | 61010 |
| `dapr-mcp` | 8011 (MCP) / 8012 (actor) | 3511 | 36011 | 61013 |
| `obs-mcp` | 8013 | — (no sidecar) | — | — |
| `dapr-agent` | 8006 | 3506 | 36006 | 61005 |
| `dapr-claude-loop-agent` | 8007 | 3507 | 36007 | 61014 |
| `claude-managed-agent` | 8008 | 3508 | 36008 | 61009 |
| `langgraph-agent` | 8009 | 3509 | 36009 | 61011 |
| `workflow-agent` | 8010 | 3510 | 36010 | 61012 |
| `pi-agent` | 8015 | 3515 | 36015 | 61016 |
| `codex-agent` | 8016 | 3516 | 36016 | 61017 |
| `kimi-agent` | 8017 | 3517 | 36017 | 61018 |
| `placement` | — | — | — | 50006 |
| `scheduler` | — | — | — | 50007 |

Every host-run service binds a unique set of ports, so any combination can run at once. All sidecars
pin a distinct `360xx` gRPC port and a `610xx` internal-gRPC port. On Linux (default ephemeral range
32768–60999), the `610xx` internal-gRPC ports sit above the ceiling and the kernel will not assign
them as ephemeral source ports — removing that exposure for internal-gRPC specifically. The `360xx`
sidecar API gRPC ports remain inside the Linux ephemeral range (residual exposure); setting
`net.ipv4.ip_local_reserved_ports` to cover all pinned ports is the mechanism that would close the
remaining gap. On macOS (ephemeral range 49152–65535) the `610xx` ports fall inside it, so the
residual applies there regardless. `50006`/`50007` (placement/scheduler) run inside containers and
are unaffected.
Each `cli/scripts/run-*.sh` also frees its own ports on start (see `stop_stale` in `cli/scripts/_lib.sh`),
so re-running a script cleanly replaces a prior instance.

## Dapr components

Three component directories — same logical components, different host addresses and secret store types:

| Directory | Used when |
| --- | --- |
| `dapr/` | Docker mode — service-name addresses (`redis:6379`), file-based secret store |
| `dapr/host/` | Host mode — `localhost` addresses, env-var secret store |
| `k8s/dapr/` | Kubernetes mode — service-name addresses, `secretstores.kubernetes` |

`dapr/host/appconfig.yaml` is the Dapr Configuration file passed to every host-mode `dapr run` via `--config`. In addition to Zipkin tracing it configures the **SQLite name resolver**, which replaces Dapr's default mDNS-based service discovery. mDNS is unreliable on macOS with Rancher Desktop; the SQLite resolver uses a shared file at `/tmp/dapr-h-nr.db` instead.

## Dev commands

Install dependencies:

```sh
bun install --frozen-lockfile
```

Build all workspace packages in dependency order (uses Turborepo):

```sh
bun run build
```

Per-package (run from the package directory):

```sh
bun run build    # tsc --project tsconfig.build.json
bun run lint     # tsc --noEmit + oxlint/oxfmt
bun run test     # vitest run
```

Run every unit test across both ecosystems with one command:

```sh
make test        # test-js (turbo → vitest) + test-py (pytest — all 7 suites). No cluster needed.
```

Python — workspace members (the shared `agent-server` / `agent-core` libs, the agent
apps `dapr-agent`, `dapr-claude-loop-agent`, `langgraph-agent`, `workflow-agent`, and
the `h` CLI at `cli/h`) share one root `uv.lock`; sync from the repo root. The
standalone `claude-managed-agent` syncs from its own directory:

```sh
uv sync --frozen                                  # whole workspace
uv run --package agent-core pytest                # agent-core unit tests (mirror of `bun run test`)
cd apps/claude-managed-agent && uv sync --frozen --no-dev
```

The `h` CLI (see [cli/README.md](./cli/README.md); **validated examples for every surface:
[docs/cookbook.md](./docs/cookbook.md)**):

```sh
uv run h --help                       # render/run chart-templated workflows, inspect workflow-svc
uv run h feature render <spec>        # canonical YAML; --json for the wire form
uv run h feature run <spec> --agent claude-agent   # render to RUN on that agent + submit (babysat, non-blocking)
uv run h workflow publish implement     # save the chart template with open {{params.*}} slots
uv run h workflow run implement -p slug=x -p spec=@f.md --agent claude --model <m>   # fire it — CONTENT values ride -p key=value; flags are machinery (--agent=executor, --model, --via=routing, --fresh, --instance-id)
uv run h workflow run implement -p slug=x --in 2h   # SCHEDULE it once (--at <iso> | --in <dur>) — arms a cron:sched row instead of firing now; inspect with `h schedule list`
uv run h workflow run implement -p slug=x --fallback-agent openhands --fallback-after 10m   # on a usage/rate limit, CONTINUE under a different agent after a delay (implies --watch)
uv run h workflow pause <instanceId> feature --in 30m   # stop-and-continue: terminate + arm a resume reusing the workspace; `h workflow resume <schedId>` fires it now
uv run --package h-cli pytest         # unit + golden-snapshot tests (requires helm for goldens)
```

### Git hooks

Install a local `pre-push` hook that runs the fast lint guards (no build/test,
so it stays under a few seconds):

```sh
make install-hooks    # sets core.hooksPath = scripts/hooks
```

After installation, `git push` will run `bun run lint` first and block the push
if any guard fails. Skip with `git push --no-verify` (emergency use only).

### CI

A GitHub Actions workflow (`.github/workflows/guards.yml`) runs the full guard
surface — lint, build, test, and the h CLI pytest suite — on every pull request
and push to `main`. Check the **guards** job status in the PR checks UI.

## Tooling

- **[Bun](https://bun.sh)** — package management and TypeScript execution
- **[Turborepo](https://turbo.build)** — workspace build orchestration (`turbo.json` defines the pipeline)
- **[oxlint](https://oxc.rs/docs/guide/usage/linter)** / **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)** — linting and formatting
- **[uv](https://docs.astral.sh/uv)** — Python package management (workspace declared in root `pyproject.toml`)
- **[Tilt](https://tilt.dev)** — Kubernetes dev loop (image build, deploy, port-forward)
- **[Helm](https://helm.sh)** — Dapr control plane installation (`make dapr-install`) and the client-side
  templating engine for workflow definitions (`cli/charts`, rendered by `h feature render` / `_render.sh`)
