# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [README.md](./README.md) for stack overview, local dev setup, component reference, and tooling.
See [WORKFLOWS.md](./WORKFLOWS.md) for available workflow patterns and their `invoke-workflow-*` scripts.
See [cli/README.md](./cli/README.md) for the local tooling — `cli/` is the early prototype of the
h CLI: the run/invoke shell scripts (`cli/scripts/`), the helm-templated workflow definitions
(`cli/charts/`), and the `h` command itself (`cli/h/`, Typer + rich, a uv workspace member — `uv
run h --help`). The two construction strategies co-exist deliberately.

## App layouts

```
apps/claude-agent/src/                    # claude-agent
├── index.ts                              # composition root – registers shared agent-server routes + /clone + /worktree, starts Fastify
├── steering/h-lab-runtime.md         # h runtime steering (the MCP set + how to use it); a triage setup step copies it to the agent's ~/.claude/CLAUDE.md
├── infrastructure/mcp-config.ts          # mergeMcpConfig – merge h's MCP servers into the cwd's existing .mcp.json (pure, value-tested)
└── infrastructure/claude-runner.ts       # IAgentRunner impl; honours an optional cwd (e.g. a worktree); merges MCP config into cwd; routes (/run, /setup, /clone, /worktree, /dapr/subscribe) come from agent-server

apps/openhands-agent/src/                 # openhands-agent
├── index.ts                              # composition root – registers shared agent-server routes, starts Fastify
└── infrastructure/openhands-runner.ts    # IAgentRunner impl; /run, /setup, /dapr/subscribe come from agent-server

apps/dapr-agent/src/                      # dapr-agent (thin wrapper over agent-core)
├── main.py                               # composition root – registers shared agent-server routes; opt-in workflow orchestration when WORKFLOWS_MCP_URL is set (merges the workflow toolset + appends the workflow-orchestrator skill)
├── infrastructure/dapr_agent_runner.py   # IAgentRunner impl – delegates to agent_core's ReAct loop (OpenAIChatAdapter); merges the workflow-mcp toolset when enabled
└── infrastructure/tools.py               # search_skills, install_skill, read_skill, write_file
                                          # /run, /setup, /dapr/subscribe come from agent_server (packages/py)

apps/dapr-claude-loop-agent/src/          # dapr-claude-loop-agent
├── main.py                               # FastAPI composition root – registers shared agent-server routes
├── infrastructure/claude_loop_runner.py  # Anthropic SDK agentic loop (tool-calling)
└── infrastructure/tools.py               # search_skills, install_skill, read_skill, write_file
                                          # /run, /setup, /dapr/subscribe come from agent_server (packages/py)

apps/claude-managed-agent/src/            # claude-managed-agent
└── main.py                               # Claude Managed Agents + Dapr Workflow integration

apps/langgraph-agent/src/                 # langgraph-agent (pure LangChain/LangGraph)
├── main.py                               # FastAPI composition root – bespoke routes + shared setup/subscribe
├── infrastructure/graph_builder.py       # build_react_agent – config → LangGraph create_react_agent
├── infrastructure/langgraph_runner.py    # IAgentRunner adapter – builds graph, ainvoke, extract output
├── infrastructure/tools.py               # tool registry (search_skills, install_skill, read_skill, write_file)
├── infrastructure/preset_store.py        # named graph configs as JSON under AGENT_BASE_DIR/presets/
├── domain/models.py                      # GraphConfig + AgentRequest (extends agent_server.AgentRequest)
└── presentation/http/run_router.py       # register_langgraph_routes – bespoke POST /run, POST /save
                                          # /setup, /dapr/subscribe come from agent_server (packages/py)

apps/workflow-agent/src/                  # workflow-agent (thin wrapper over agent-core)
├── main.py                               # FastAPI composition root; system prompt loaded from the workflow-orchestrator skill (agent_core.load_skill_instructions; AGENT_SYSTEM_PROMPT overrides)
├── infrastructure/workflow_agent_runner.py  # IAgentRunner impl – delegates to agent_core's ReAct loop over the workflow-mcp toolset
├── infrastructure/statestore.py          # task read-write via Dapr state API
└── presentation/http/cron_router.py      # POST /cron-tick (cron binding target), POST /run, GET /dapr/subscribe (plugin-feedback), POST /plugin-feedback (seeds a plugin-improvement task)

apps/workflow-svc/src/
├── index.ts                                          # registers workflow + activities + cron route, starts Fastify
├── domain/
│   ├── models/workflow.model.ts                      # WorkflowRequest, StoredWorkflow (+ schedule/disabled), WorkflowSchedule, toRequest
│   ├── ports/{IWorkflowInvoker,IWorkflowStore}.ts    # outbound ports
│   └── scheduling.ts                                 # isDue / assertValidCron (cron-parser) – pure, unit-tested
├── presentation/http/
│   ├── workflow.router.ts                            # POST /workflow/run, /save (accepts schedule+workspaceId), /run/:key
│   │                                                 # GET /workflow/list, /get/:key, /status/:instanceId
│   └── cron.router.ts                                # POST /workflow-cron-tick (cron binding target) – fires due saved workflows
├── infrastructure/
│   ├── dapr-workflow-invoker.ts                      # DaprWorkflowClient wrapper
│   ├── dapr-workflow-store.ts                        # saved-workflow store (Redis): save/get/list/listScheduled/markRun
│   ├── activity-registry.ts                          # maps activity name → function
│   └── activities/
│       ├── setup.activity.ts                         # calls /setup on a target agent via Dapr invoke
│       ├── clone-repo.activity.ts                     # calls /clone on claude-agent via Dapr invoke (git-core)
│       ├── create-worktree.activity.ts                # calls /worktree on claude-agent; returns the run-specific worktree path for downstream steps' cwd
│       ├── run-{claude,openhands,dapr-agent,dapr-claude-loop,claude-managed,langgraph}.activity.ts  # call /run on each agent
│       └── copy-session.activity.ts                  # copies agent workspace output to ./output/
└── infrastructure/workflows/
    └── generic.workflow.ts                           # step-sequencing workflow with $ref resolution; injects workflowInstanceId + workspaceId

apps/obs-mcp/src/                         # obs-mcp – read-only observability MCP (no Dapr sidecar; port 8013)
├── index.ts                              # composition root – Fastify/MCP; reads ZIPKIN_URL, LOKI_URL, RUNS_DIR
├── domain/ports/IObservabilityService.ts # outbound port – traces, logs, run ledger
├── infrastructure/observability-service.ts # Zipkin (HTTP) + Loki (HTTP) + run-ledger (fs) reader
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: trace_search, trace_get, logs_query,
                                          #          runs_list, run_get, system_overview

apps/workflow-mcp/src/                   # workflow-mcp – MCP server for agents
├── index.ts                              # composition root
├── infrastructure/dapr-workflow-service.ts  # calls workflow service via Dapr invoke
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: save_workflow, run_workflow, run_saved_workflow,
                                          #          list_workflows, get_workflow, get_workflow_status,
                                          #          await_workflow (block until terminal, else TIMEOUT)

apps/dapr-mcp/src/                        # dapr-mcp – MCP server for Dapr state stores + actors + pub/sub
├── index.ts                              # composition root – starts GenericActor host, then Fastify/MCP
├── domain/ports/
│   ├── IStateStore.ts                    # outbound port – state store
│   ├── IActorStore.ts                    # outbound port – actor management
│   └── IPubSub.ts                        # outbound port – publish to a topic
├── infrastructure/
│   ├── dapr-state-store.ts               # Dapr state HTTP API (get/getBulk/save/delete)
│   ├── dapr-actor-store.ts               # actor adapter – delegates to core-dapr GenericActorClient
│   └── dapr-pubsub.ts                    # pubsub adapter – delegates to core-dapr DaprPublisher
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: state_get, state_get_bulk, state_save, state_delete,
                                          #          pubsub_publish,
                                          #          actor_invoke, actor_state_{get,set,delete,keys},
                                          #          actor_{reminder,timer}_{register,unregister}, actor_list_active

packages/js/agent-cli/src/
├── index.ts       # exports all strategies
├── invoker.ts     # spawns CLI subprocess, pipes stdout/stderr, streams events
└── agents/
    ├── claude.ts      # ClaudeStrategy – claude CLI flags, JSONL stream parser
    ├── openhands.ts   # OpenhandsStrategy – openhands CLI flags, per-line stdout parser with onEvent callback
    ├── shared.ts      # shared env helpers
    └── types.ts       # AgentInvoker, AgentEnv/AGENT_ENV_KEYS, LlmConfig, ModelUsage, strategy contracts

packages/js/agent-server/src/                # shared HTTP contract for agent services
├── index.ts          # re-exports
├── agent-routes.ts   # registerAgentRoutes – POST /run, POST /setup, GET /dapr/subscribe (workspace dir via resolver, or an explicit cwd e.g. a worktree; /setup idempotent via spec-hash sentinel)
├── clone-route.ts    # registerCloneRoute – opt-in POST /clone (shallow git clone into the workspace)
├── worktree-route.ts # registerWorktreeRoute – opt-in POST /worktree (git worktree of a pre-cloned repo at a shared, agent-neutral path; idempotent; returns { worktreePath })
├── run-ledger.ts     # startRunLedger – per-run summary.json/events.jsonl/output.txt under RUNS_DIR + statestore mirror
└── runner.ts         # IAgentRunner port (run request → response)

packages/js/core/src/
├── index.ts               # re-exports
└── types/agent.ts         # AgentRequest (+ workspaceId), AgentResponse (+ costUsd, toolCalls, runId)

packages/js/core-dapr/src/
├── index.ts               # re-exports
├── invoker.ts             # DaprInvoker – typed wrapper over the Dapr sidecar invoke HTTP API
├── publisher.ts           # DaprPublisher – pub/sub publish over the sidecar HTTP API (traced)
└── actors/                # reusable Dapr actor SDK machinery (consumed by dapr-mcp)
    ├── generic-actor.ts   # GenericActor extends AbstractActor – KV state, invoke commands, reminders/timers
    ├── actor-host.ts      # createActorHost – DaprServer registration + start ordering
    ├── actor-client.ts    # GenericActorClient / createGenericActorClient – client proxy + reminder/timer
    └── wait-for-sidecar.ts # /v1.0/healthz/outbound poller

packages/js/core-vercel/src/
├── index.ts               # re-exports
├── llm-client.ts          # ILlmClient interface
└── vercel-ai.ts           # VercelAiClient – Vercel AI SDK generateText via LiteLLM proxy

packages/js/git-core/src/
├── index.ts               # re-exports
└── git-client.ts          # clone() – shallow, branch-aware git clone (injects GH token into github URLs in-process); addWorktree() – git worktree add off an existing clone

packages/js/logger/src/
├── index.ts    # Logger interface, re-exports
├── service.ts  # initLogger (Pino), flushLogger
└── simple.ts   # singleCallbackLogger – lightweight stub for tests

packages/py/agent-server/src/agent_server/   # Python sibling of js/agent-server (uv workspace member)
├── __init__.py    # re-exports
├── models.py      # AgentRequest, AgentResponse (dataclasses)
├── routes.py      # register_agent_routes + granular register_{run,setup,subscribe}_route (FastAPI); /run records the run ledger
├── run_ledger.py  # record_run – Python sibling of js run-ledger (summary.json/events.jsonl + statestore mirror)
└── runner.py      # IAgentRunner Protocol – run(request, workspace) → AgentResponse

packages/py/agent-core/src/agent_core/       # shared agent machinery (uv workspace member; tests via `uv run --package agent-core pytest`)
├── react_loop.py  # provider-agnostic ReAct loop + LLMClient protocol (dependency-free base)
├── skills.py      # load_skill_instructions – system prompt from an h skill dir
├── llm/openai.py  # OpenAIChatAdapter over dapr_agents OpenAIChatClient (extra: dapr)
└── workflows/mcp_tools.py  # connect_workflows_mcp + WorkflowTools + open_workflow_tools (workflow-mcp toolset via MCPClient/SSE; extra: dapr)

cli/                                          # early prototype of the h CLI (see cli/README.md)
├── scripts/       # strategy 1 – run-*.sh / invoke-workflow-*.sh + payloads (envsubst/jq); _render.sh bridges to strategy 2
├── charts/workflows/  # strategy 2 – helm as a client-side templating engine; templates/<family>.yaml → run_workflow body (YAML canonical, JSON only at the wire)
└── h/             # the `h` command – Python (Typer + rich), uv workspace member, package h-cli
    ├── src/h_cli/{main,config}.py            # Typer composition root; env-derived settings mirroring the scripts' defaults
    ├── src/h_cli/commands/{feature,workflow}.py  # h feature render|run; h workflow list|get|status
    ├── src/h_cli/infrastructure/             # helm subprocess adapter, statestore/agent/svc httpx clients
    └── tests/     # pytest + syrupy goldens (chart contract tests) + respx-mocked wire
```

## Kubernetes layout

```
k8s/
├── apps/
│   ├── workflow-svc.yaml   # Deployment + Service — Dapr sidecar injected via annotation
│   └── claude-agent.yaml   # Deployment + Service + ConfigMap (MCP config)
├── dapr/
│   ├── statestore.yaml     # Component (state.redis, actorStateStore=true)
│   ├── pubsub.yaml         # Component (pubsub.redis)
│   ├── secretstore.yaml    # Component (secretstores.kubernetes)
│   ├── conversationstore.yaml
│   ├── claude.yaml         # Component (conversation.openai, scoped to claude-agent)
│   ├── resiliency.yaml     # Resiliency (1h outbound timeout)
│   └── appconfig.yaml      # Configuration (tracing — referenced by dapr.io/config annotation)
├── infra/
│   └── redis.yaml          # Deployment + Service
└── secrets/
    └── app-secrets.yaml    # k8s Secret (gitignored — generate with cli/scripts/gen-k8s-secrets.sh)
```

Tilt manages this stack. `make tilt-up` applies all manifests; `make tilt-down` removes them. Dapr control plane (`dapr-system` namespace) is Helm-managed — use `make dapr-install` / `make dapr-uninstall`.

## MCP configuration

`claude-agent` connects to MCP servers (`workflow-mcp` for workflows, `dapr-mcp` for state-store
inspection and pub/sub, `obs-mcp` for traces/logs/run-ledger — docker/local only, no k8s deployment,
so it is absent from the ConfigMap, `notion` for reading/searching Notion pages — authenticated with
`Bearer ${NOTION_API_KEY}` (a PAT, expires 1 year; no per-page sharing needed unlike integration
tokens), and the hosted GitHub MCP at `https://api.githubcopilot.com/mcp/` for repo/PR interaction —
authenticated with `Bearer ${GH_TOKEN}`). There is deliberately **no Linear MCP**: the hosted one
needs interactive OAuth and can't authenticate in an unattended agent — Linear is read/written via the
`linear` h skill instead (see below). Three configs select the URLs per environment:

| File / resource | Used when | URL |
| --- | --- | --- |
| `apps/claude-agent/.mcp.json` | Docker (service discovery via hostname) | `http://workflow-mcp:8000/sse` |
| `apps/claude-agent/.mcp.local.json` | Local dev (copied into workspace by test scripts) | `http://localhost:8005/sse` |
| `claude-agent-mcp-config` ConfigMap in `k8s/apps/claude-agent.yaml` | Kubernetes | `http://workflow-mcp:8000/sse` |

`ClaudeRunner` auto-provisions the MCP config into the run's cwd: before invoking the `claude` CLI
(which auto-discovers `.mcp.json` in its cwd) it merges `MCP_CONFIG_SRC` — defaulting to
`{AGENT_BASE_DIR}/.mcp.json` (the file Docker/k8s mount there), set to `{AGENT_APP_DIR}/.mcp.local.json`
locally — into whatever `.mcp.json` the cwd already has, creating it when absent. The merge
(`mergeMcpConfig`) preserves the cwd's own servers and other top-level keys and lets h's servers win
on a name conflict, so an agent running in a worktree of a repo that ships its own `.mcp.json` (e.g. a target
repo's `tessl` server) still gains h's `dapr`/`obs`/`workflows` servers. Docker deployments mount
`.mcp.json` directly; in Kubernetes the ConfigMap is mounted at `/workspace/claude-agent/.mcp.json`.

### h skills (harness skill source)

h provides its own agent skills, kept at the repo-root `skills/` dir — not inside any agent app, so
they stay reusable across agents and the agent services stay thin. A workflow setup step copies them
into a CLI agent's user-global `~/.claude/skills/` (`cp -r $H_SKILLS_DIR/* ~/.claude/skills/`).
`H_SKILLS_DIR` is the repo `skills/` locally (set by the agent run scripts) and a read-only mount
(`./skills:/h-skills`) in compose. Current skills: `linear` (read a Linear issue headlessly via
`LINEAR_API_KEY` with `get-issue.sh`, post comments back with `add-comment.sh` — the hosted Linear
MCP can't authenticate unattended), `analyze-workflow-run` (correlate every observability source for
a run), and `workflow-orchestrator` (turn a task into a saved/run/monitored workflow via the
workflows MCP). A **Python** agent consumes a skill's body directly as its system prompt via
`agent_core.load_skill_instructions` — workflow-agent loads `workflow-orchestrator` this way (the
same source a CLI agent gets), so the orchestration procedure has a single home. This is a skill
source alongside the tessl registry (org-published plugins) and a repo's own `.claude/` skills.

## Observability

`workflowInstanceId` is the join key across every surface — it is the Dapr workflow instance id, the
default agent workspace key, a Zipkin span attribute, and the group key of the run ledger.

- **Traces → Zipkin.** Every service calls `initTracing` (JS) / `init_tracing` (Python) → OTLP/Zipkin
  at `localhost:9411` (docker: `zipkin:9411`), W3C-propagated. Activities thread the originating
  `traceparent` as workflow-input data and re-attach via `contextFromTraceparent` so a run is one trace
  end-to-end — including the cron path (the tick captures `activeTraceparent()`). k8s tracing is off
  (`samplingRate: "0"`).
- **Run ledger → "what the agent did".** Every agent run writes, best-effort,
  `{RUNS_DIR}/<instanceId|workspaceId>/<agentId>-<ts>/{summary.json,events.jsonl,output.txt}` on the
  shared volume (`RUNS_DIR` defaults to `<AGENT_BASE_DIR>/../.runs`), and mirrors a compact
  `run:<runId>` record + `runs:index` into the statestore — so runs are queryable via `dapr-mcp` too.
  The JS capture lives in `agent-server`'s `startRunLedger` (events arrive via the runner's `onEvent`);
  the Python sibling is `record_run`, called from the shared `/run` route.
- **Logs → Loki.** Alloy scrapes **dockerized** containers only; host-run `dapr run` apps (the usual
  `make dev-tab` mode) do not reach Loki — use traces + the run ledger for app/agent activity.
- **Query surface.** The repo's own Claude Code session wires three MCP servers via root `.mcp.json`:
  `dapr` (state/actors, `localhost:8011`), `workflows` (workflow state, `localhost:8005`), and `obs`
  (traces/logs/run-ledger, `localhost:8013`). `obs-mcp` is read-only with no Dapr sidecar. Slash
  commands (`.claude/commands/`: `/observe`, `/runs`, `/run`, `/trace`, `/logs`, `/workflow`) and the
  `observe-h` skill (`.claude/skills/`) drive them.

## Dev commands

Install dependencies (run from repo root):

```sh
bun install --frozen-lockfile
```

Build all workspace packages in dependency order (Turborepo resolves the graph):

```sh
bun run build
```

Per-package (run from the package directory):

```sh
bun run build    # tsc --project tsconfig.build.json
bun run lint     # tsc --noEmit + oxlint + oxfmt --check
bun run format   # oxfmt src
bun run test     # vitest run
```

For Python, sync dependencies from the lockfile.

Workspace members (the shared `agent-server` / `agent-core` libs, the agent apps
`dapr-agent`, `dapr-claude-loop-agent`, `langgraph-agent`, `workflow-agent`, and the
`h` CLI at `cli/h`) share one root `uv.lock` — sync from the repo root, optionally
scoping to one member with `--package`:

```sh
uv sync --frozen                                  # whole workspace
uv sync --frozen --package langgraph-agent        # one member + its deps
```

The one standalone agent keeps its own `uv.lock` and syncs from its own directory:

```sh
cd apps/claude-managed-agent && uv sync --frozen --no-dev
```

The `h` CLI (installed editable as a workspace member):

```sh
uv run h --help                          # run the CLI from the repo root
uv run --package h-cli pytest            # its test suite (incl. golden snapshots of cli/charts)
```

## Docker build context

All app Dockerfiles use `context: .` (workspace root) so Bun can resolve workspace packages during `bun install --frozen-lockfile`. Dockerfiles copy workspace manifests first for layer caching, then source, then run `bunx turbo build --filter=<app>...` to build workspace package dependencies in topological order. When adding a new workspace package, add its `package.json` COPY line to all relevant app Dockerfiles — `bun install --frozen-lockfile` will fail otherwise.

BuildKit cache mounts are used for both `bun install` (`id=bun-store`) and the turbo build (`id=turbo-store`), shared across all TypeScript app images. Python images share a `uv-store` cache mount. A `.dockerignore` at the repo root excludes `node_modules/`, `dist/`, `.venv/`, and other build artefacts from the build context.

## Key gotchas

- **Polyglot package layout** — shared libs are partitioned by ecosystem: TypeScript under `packages/js/*` (npm workspace, declared in root `package.json`), Python under `packages/py/*` (uv workspace, declared in root `pyproject.toml`). The two never resolve each other, so a name can be reused across them — `agent-server` exists in both (`js/agent-server`, `py/agent-server`/module `agent_server`). The uv workspace deliberately scopes its `members` to the shared libs (`agent-server`: the HTTP contract; `agent-core`: the ReAct loop + workflow toolset) plus the apps that consume them (`dapr-agent`, `dapr-claude-loop-agent`, `langgraph-agent`, `workflow-agent`) and the `h` CLI (`cli/h`, package `h-cli`, installed editable so `uv run h` works at the root); `claude-managed-agent` (diagrid) is `exclude`d and keeps its own per-app `uv.lock`.
- **`bun install` required after adding packages** — workspace dependencies are hoisted to the root `node_modules`. If a new package is added to any `apps/*` or `packages/js/*` workspace member and `bun install` hasn't been run at the repo root, that package won't be found at runtime.
- **`uv lock` required after adding to a Python workspace member** — the workspace shares one root `uv.lock`. After adding a dependency to a member app or to `packages/py/agent-server`, run `uv lock` (then `uv sync`) at the repo root, and add the member's `pyproject.toml` COPY line to its Dockerfile — `uv sync --frozen` fails otherwise.
- **Turborepo build pipeline** — `turbo.json` defines `build` with `dependsOn: ["^build"]`, ensuring packages are always compiled in dependency order. `bun run build` at the root delegates to `turbo build`. Dockerfiles use `bunx turbo build --filter=<app>...` to build only the transitive deps of a given app.
- **`GH_TOKEN` for private-repo clones** — the `clone-repo` activity calls claude-agent's `/clone`, which uses the `git-core` package to shallow-clone into the workflow workspace. `git-core` injects `GH_TOKEN` into `https://github.com/…` URLs in-process (as a git argument, no shell), so the token never appears in the workflow definition, task entry, or logs. Wired into claude-agent via `docker-compose.yml` and `cli/scripts/run-claude-agent.sh`; leave unset for public repos.
- **SQLite name resolver** — `dapr/local/appconfig.yaml` configures `nameresolution.sqlite` with a shared file at `/tmp/dapr-h-nr.db`. This is required on macOS with Rancher Desktop because mDNS multicast is unreliable across multiple virtual network interfaces. The file is auto-created at sidecar startup and cleared on reboot (fine — sidecars re-register on start).
- **`actorStateStore: "true"`** in both statestore YAMLs is load-bearing for Dapr Workflows, which ride on the actor runtime. Missing it → cryptic actor-runtime failure at startup. It also backs `dapr-mcp`'s `GenericActor` state — it's the single auto-discovered actor state store, shared by all actor-hosting apps. Actor state is composite-keyed by `appID || actorType || actorId || key`, so `dapr-mcp` (`GenericActor`) and `workflow-svc` (internal workflow/activity actors) never collide.
- **`dapr-mcp` dual listeners** — the `@dapr/dapr` JS actor SDK hosts actors via `DaprServer`, which is express-based and owns its own HTTP listener; it cannot share Fastify's socket. So `dapr-mcp` runs the `GenericActor` host (express) on `ACTOR_APP_PORT` and serves MCP-SSE on `APP_PORT` (Fastify) in the same process. Dapr's `--app-port` points at the **actor port** (8012 local / 8010 in compose), because the sidecar calls actor callbacks there; MCP clients connect directly to `APP_PORT` (8011). The local actor port is **8012, not 8021** — on macOS a `launchd` daemon already listens on `127.0.0.1:8021`, so binding the actor host there fails with `EADDRINUSE` (the JS SDK logs an optimistic `Listening on 8021` first, then the async bind error surfaces as `Failed to start server. Is port 8021 in use?`). Startup order is load-bearing: `registerActor → waitForSidecar → DaprServer.start → actor.init` (`start()` does not auto-call `init()`).
- **`cron-tick` binding → `workflow-agent`** — `dapr/cron.yaml` (and `dapr/local/cron.yaml`) is a `bindings.cron` component scoped to `workflow-agent`; Dapr POSTs to `/cron-tick` on that app on the configured schedule. The route name must equal the binding name. No k8s copy (workflow-agent is local/compose-only, like the other Python agents).
- **`workflow-cron-tick` binding → `workflow-svc`** — `dapr/workflow-cron.yaml` (and `dapr/local/`) is a second `bindings.cron`, scoped to `workflow-svc`, POSTing `/workflow-cron-tick` every 60s. The handler scans saved workflows and fires any whose cron `schedule` is due (next fire after `lastRunAt`, else `savedAt`, has passed), stamping `lastRunAt` — stamp-forward means missed fires self-heal (one fire, no catch-up storm); `disabled: true` skips. **Gotcha:** Dapr probes an input binding with `OPTIONS`, and both the probe and the tick arrive as `application/json` with an empty body — Fastify 404s an unhandled method and 400s an empty JSON body, either of which makes Dapr log "app has not subscribed". So the route lives in an encapsulated Fastify plugin scope with its content-type parsers cleared, and answers both POST and OPTIONS.
- **Reusable workspaces (`workspaceId`)** — a workflow may carry a top-level `workspaceId`; agents key their workspace dir on `workspaceId ?? workflowInstanceId`, so a recurring/cron workflow reuses one provisioned dir instead of a fresh per-run one. `/setup` is idempotent: it hashes the setup spec into `.agent-setup-complete` and short-circuits on an unchanged spec, so skills/config are installed once. `workspaceId` is injected into every step by `generic.workflow.ts` and persisted on saved workflows.
- **Grooming workflow shared-context pattern** — the `cli/scripts/invoke-workflow-grooming.sh` grooming workflow uses a symmetrical naming scheme: the Dapr workflow instanceId, the file the groom step writes, and the actor used to persist findings are all keyed by the same id (`groom-${ISSUE_ID}`). The groom step writes `groom-${ISSUE_ID}.md` into the worktree cwd (file-based handoff, reliable across steps in the same workflow) AND calls `actor_state_set(actorId='groom-${ISSUE_ID}', key='findings')` via dapr-mcp (actor-based, durable in Redis, inspectable from any session via `actor_state_get`). The writeback step reads the file with `cat`; any external session can read the actor state. `--dry-run` sets `DRY_RUN=1` in the task payload so workflow-agent builds only the first three steps. The script seeds the task and POSTs to workflow-agent (same pattern as `invoke-workflow-agent.sh`) so the trace is end-to-end: workflow-agent → workflow-mcp → workflow-svc → claude-agent.
- **Chart-rendered workflows (`cli/charts`)** — `helm template` is used purely client-side (no cluster) to render a workflow family's template into a `run_workflow` request body. YAML is the canonical artifact; JSON conversion is a final processing step at the wire boundary only (`_render.sh: yaml_to_json` / `h_cli.infrastructure.helm: to_wire_json`). Delimiter coexistence is deliberate: engine tokens (`{{step.field}}`) are emitted via the `h.token` helper (`printf`), agent-side `$VARS` are inert text, and `{"$ref": ...}` needs nothing. The syrupy goldens in `cli/h/tests` are the chart's contract tests — rendered hermetically (`include_local=False`, so a dev's gitignored `values.local.yaml` can't skew them) from the hostile fixture; re-bless with `--snapshot-update` only deliberately, reviewing the `.ambr` diff. Org-specific chart defaults live in `cli/charts/workflows/values.local.yaml` (gitignored, auto-merged by both render paths).
- **Worktree fetch-before-branch** — `addWorktree` in `packages/js/git-core/src/git-client.ts` accepts a `remoteBase` option. When set (and no explicit `baseRef` is given), it fetches `origin/<remoteBase>` before cutting the new branch, so the worktree starts from the latest remote tip rather than the potentially-stale local checkout. The `/worktree` route in `agent-server` defaults `remoteBase` to `"main"` for all worktree-cutting workflows (grooming, feature-request, triage). Pass `remoteBase: ""` explicitly to opt out.
- **Run ledger is best-effort** — observability must never break a run, so every ledger write (the `RUNS_DIR` files and the statestore mirror) swallows errors; the on-disk files are the source of truth. The `runs:index` / `run:<id>` keys follow the flat-keyspace convention so `dapr-mcp` can read them. `obs-mcp` reads Zipkin/Loki over HTTP and the ledger off `RUNS_DIR` (fs) — it has **no Dapr sidecar**, so its `--app-port` (8013) is just the MCP listener.
- **Statestore shared keyspace** — the Redis state store sets `keyPrefix: none`, so keys are global (no app-id prefix). This is deliberate: it lets any service — and `dapr-mcp` — read each other's keys (e.g. `task:…`, `tasks:index`, `__workflow_index__`, saved workflow keys) for dogfooding/inspection. Actor/workflow runtime state uses its own composite keying and is unaffected. With a flat keyspace, avoid key collisions across services (the existing keys are namespaced by convention: `task:`, `feedback:`, `__workflow_index__`).
- **`docker-compose.local.yml`** — required for local dev (`--profile infra`). Overrides the scheduler's broadcast address to `localhost:50007` so host-side daprd processes can reach it. Without it the scheduler advertises its internal Docker IP, unreachable from the host on macOS. Never use this file with full-Docker profiles — Docker containers resolve `localhost` as their own loopback, not the scheduler container.
- **`docker compose down -v`** — always pass `-v`. Without it the scheduler's etcd volume persists and can replay a prior workflow on next startup.
- **Local port allocation** — every `cli/scripts/run-*.sh` pins a unique set of ports (app, `--dapr-http-port`, `--dapr-grpc-port`, `--dapr-internal-grpc-port`) so any combination can run simultaneously without collision; the full map is in `README.md`. `workflow-svc` keeps Dapr gRPC `50001` (the Dapr Workflow SDK's default); all other sidecars pin a distinct `360xx` gRPC port rather than letting the dapr CLI auto-assign — otherwise a concurrently-starting sidecar could grab `50001` before `workflow-svc` and make it fail to bind. Internal gRPC ports are `500xx` (avoiding `50006`/`50007`, the placement/scheduler control plane). `dapr-mcp` additionally runs a second app listener on `ACTOR_APP_PORT` (8012 local / 8010 compose) for actor callbacks — that, not the MCP port, is its Dapr `--app-port`.
- **Run scripts are idempotent** — each `cli/scripts/run-*.sh` sources `cli/scripts/_lib.sh` and calls `stop_stale <app-id> <ports…>` before `exec dapr run`. This runs `dapr stop --app-id <id>` then force-frees the app/http/grpc ports it pins (SIGTERM, then SIGKILL if still bound), so re-running a script cleanly replaces a prior instance instead of failing with `invalid configuration for HTTPPort. Port N is not available`. It also makes the documented "cannot run simultaneously" port-sharers (e.g. `dapr-agent` / `dapr-claude-loop-agent`) swap gracefully.
- **`:edge` images** track the latest Dapr release and can move without notice. Pin to a specific version for anything beyond local hacking.
- **`packages/agent-cli` and `packages/logger` dist** — both packages are imported from `./dist/index.js`. Changes to source are not picked up until rebuilt.
- **Alloy log scraping** — `config/alloy/config.alloy` uses `discovery.relabel` (not `loki.relabel`) to apply `__meta_docker_*` labels to log streams. `loki.relabel` only sees log-entry labels, not discovery metadata — using it for Docker labels produces streams with no labels, which Loki rejects with a 400.
- **Python agents base image** — all Python agents use `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` (not Docker Hub). Workspace members (`dapr-agent`, `dapr-claude-loop-agent`, `langgraph-agent`, `workflow-agent`) build against the root `uv.lock` with `uv sync --frozen --no-dev --package <app>` (two-phase: `--no-install-workspace` for cached external deps, then a second sync to install the editable workspace packages). The standalone `claude-managed-agent` installs from its own `uv.lock` via `uv sync --frozen --no-dev`.
- **Dapr Conversation API tool calling** — `DaprChatClient` (alpha2) does not support function/tool calling. The Python agents use `OpenAIChatClient` (OpenAI wire protocol) pointed at the LiteLLM proxy instead.
- **MCP server per-connection isolation** — `workflow-mcp` creates a new `Server` instance per SSE connection. A single shared instance throws "Already connected to a transport" on reconnect.
- **Resiliency policy** — `dapr/local/resiliency.yaml` sets a 1-hour outbound timeout for all agent app-ids. Without it the Dapr Workflow scheduler times out long-running agent activities before they complete.
- **Dapr CRDs survive `helm uninstall`** — Helm does not remove CRDs on uninstall by design. `make dapr-uninstall` explicitly deletes all `*.dapr.io` CRDs after uninstalling the release. If you uninstall manually and then try to reinstall, you will get a field-manager conflict; run `make dapr-uninstall` to clean up properly.
- **Dapr mTLS cert rotation (Kubernetes)** — Dapr sidecars and control-plane components hold short-lived mTLS certs issued by `dapr-sentry`. These are renewed automatically, but if the Kubernetes service account token used to authenticate to Sentry expires (possible on long-running local clusters), renewal fails and the cluster enters a degraded state. Symptom: persistent `DaprBuiltInActorNotFoundRetries` warnings and workflows not executing. Fix: `make dapr-uninstall && make dapr-install` to issue a fresh CA and all certs from scratch.
- **WorkflowRuntime startup race (Kubernetes)** — the app container and the Dapr sidecar start concurrently. If `WorkflowRuntime.start()` runs before the sidecar's gRPC port (50001) is ready, the SDK logs an ECONNREFUSED and retries. Under normal conditions this resolves within seconds. If it persists alongside the cert rotation issue above, a full `make dapr-uninstall && make dapr-install` is the reliable fix.
- **k8s secrets file is gitignored** — `k8s/secrets/app-secrets.yaml` is generated from `.env` by `cli/scripts/gen-k8s-secrets.sh`. Re-run the script after changing `.env` before running `make tilt-up`.
