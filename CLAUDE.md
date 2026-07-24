# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [README.md](./README.md) for stack overview, local dev setup, component reference, and tooling.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the primitives, the composition stack, and the principles.
See [docs/cookbook.md](./docs/cookbook.md) for h BY EXAMPLE — real, validated commands (each
stamped with date + artifact). When an e2e validates a new composition, lift its command there.
See [cli/README.md](./cli/README.md) for the local tooling — `cli/` is the early prototype of the
h CLI: the run/invoke shell scripts (`cli/scripts/`), the helm-templated workflow definitions
(`cli/charts/`), and the `h` command itself (`cli/h/`, Typer + rich, a uv workspace member — `uv
run h --help`). The two construction strategies co-exist deliberately.

## Plans

Non-trivial work is scoped and tracked in a plan doc — a living tracking log, not a
frozen spec. **Follow the `plan-management` skill** (`.claude/skills/plan-management/`).
In short: core/architecture plans are source-controlled (`docs/plans/<name>.md`
active → `docs/plans/impl/<name>.md` archived); domain-specific, local-only plans go
under the gitignored `docs/plans/domain/`. Never leave a plan in the harness scratch
location (`~/.claude/plans/`). Before archiving a core plan, **lift every piece of
lasting context to its one long-lived home** (ARCHITECTURE.md, a skill, a lint rule +
CLAUDE.md, an auto-memory, or a code comment) — plans are transient, so knowledge left
inside one is lost when it's filed away.

## h primitives (vocabulary)

The standard vocabulary for composing components.
**[ARCHITECTURE.md’s glossary](./ARCHITECTURE.md#glossary) is the canonical dictionary**; its
primitives, authored-slot/target table, composition stack, and design principles define the terms
used here. This section is the terse runtime-facing index.

- **Template** — the authored, parameterized, composable unit (a chart template is one way to
  author one). Templates overlay (⊕, merge by step id) into ONE workflow definition; publish-mode
  renders keep `{{params.*}}` slots open — including fire-time identity (runActivity/agentId/
  model…) with values-baked defaults. Surface: `h template compose|list|get`.
- **Workflow** — a durable step sequence that does work and leaves durable traces (Dapr instance
  status, run ledger + `run:<id>` mirrors, Zipkin spans, joined on `workflowInstanceId`). It never
  supervises anything, including itself.
- **Watcher** — a durable registration (`{subject, policy}`) plus a shared engine that, on a clock,
  reads a subject's already-persisted operational state, interprets it against the policy, and acts
  through a closed vocabulary (terminate own subject, record, publish, escalate). Judgment stays
  agent-side. IMPLEMENTED: the engine lives in workflow-svc (`domain/watch-*.ts`, scan on the
  workflow-cron-tick), rows are `watch:sub:<instanceId>` written by every fire path; the old
  in-process babysitter loops (JS + Python) are deleted — `POST /workflow` forwards a `watch`
  field. Inspect with `h watch list` or `GET /watch/list`.
- **Chain** — the sequencing sibling of the watcher: a durable registration `{workflows, strategy,
  data}` plus a shared engine that, on the same cron tick, reads the current STAGE's persisted state
  and acts through a closed vocabulary (advance/fire-next, join, finalize) — where a watcher RE-fires
  one instance, a chain FIRES THE NEXT stage. A chain is ordered STAGES, each stage a CONCURRENT set
  (docs/plans/inline-chain-cron-composition.md D3): members carry a `stage` (absent ⇒ member index =
  sequential), `cursor` is the current stage, and the engine joins on every member of a stage
  completing before advancing. State threads workflow-to-workflow through the row's two-level `data`
  (D5: a member's declared `captures` write under its own `id` namespace so concurrent members never
  clobber; a downstream `inputs` reads back a dotted `id.field` — flat when no id, the degenerate
  case), filled by the engine parsing each one's output (no actor) — STRUCTURED ONLY since
  docs/plans/structured-workflow-outputs.md (marker parsing retired 2026-07-15): every chained
  template declares an `outputs:` schema and ends its agent step with a validated fenced json block
  (the `outputContract` step input → the run activities' rung-2 seam, `domain/structured-output.ts`;
  envelope gains `structured`), which the kind contracts read — chained workflows stay chain-agnostic.
  A member may be a saved `key`, an EMBEDDED `steps` blob (D1 inline storage, no publish), and/or a
  `cron` member that self-arms its OWN recurrence via the §10 arm-* pattern (armCron injected into its
  one fire); the chain never writes `cron:sub` and never re-fires it — it OBSERVES `wf:<member>.resolved`
  (D2/D4) and captures off that resolved run's `wf.output`. On a non-cron member's terminal-failure the
  chain fails as a UNIT (D6): it terminates the still-running siblings and PUBLISHES `cron-disarm` for
  every member-armed cron (a loose pub/sub edge — the disarm handler stays cron:sub's single writer)
  before finalizing. IMPLEMENTED: engine in workflow-svc (`domain/chain-*.ts`, scan on the
  workflow-cron-tick beside the watch scan), rows `chain:sub:<chainId>`; `h chain run` registers
  (fire-and-forget) via the chain EXPRESSION — ordered `-w KEY` / `-t ATOM…` members with
  position-scoped `--agent/--model/--fresh/--kind/--inline` flags, stage flags `--parallel` (infix) or
  `--stage N`, cron flags `--cron CADENCE`/`--max-fires N`, the namespace `--id NAME`, plus declarative
  threading mappings `--capture BB=FIELD / --input PARAM=SRC (SRC = flat key or dotted id.field) /
  --until PATH=VALUE` (validated against the declared outputs schema at registration; each declared
  half replaces its side of the kind contract) (suffix = that workflow, prefix = chain-wide default);
  a `-t` group overlays inline and publishes under `<slug>-w<N>` by default, or EMBEDS with `--inline`
  (compose-on-fire; at most ONE atom per composition declares `outputs`). `--agent` takes a ROSTER
  (greedy operands, the `-t` idiom): SEVERAL names PANELIZE the member (docs/plans/panels-as-a-modifier.md
  — panel as cardinality, 2026-07-24): a pure CLI-side transform (`infrastructure/panelize.py`) replicates
  the member's contract-carrying step into a parallel step group (one branch per agent, contract+model
  stripped, concurrency preamble injected) and appends a pinned-judge (claude) synthesis under the
  member's ORIGINAL id+contract — so every downstream seam (loop-until-clean, captures, watcher) is
  unchanged and the engine needs nothing new. Read/judge kinds only (write kinds share one worktree —
  compose N `--parallel` members instead); no `--model` with a roster; a roster forces compose-on-fire
  (a `-w` key renders its chart template — `panelSynthesis:`, the template's optional join-rule prose,
  flows from the render — else the stored def); the pr-review executor freeze relaxes to the named
  roster, the pin migrating to the judge. `h chain list` inspects.
  Strategies: `sequential`, `loop-until-clean` (loop × stages reconciliation is deferred — see the plan
  doc's open sub-questions).
- **Cron** — the recurrence sibling: a durable registration `{cadence, source, budget}` plus the same
  shared engine that, on the same cron tick, reads the target `wf:` row + the live instance and acts
  through a closed vocabulary (fire-again, deactivate) — where a watcher RE-fires one instance on a
  failure policy and a chain FIRES THE NEXT workflow, a cron RE-FIRES the SAME workflow on a clock
  until its GOAL resolves or a budget trips. The goal is the `wf:` row's `resolved` flag — a real
  state check (e.g. PR merged), DISTINCT from run-status `done` (the steps finished) — which the
  workflow reports via a `goal: RESOLVED` field in its validated structured output. A **discovery / fan-out** variant (rows
  `cron:discover:<repo>:<label>`, index `cron:discover-index`) does NOT re-fire one workflow: each tick
  it reads a SOURCE (open issues on a label, via git-core's `GitHubClient` behind an `ISourceReader`
  port) and fires ONE workflow per newly-seen item — serialized (one in flight), daily-capped, deduped
  against the `wf:*` keys (the h-builds-h issue loop; the retired `issue-sweep`'s discover half).
  IMPLEMENTED: engine in workflow-svc (`domain/cron-*.ts` recur, `domain/discover-*.ts` fan-out; scan
  on the workflow-cron-tick beside watch+chain), rows written ONLY by workflow-svc. **Registration is
  by ACTIVITY, not the fire handler** (the §10 `arm-*` pattern — see below): `--cron` on `h workflow
  run <key>` is armed by `generic.workflow`'s CLOSING bracket via the `register-cron` activity
  (idempotent ensure-exists, so a re-fire doesn't reset the budget); a discovery cron is armed by
  `h cron discover add <repo> --label --cadence [--workflow] [--max-per-day] [--run-budget-mins]`
  firing a one-step provision workflow whose `register-discover` activity writes the row (its own `wf:`
  row audits the registration). Inspect with `h cron list`; disarm with `h cron rm REPO SLUG WORKFLOW`
  (`POST /cron/disarm` — single-writer; sets inactive+disabled, keeps row for audit, epoch-fenced).
  Recur source modes: saved key + params, or
  an embedded definition (mode 3 dynamic-params deferred). A **scheduled-fire / one-shot** variant
  (rows `cron:sched:<id>`, index `cron:sched-index`; `domain/schedule-*.ts`) is the THIRD cron-siblings
  sibling: it fires one workflow exactly ONCE at an absolute `fireAt` (`decide` → wait | fire | expire;
  an optional `notAfter` expires a missed window), then deactivates — no cadence, no budget, no goal
  handshake, deliberately none of the recurring machinery. It is the shared spine for three consumers
  (docs/plans/schedule-and-fallback.md): **schedule-at-a-time** (`h workflow run <key> --at <iso> | --in
  <dur>` arms a row instead of firing now; `h schedule list|rm`), **pause/resume** (`h workflow pause
  <id> <key> --in <dur>` terminates the run and arms a continuation reusing its `workspaceId`;
  `h workflow resume <schedId>` fires it now — stop-and-continue, re-enters from step 1), and the
  **usage-limit fallback** (the watcher, on a `usage-limited` outcome, arms a deferred continuation
  under a different agent/model — `h workflow run … --fallback-agent openhands [--fallback-after 10m]
  [--fallback-max N]`). Fired continuations go through `invokeWithWatch` (supervised). Inspected via
  `h schedule list` (also surfaced in `h cron list`); disarmed with `h schedule rm <id>`
  (`POST /cron/sched/disarm`).
- **Trigger** — anything that fires a workflow: HTTP `/workflow/run*`, a `workflow-trigger` event
  `{key, params}`, or the cron tick over saved schedules. Triggers are data; one well-known topic.
- **Registry** — durable rows under a claimed prefix in the flat Redis keyspace plus an index key
  (the `__workflow_index__` pattern): saved workflows, `run:*` mirrors, `watch:*`,
  `chain:*`, `cron:*` (recur rows `cron:sub:*` + the discovery/fan-out cron's `cron:discover:*` /
  `cron:discover-index` + the one-shot scheduled-fire cron's `cron:sched:*` / `cron:sched-index`),
  and `wf:*` (per-workflow status rows, `wf:<repo>:<slug>:<workflow>`, each
  written by the workflow that names it — via its own `write-wf-row`/`register-*` activities, §10).
  The convention: a registry prefix names the single component that owns writing it.

The watcher, the chain, and the cron are three instances of one build-pattern — a policy row in a
registry, evaluated by a pure `decide` on the cron-tick clock, acting on workflows through a closed
vocabulary, epoch-fenced, single-writer. None is a new runtime concept; each is a composition of
Workflow + Trigger + Registry that earns its own name because its job (supervise; sequence; recur)
recurs. The load-bearing invariant: **a workflow never supervises, sequences, or recurs itself —
those live in engines outside it** (which is why sequencing is the Chain primitive, not an overload of
the watcher's `escalate`). Watched/chained/cron'd workflows never depend on their engines; only
judgment consumers read the rows.

**Registration follows the §10 `arm-*` pattern (registry state is created by ACTIVITIES).** A
workflow arms its OWN follow-on cron via a `register-cron`/`register-discover` activity (siblings of
`write-wf-row`): it is a CLIENT of the cron primitive, not the engine — recurrence still lives in the
engine on the tick. WHERE a registration happens is an ORDERING question, not edge-vs-activity: crons
are armed by the run (after its work; idempotent ensure-exists; LOUD, so a failed arm records
`wf:failed`), while the **watcher alone** is registered in the fire handler BEFORE the run
(`invokeWithWatch`, persist-then-invoke) — because supervision must precede what it supervises. The
edge FIRES workflows; it no longer writes cron rows (`POST /cron/discover` was deleted). See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full treatment.

## App layouts

```
apps/claude-agent/src/                    # claude-agent
├── index.ts                              # composition root – registers shared agent-server routes + /clone + /worktree + /workflow (babysitter), fatal crash handlers, starts Fastify
├── ../steering/h-runtime.md          # h runtime steering (the MCP set + how to use it), at the APP root not src/; a triage setup step copies it to the agent's ~/.claude/CLAUDE.md
├── infrastructure/mcp-config.ts          # mergeMcpConfig – merge h's MCP servers into the cwd's existing .mcp.json (pure, value-tested)
└── infrastructure/claude-runner.ts       # IAgentRunner impl; honours an optional cwd (e.g. a worktree); merges MCP config into cwd; routes (/run, /setup, /clone, /worktree, /dapr/subscribe) come from agent-server

apps/openhands-agent/src/                 # openhands-agent
├── index.ts                              # composition root – registers shared agent-server routes, starts Fastify
└── infrastructure/openhands-runner.ts    # IAgentRunner impl; /run, /setup, /dapr/subscribe come from agent-server

apps/pi-agent/src/                        # pi-agent — pi CLI coding agent
├── index.ts                              # composition root – registers shared agent-server routes, starts Fastify
└── infrastructure/pi-runner.ts           # IAgentRunner impl using PiInvokerLive; no MCP provisioning (pi has no MCP)

apps/codex-agent/src/                    # codex-agent — OpenAI Codex CLI coding agent (Fastify + Dapr sidecar)
├── index.ts                              # composition root – registers shared agent-server routes + /clone + /worktree + /workflow (babysitter), starts Fastify; uses makeTracingLive("codex-agent")
└── infrastructure/codex-runner.ts        # IAgentRunner impl using CodexInvokerLive (agent-cli); honours optional cwd/model; /run, /setup, /dapr/subscribe come from agent-server

apps/dapr-agent/src/                      # dapr-agent (thin wrapper over agent-core)
├── main.py                               # composition root – registers shared agent-server routes + /workflow (babysitter); opt-in workflow orchestration when WORKFLOWS_MCP_URL is set (merges the workflow toolset + appends the workflow-orchestrator skill)
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

apps/workflow-agent/src/                  # workflow-agent (thin wrapper over agent-core; NOT the exclusive workflow entry point — every agent service has the standard /workflow endpoint)
├── main.py                               # FastAPI composition root + /workflow (babysitter); system prompt loaded from the workflow-orchestrator skill (agent_core.load_skill_instructions; AGENT_SYSTEM_PROMPT overrides)
├── infrastructure/workflow_agent_runner.py  # IAgentRunner impl – delegates to agent_core's ReAct loop over the workflow-mcp toolset
├── infrastructure/statestore.py          # task read-write via Dapr state API
└── presentation/http/cron_router.py      # POST /cron-tick (cron binding target), POST /run, GET /dapr/subscribe (empty — the plugin-feedback flow moved to workflow-svc's workflow-trigger topic + the plugin-improvement chart template)

apps/workflow-svc/src/
├── index.ts                                          # registers workflow + activities + cron/watch/chain routes, wires the store/source-reader layers, starts Fastify
├── domain/
│   ├── models/workflow.model.ts                      # WorkflowRequest (+ watch/watchMeta, wf identity, armCron closing-bracket cron), StoredWorkflow (+ outputs — the declared output schema), WorkflowParams, WorkflowSchedule, toRequest; AgentResult (+ structured — the validated output block)
│   ├── models/watch.model.ts                         # the watcher primitive's shapes: WatchPolicy (maxDurationMs, retry, escalate), WatchRow (epoch-fenced), WatchConfig, WatchLedger
│   ├── models/chain.model.ts                         # the chain primitive: ChainRow {workflows, cursor=STAGE index, data (two-level, D5), strategy}, ChainMember {kind, key? XOR steps? (inline), stage?, id? (namespace), cron?, captures/inputs/until}; stage helpers (stageOf/membersInStage/lastStage) + validateChain (contiguous stages, key/steps XOR, cron⟹inline); ChainStrategy (sequential | loop-until-clean); CRON_DISARM_TOPIC lives in cron.model
│   ├── models/cron.model.ts                          # the recur cron: CronRow, CronSource (saved | embedded), CronBudget, cronId; config/heartbeat/ledger (shared with discovery)
│   ├── models/discover.model.ts                      # the discovery/fan-out cron: DiscoverRow {repo,label,workflow,gates,source:github-issues,watch?}, discoverId, issueSlug/issueInstanceId
│   ├── models/wf.model.ts                            # per-workflow status registry: WfRow (status + resolved goal flag), WfIdentity, wfKey, wfIdentityFrom
│   ├── ports/{IWorkflowInvoker,IWorkflowStore}.ts    # outbound ports (invoker: invoke/getStatus/terminate)
│   ├── ports/{IWatchStore,IChainStore,ICronStore,IWfStore}.ts  # the registry ports (cron store also serves discover rows: cron:discover:* + index, and one-shot sched rows: cron:sched:* + index)
│   ├── ports/ISourceReader.ts                        # the discovery cron's enumeration seam (listOpenIssues, oldest-first) — keeps domain free of any GitHub type
│   ├── {watch,chain,cron}-engine.ts                  # pure decide() per primitive — supervise | sequence | recur; unit-tested policy surfaces
│   ├── discover-engine.ts                            # pure decide(row, runtimeStatus, todayFires, now) → wait | discover (in-flight serialize → cadence → daily-cap)
│   ├── schedule-engine.ts / schedule-scan.ts         # the one-shot cron:sched variant: pure decide(row, now) → wait | fire | expire; arm/disarm/advance + per-tick fire-once-then-deactivate (fires via invokeWithWatch). Spine for --at/--in, pause/resume, usage-limit fallback
│   ├── watch-scan.ts                                 # registerWatchForFire + invokeWithWatch (the WATCH fire choke point) + scanWatchesEffect (terminate/retry/escalate/cost-tally/publish)
│   ├── chain-scan.ts / chain-members.ts            # chain registration + per-tick STAGE progression (observe every current-stage member → join → capture all → fire next stage); inline(steps)/saved(key) fire + armCron for cron members; observeMember cron branch reads wf:resolved; atomic-failure teardown (terminate siblings + publish cron-disarm); STRUCTURED-ONLY threading (stepStructured/contractFor; declared captures namespace under member id (D5), inputs resolve dotted paths; no marker parsing — retired 2026-07-15) (no actor). Kinds (`MEMBER_KINDS` / `ChainMemberKind`, closed literal — a novel kind is added on BOTH sides, engine + CLI): `feature-pr`, `pr-review`, `revise`, and `answer` (the bare "answer this task" member — coded contract reads a `task`, captures the structured `answer`; identity is ordinary fire-time params, and an `--agent` roster panelizes it at fire time. Successor of the retired hand-built `agent-panel` kind — subsumed 2026-07-24 by panels-as-a-modifier)
│   ├── structured-output.ts                          # the rung-2 seam: fail-closed JSON-Schema SUBSET validator + last-fenced-```json extraction; applyOutputContract called by every run-* activity (docs/plans/structured-workflow-outputs.md)
│   ├── cron-scan.ts                                  # registerCronForFire (IDEMPOTENT ensure-exists — §10) + scanCronsEffect (recur fire/deactivate, epoch-fenced)
│   ├── discover-scan.ts                              # registerDiscover + scanDiscoverEffect (read source after gates=budget → dedup by exact-key wf: read → fire OLDEST eligible, supervised if watch set)
│   └── scheduling.ts                                 # isDue / assertValidCron (cron-parser) – pure, unit-tested
├── presentation/http/
│   ├── workflow.router.ts                            # POST /workflow/run, /save, /run/:key (fire-time params + instanceId/workspaceId/fresh/watch/cron overrides → threads wf identity + armCron; --cron armed by the RUN, not here; `at`/`in` instead ARM a cron:sched one-shot and return {scheduled,fireAt}), /pause/:instanceId (terminate + arm a resume continuation reusing workspaceId) + /resume/:schedId (advance the sched fireAt to now), /terminate/:instanceId; GET /list, /get/:key, /status/:instanceId; /dapr/subscribe declares workflow-trigger + cron-disarm
│   ├── {watch,chain}.router.ts                       # GET /watch/list, /chain/list (+ GET/DELETE /watch/:instanceId) — registry read surfaces
│   ├── trigger.router.ts                             # POST /workflow-trigger (pub/sub target) – {key, params} events fire the named saved workflow; payload problems ack, infra failures 500 (redeliver)
│   └── cron.router.ts                                # POST /workflow-cron-tick – fires due saved workflows then runs the watch+chain+cron+discover+sched scans (each's failure never fails the tick); GET /cron/list (recur + discover + one-shot cron:sched rows); POST /cron/sched/disarm (disarm a scheduled fire by id); POST /cron-disarm (cloudevents pub/sub target — a finalizing chain's cron teardown, D6; single-writer disarmEventEffect reusing disarmCron). NO POST /cron/discover (§10 — registration is an activity)
├── infrastructure/
│   ├── dapr-workflow-invoker.ts                      # DaprWorkflowClient wrapper (+ raw-HTTP terminate/purge/status)
│   ├── dapr-workflow-store.ts                        # saved-workflow store (Redis): save/get/list/listScheduled/markRun
│   ├── dapr-{watch,chain,cron,wf}-store.ts           # the registry stores (Redis) — watch:*, chain:*, cron:* (recur + cron:discover:* + cron:sched:*), wf:* (exact-key, no index); only workflow-svc writes these
│   ├── github-source-reader.ts                       # ISourceReader adapter over git-core's GitHubClient (reads GH_TOKEN, maps to WorkflowError) — the discovery cron's GitHub read
│   ├── activity-runtime.ts                           # the activity→Effect bridge (shared ManagedRuntime); ActivityEnv widened with CronStore/WorkflowInvoker/WorkflowStore for the arm-* activities
│   ├── activity-registry.ts                          # maps activity name → function
│   └── activities/
│       ├── setup / clone-repo / create-worktree / run-{claude,codex,openhands,pi,dapr-agent,dapr-claude-loop,claude-managed,langgraph} / copy-session .activity.ts  # provisioning + agent-run + output-copy; every run-* honors an optional outputContract step input (validated fenced json → envelope `structured`, mismatch fails the step)
│       ├── write-wf-row.activity.ts                  # the run writes its OWN wf: row (running→done/failed + structured goal: RESOLVED); BEST-EFFORT (§3/§10)
│       ├── register-cron.activity.ts                 # §10 arm-* : arm a recur cron from the run's closing bracket (planCron + guard: the structured block's `pr` for arm-revise); LOUD, idempotent
│       └── register-discover.activity.ts             # §10 arm-* : a provision workflow's step that registers a discovery cron (fired by `h cron discover add`); LOUD
└── infrastructure/workflows/
    └── generic.workflow.ts                           # step-sequencing workflow with $ref/{{token}} resolution; brackets a wf-identified run write-wf-row(running)→steps→arm-cron(if armCron)→write-wf-row(done|failed); resolves the activity NAME too (fire-time identity — unresolved token fails loud); a step may instead be a PARALLEL GROUP {id?, parallel:[steps]} fanned out through ONE whenAll (docs/plans/multi-agent-panel.md — branches resolve against pre-group results only, land under branch ids + a {branchId: result} map under the group id; since 2026-07-24 groups are GENERATED by the CLI's panelize transform from an `--agent` roster (docs/plans/panels-as-a-modifier.md), e.g. `-w answer --agent claude codex --parallel -w answer --agent claude pi` two panels in one stage — the hand-built agent-panel template/kind is retired)

apps/obs-mcp/src/                         # obs-mcp – read-only observability MCP (no Dapr sidecar; port 8013)
├── index.ts                              # composition root – Fastify/MCP; reads ZIPKIN_URL, LOKI_URL, AGENT_RUNS_DIR
├── domain/ports/IObservabilityService.ts # outbound port – traces, logs, run ledger
├── infrastructure/observability-service.ts # Zipkin (HTTP) + Loki (HTTP) + run-ledger (fs) reader
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: trace_search, trace_get, logs_query,
                                          #          runs_list, run_get, system_overview

apps/workflow-mcp/src/                   # workflow-mcp – MCP server for agents
├── index.ts                              # composition root
├── infrastructure/dapr-workflow-service.ts  # calls workflow service via Dapr invoke
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: save_workflow, run_workflow, run_saved_workflow
                                          #          (all params-aware; run tools take a watch policy — durable watcher registration;
                                          #          run_saved takes instanceId/workspaceId/fresh/watch overrides),
                                          #          list_workflows, get_workflow, get_workflow_status,
                                          #          await_workflow (block until terminal, else TIMEOUT),
                                          #          terminate_workflow (short-circuit a running instance)

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
    ├── pi.ts          # PiStrategy – pi CLI --mode json JSONL parser; BYOK provider env routing
    ├── classify-stop.ts # classifyStop → StopReason (completed|usage-limited|timeout|failed): the usage-limit signal, positive-match-only over exit/signal/stderr/result-event (context-window excluded). Wired into parse-stream's buildInvocationResult → InvocationResult.stopReason (orthogonal to success); the usage-limit fallback reads it off the run: mirror
    ├── shared.ts      # shared env helpers
    └── types.ts       # AgentInvoker, AgentEnv/AGENT_ENV_KEYS, LlmConfig, ModelUsage, StopReason, strategy contracts

packages/js/agent-server/src/                # shared HTTP contract for agent services
├── index.ts          # re-exports
├── agent-routes.ts   # registerAgentRoutes – POST /run, POST /setup, GET /dapr/subscribe (workspace dir via resolver, or an explicit cwd e.g. a worktree; /setup idempotent via spec-hash sentinel)
├── clone-route.ts    # registerCloneRoute – opt-in POST /clone (shallow git clone into the workspace)
├── worktree-route.ts # registerWorktreeRoute – opt-in POST /worktree (git worktree of a pre-cloned repo at a shared, agent-neutral path; idempotent; returns { worktreePath })
├── workflow-babysitter.ts # WorkflowBabysitter – submit-and-FORWARD (post-watcher-cutover): translates policy.maxDurationMs into a watch field on the run body (an explicit watch field wins); supervision is workflow-svc's durable watcher engine, no in-process loop; plain fetch, injectable for tests
├── workflow-route.ts # registerWorkflowRoute – the standard agent-service workflow endpoint: POST /workflow {key|steps, params?, instanceId?, workspaceId?, policy?|watch?, watchMeta?} → 202 {instanceId, watching}; GET /workflow/watches proxies workflow-svc's /watch/list (durable global truth)
├── run-ledger.ts     # startRunLedger – per-run summary.json/events.jsonl/output.txt under AGENT_RUNS_DIR + statestore mirror; toolCalls tally counts tool_use blocks nested in claude-CLI assistant events; RunOutcome/RunSummary carry `stopReason` (agent-cli classify-stop) → the run:<id> mirror, read by the watcher's usage-limit fallback (loosely typed to avoid an agent-cli dep)
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
├── git-client.ts          # clone() – shallow, branch-aware git clone (injects GH token into github URLs in-process); addWorktree() – git worktree add off an existing clone
└── github-client.ts       # GitHubClient – read-only GitHub REST over fetch: listOpenIssues (PRs filtered, one page, GH_TOKEN, token-scrubbed errors). The discovery cron's issue read; consumed by workflow-svc's ISourceReader

packages/js/logger/src/
├── index.ts    # Logger interface, re-exports
├── service.ts  # initLogger (Pino), flushLogger
└── simple.ts   # singleCallbackLogger – lightweight stub for tests

packages/js/telemetry/src/
├── index.ts      # re-exports (makeTracingLive, TracingLive, getTracer, contextFromTraceparent, activeTraceparent)
├── tracing.ts    # makeTracingLive(serviceName?) → Effect Layer; acquires a NodeTracerProvider (ZipkinExporter → ZIPKIN_ENDPOINT), registers the W3C propagator, installs @effect/opentelemetry — the OTel SDK spine every JS service uses (see initTracing prose in Observability above)
├── context.ts    # contextFromTraceparent / activeTraceparent — re-attach or capture a W3C traceparent header so cron/activity spans share one trace tree
├── spans.ts      # withSpan helper — thin Effect.withSpan wrapper
└── bridge.ts     # plain-function helpers (getTracer) for code outside the Effect runtime

packages/py/agent-server/src/agent_server/   # Python sibling of js/agent-server (uv workspace member)
├── __init__.py    # re-exports
├── models.py      # AgentRequest, AgentResponse (dataclasses)
├── routes.py      # register_agent_routes + granular register_{run,setup,subscribe}_route (FastAPI); /run records the run ledger
├── run_ledger.py  # record_run – Python sibling of js run-ledger (summary.json/events.jsonl + statestore mirror)
├── workflow_route.py  # WorkflowBabysitter (submit-and-forward, watcher-engine cutover) + register_workflow_route – Python sibling of js workflow-babysitter/workflow-route (stdlib urllib via asyncio.to_thread; POST /workflow, GET /workflow/watches proxies workflow-svc /watch/list)
└── runner.py      # IAgentRunner Protocol – run(request, workspace) → AgentResponse

packages/py/agent-core/src/agent_core/       # shared agent machinery (uv workspace member; tests via `uv run --package agent-core pytest`)
├── react_loop.py  # provider-agnostic ReAct loop + LLMClient protocol (dependency-free base)
├── skills.py      # load_skill_instructions – system prompt from an h skill dir
├── llm/openai.py  # OpenAIChatAdapter over dapr_agents OpenAIChatClient (extra: dapr)
└── workflows/mcp_tools.py  # connect_workflows_mcp + WorkflowTools + open_workflow_tools (workflow-mcp toolset via MCPClient/SSE; extra: dapr)

cli/                                          # early prototype of the h CLI (see cli/README.md)
├── scripts/       # strategy 1 – run-*.sh / invoke-workflow-*.sh + payloads (envsubst/jq); _render.sh bridges to strategy 2
├── charts/workflows/  # strategy 2 – helm as a client-side templating engine; templates/<template>.yaml → run_workflow body (YAML canonical, JSON only at the wire)
└── h/             # the `h` command – Python (Typer + rich), uv workspace member, package h-cli
    ├── src/h_cli/{main,config}.py            # Typer composition root; env-derived settings mirroring the scripts' defaults
    ├── src/h_cli/commands/{feature,template,workflow,chain,watch,cron,schedule}.py  # h feature render|run [--agent]; h template compose|list|get; h workflow list|get|status|publish|run [-p k=v] [--instance-id] [--agent (repeat = panel roster)] [--inline] [--cron/--max-fires] [--at <iso> | --in <dur>] [--fallback-agent/-model/-after/-max]|pause <id> <key> --in <dur>|resume <schedId>|terminate; h chain run (EXPR: -w KEY | -t ATOM… + per-member flags --agent (several names = panel roster → infrastructure/panelize.py)/--model/--fresh/--inline/--kind/--stage/--cron/--max-fires/--id/--capture/--input/--until, --parallel connector, hand-parsed via infrastructure/chain_expr.py — parallel STAGES, inline+cron members, namespaced threading, panel rosters all live)|list; h watch list|get|delete; h cron list (recur + discovery rows), h cron rm REPO SLUG WORKFLOW (disarm a recur cron — POST /cron/disarm, single-writer), h cron discover add <repo> --label --cadence [--workflow] [--max-per-day] [--run-budget-mins] [--run-retries] [-p k=v] (fires a provision workflow — §10, no POST /cron/discover); h schedule list|rm <id> (the one-shot cron:sched surface — a thin view over cron:sched:* rows; also visible in `h cron list`)
    ├── src/h_cli/infrastructure/             # helm subprocess adapter, statestore/agent/svc/agent-service httpx clients
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
locally — into whatever `.mcp.json` the cwd already has, creating it when absent. The provisioning
mode is `MCP_CONFIG_MODE` (validated at startup — any value other than `merge`/`replace` fails the
service, fail-closed): the default `merge` (`mergeMcpConfig`) preserves the cwd's own servers and
other top-level keys and lets h's servers win on a name conflict, so an agent running in a worktree
of a repo that ships its own `.mcp.json` (e.g. a target repo's `tessl` server) still gains h's
`dapr`/`obs`/`workflows` servers; `replace` discards the cwd's config entirely so an agent
executing untrusted specs never inherits any target-repo servers (whatever the repo), and a missing
`MCP_CONFIG_SRC` aborts the run instead of silently skipping the rewrite. `replace` is currently set
nowhere — it's the general knob a minimal-surface per-run trust profile would use if untrusted
third-party repos return (docs/plans/reviewer-identity-security.md); under today's trust model every
run is `merge`. Docker deployments mount
`.mcp.json` directly; in Kubernetes the ConfigMap is mounted at `/workspace/claude-agent/.mcp.json`.

### h skills (harness skill source)

h provides its own agent skills, kept at the repo-root `skills/` dir — not inside any agent app, so
they stay reusable across agents and the agent services stay thin. A workflow setup step copies them
into a CLI agent's user-global `~/.claude/skills/` (`cp -r $H_SKILLS_DIR/* ~/.claude/skills/`).
`H_SKILLS_DIR` is the repo `skills/` locally (set by the agent run scripts) and a read-only mount
(`./skills:/h-skills`) in compose. Current skills: `linear` (read a Linear issue headlessly via
`LINEAR_API_KEY` with `get-issue.sh`, post comments back with `add-comment.sh` — the hosted Linear
MCP can't authenticate unattended), `analyze-workflow-run` (correlate every observability source for
a run), `workflow-orchestrator` (turn a task into a saved/run/monitored workflow via the
workflows MCP), `h-issues` (file a well-formed improvement issue on the h repo — h only; other
repos carry their own conventions — with `create-issue.sh`, which refuses to self-apply the
`agent-approved` trust label), and `author-workflow-template` (the authoring recipe for chart
templates: the template gate, render modes, the output contract in its three places, the
one-declarer composition rule, goldens, publish — for any agent creating or modifying a template,
incl. h-builds-h feature runs). A **Python** agent consumes a skill's body directly as its system prompt via
`agent_core.load_skill_instructions` — workflow-agent loads `workflow-orchestrator` this way (the
same source a CLI agent gets), so the orchestration procedure has a single home. This is a skill
source alongside the tessl registry (org-published plugins) and a repo's own `.claude/` skills.
Skills install unconditionally on every setup; Claude Code marketplace plugins are provisioned
per-run via `h.pluginSetupSteps` in the setup step — only when the `plugins` fire-time param is
non-empty (distinct from skills, which copy on every run regardless).

## Observability

`workflowInstanceId` is the join key across every surface — it is the Dapr workflow instance id, the
default agent workspace key, a Zipkin span attribute, and the group key of the run ledger.

- **Traces → Zipkin.** Every service calls `initTracing` (JS) / `init_tracing` (Python) → OTLP/Zipkin
  at `localhost:9411` (docker: `zipkin:9411`), W3C-propagated. Activities thread the originating
  `traceparent` as workflow-input data and re-attach via `contextFromTraceparent` so a run is one trace
  end-to-end — including the cron path (the tick captures `activeTraceparent()`). k8s tracing is off
  (`samplingRate: "0"`).
- **Run ledger → "what the agent did".** Every agent run writes, best-effort,
  `{AGENT_RUNS_DIR}/<instanceId|workspaceId>/<agentId>-<ts>/{summary.json,events.jsonl,output.txt}` on the
  shared volume (`AGENT_RUNS_DIR` defaults to `<AGENT_BASE_DIR>/../.runs`), and mirrors a compact
  `run:<runId>` record + `runs:index` into the statestore — so runs are queryable via `dapr-mcp` too.
  The JS capture lives in `agent-server`'s `startRunLedger` (events arrive via the runner's `onEvent`);
  the Python sibling is `record_run`, called from the shared `/run` route. The run ledger is also the
  read path for a completed run's output — including the validated structured block at the end of
  `output.txt` (obs MCP `runs_list`/`run_get`, or the `run:<id>` mirrors via dapr-mcp);
  `GET /workflow/status/:instanceId` does not surface `serializedOutput`, so don't poll it for results.
- **Logs → Loki.** Alloy scrapes **dockerized** containers only; host-run `dapr run` apps (the usual
  `make dev-tab` mode) do not reach Loki — use traces + the run ledger for app/agent activity.
- **Viz (web/).** **Status: EXPERIMENTAL — research phase, not a shipped product.** `web/` is a
  deliberate sandbox for exploring how to *visualize* h's runtime (workflows, chains, and the
  watcher/cron engines) with D3 v7 as the drawing library. Multiple layout variants coexist behind a
  switcher precisely because the right visual language is still an open question — expect churn, dead
  ends, and byte-frozen "we liked this one" baselines (e.g. `orbits`) sitting beside their in-progress
  successors (e.g. `engines`). Treat the plan doc (docs/plans/workflow-viz.md) as the running research
  log, not a spec. It is intentionally OUTSIDE the `apps/*` bun-workspace glob (own package.json,
  `bun install` inside it) so this experimentation never taxes the production build/lockfile machinery;
  don't wire it into turbo, Dockerfiles, or CI as if it were a service. It renders the runtime as a
  live force-directed graph: instance circles colored by status (pulsing while RUNNING) and sized by
  cost, chain diamonds with ordered member edges, amber watch rings, cron clock-squares, per-agent
  satellite run dots, a details panel with lazy run output. `bun run dev` (port 5173) proxies
  `/svc/*`→workflow-svc:8003 and `/obs/*`→obs-mcp:8013, which serves the run ledger as plain JSON at
  `GET /api/runs` / `GET /api/run/:id` beside its MCP surface. Read-only by design: the viz never
  mutates runtime state — the CLI and MCP surfaces stay the only write paths.
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
bun run lint     # tsc --noEmit + oxlint + oxfmt --check (+ dependency-cruiser on the hex services)
bun run format   # oxfmt src
bun run test     # vitest run
```

Architecture is linted, not just conventional: `make lint` (`lint-js` + `lint-py`) enforces the
hexagonal boundaries — a pure `domain/`, adapters that never import each other, no cycles — via
`dependency-cruiser` (`.dependency-cruiser.cjs`, wired into the hex TS services' `lint` scripts) and
`import-linter` (`[tool.importlinter]` in each hex agent's `pyproject.toml` — `workflow-agent`,
`langgraph-agent`, and the standalone `claude-managed-agent` — run over the flat namespace packages
with `src` on the path). See [ARCHITECTURE.md](./ARCHITECTURE.md#boundaries-enforced).

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
- **Toolchain guard — `tsc` can silently no-op (hollow green)** — the per-package `lint`/`build` scripts call `tsc`, resolved via `node_modules/.bin/tsc`. Bun's store can leave that pointing at a **0-byte `bin/tsc` stub**, so `tsc --noEmit`/`tsc -p …` exit 0 while doing NOTHING — turning `bun run lint` into a typecheck that checks nothing and `bun run build` into a build that emits no `dist/` (turbo faithfully runs `tsc`; `tsc` faithfully does nothing). Root `package.json` guards this: `lint` and `build` run `node scripts/check-tsc.mjs` FIRST, which asserts `tsc` reports a version AND catches a deliberate type error, AND (native mode) that turbo/oxlint/oxfmt/tsgo are non-0-byte and turbo actually runs — a broken toolchain now fails LOUDLY with the repair recipe instead of passing silently. The `cli/scripts/run-*.sh` build path (which calls `bunx turbo build` directly, bypassing the package.json guard) preflights `node scripts/check-tsc.mjs --native-only` before the build, so a hollow turbo can no longer make the host stack silently fail to start. If it fires: `rm -rf node_modules && bun install`; the compiler itself is healthy and can be run directly via `node node_modules/typescript/lib/_tsc.js` (typechecks + emits). The repo pins `typescript@^6.0.2` (JS transition release) alongside `@typescript/native-preview` (tsgo) + `oxlint-tsgolint`. Do not trust a bare `turbo lint`/`turbo build` if the guard was bypassed. (Bit us live 2026-07-18; see memory `tsc-launcher-noop`.)
  - **Root cause + the whole-toolchain variant (found live 2026-07-19):** the hollow stubs are not random — they are the NATIVE binaries only (turbo, oxlint, oxfmt, tsgo, tsgolint, tsserver; JS-entry tools like vitest and `_tsc.js` stay intact), and they go 0-byte when **`bun install` cannot hardlink them out of the global cache** (`~/.bun/install/cache`). The trigger is a **cross-uid poisoned cache under `fs.protected_hardlinks=1`**: an agent/container process running as a *different* uid (e.g. `10001`, the non-root `SUB_AGENT_UID` fleet identity) does `bun install` and populates the SHARED cache with entries it owns; the host user (uid 1000) then cannot hardlink those foreign-owned cache files (the kernel forbids hardlinking a file you don't own), so `bun install` logs `EPERM: Operation not permitted: failed to link package …` and leaves 0-byte placeholders — every `bunx turbo`/`oxlint`/`oxfmt` then exits nonzero with NO output, and every `run-*.sh` (which starts with `bunx turbo build`) fails silently → the whole host stack can't come up. Diagnose: `find node_modules/.bin -maxdepth 1 -type l | while read l; do t=$(readlink -f "$l"); [ -f "$t" ] && [ ! -s "$t" ] && echo "HOLLOW: $l"; done`; confirm with `cat /proc/sys/fs/protected_hardlinks` (=1) and the cache entry's owner (`stat -c %u ~/.bun/install/cache/@turbo/linux-64@*/bin/turbo`). **No-sudo fix (preferred — heals the default cache in place, validated live 2026-07-19):** drop the foreign-owned entries and reinstall against the same cache — `find ~/.bun/install/cache -mindepth 1 ! -uid $(id -u) -print0 | xargs -0 -r rm -rf --` then `rm -rf node_modules && bun install --frozen-lockfile` (bun re-fetches just the removed packages as YOU, hardlinks the rest; the parent cache dirs are yours so you can rm the foreign files without sudo). **Sudo alternative:** `sudo chown -R $(id -u):$(id -g) ~/.bun/install/cache` (heals ownership without re-download), then reinstall. `--backend=copyfile` alone does NOT reliably repair it (it skipped the optional `@turbo/linux-64` platform dep and still produced hollow bins). And **prevent recurrence at the source** (DONE 2026-07-20): a dropped-uid agent process must not write to the host `~/.bun`. agent-cli's `run-process.ts` `isolatedSubAgentEnv` now points a dropped `SUB_AGENT_UID`'s `BUN_INSTALL_CACHE_DIR` at a per-uid dir it OWNS (`/tmp/bun-cache-uid-<uid>`), so its installs hardlink from its own cache and can't poison a shared one — `sudo --preserve-env` still carries `HOME` (the CLI needs it for `~/.claude`), only bun's cache is redirected. (An explicit `BUN_INSTALL_CACHE_DIR`, e.g. a group-writable `setgid`+`AGENT_GID` cache that group members can hardlink, wins.)
- **Architecture is linted (hex boundaries)** — the hexagonal layering is machine-enforced, not just conventional (see [ARCHITECTURE.md](./ARCHITECTURE.md#boundaries-enforced)). TS: the root `.dependency-cruiser.cjs` codifies the rules (pure `domain/`, `presentation/`↔`infrastructure/` independence, no cycles) and each hex TS service (`workflow-svc`, `dapr-mcp`, `obs-mcp`, `workflow-mcp`) runs `depcruise --config ../../.dependency-cruiser.cjs src` in its `lint` script — a new hex TS service MUST add that suffix; `scripts/check-hex-lint.mjs` machine-checks every TypeScript package with a `src/domain/` or `src/presentation/` directory, and `turbo.json`'s `lint.inputs` lists the config so an edit busts every lint cache. Python: `import-linter` `[tool.importlinter]` contracts in every full-hex agent's `pyproject.toml` (`workflow-agent`, `langgraph-agent`, and the workspace-excluded standalone `claude-managed-agent`, whose contracts run in its own env), executed by `make lint-py` with `PYTHONPATH=src` (the apps are flat namespace packages, so `domain`/`infrastructure`/`presentation` must resolve as top-level roots; `include_external_packages = true` lets the domain-purity contract forbid I/O libs). Thin agents with only an `infrastructure/` layer (`dapr-agent`, `dapr-claude-loop-agent`) carry no contract — their domain contract lives in the shared `agent-server` package, so there is no in-service boundary to guard. The Python apps' ports are `Protocol`s in `domain/ports.py` (structural — the concrete adapters satisfy them without importing them, so the composition root wires unchanged); the `I`-prefix matches the JS ports (`IWorkflowStore`, `IAgentRunner`). A new Python hex agent adds `import-linter` to its dev group + a contract block. `make lint` runs both stacks. Content invariants are guarded the same way: `bun run lint` also runs `node scripts/check-templates.mjs`, which fails if any `cli/charts/workflows/templates/*.yaml` drives a bare `git push --force`/`-f` — force-pushes must use `--force-with-lease` (memory `force-with-lease-convention`; the first consumer is `revise`'s rebase). A new template with push prose inherits the guard automatically. **Actively look for hardening opportunities: when you touch this codebase and find an architectural invariant that a machine isn't checking — an unguarded layer boundary, a single-writer registry anyone could write, a naming/identity convention — encode the guard as part of that change, not a follow-up (the *Harden by encoding* principle in [ARCHITECTURE.md](./ARCHITECTURE.md#principles)). An unenforced boundary drifts.**
- **`GH_TOKEN` for private-repo clones** — the `clone-repo` activity calls claude-agent's `/clone`, which uses the `git-core` package to shallow-clone into the workflow workspace. `git-core` injects `GH_TOKEN` into `https://github.com/…` URLs in-process (as a git argument, no shell), so the token never appears in the workflow definition, task entry, or logs. Wired into claude-agent via `docker-compose.yml` and `cli/scripts/run-claude-agent.sh`; leave unset for public repos.
- **SQLite name resolver** — `dapr/local/appconfig.yaml` configures `nameresolution.sqlite` with a shared file at `/tmp/dapr-h-nr.db`. This is required on macOS with Rancher Desktop because mDNS multicast is unreliable across multiple virtual network interfaces. The file is auto-created at sidecar startup and cleared on reboot (fine — sidecars re-register on start). **Observed failure mode (2026-07-05):** all five host-run sidecars fataled simultaneously with `fatal: Host registration lost` — the shared WAL file hit a checkpoint/lock stall during concurrent lease renewal and expired every registration at once. Two mitigations are in place: (1) **NR hardening** — `dapr/local/appconfig.yaml` sets `busyTimeout: "10s"` as a first-class metadata property in the `configuration:` map; Dapr's sqlite NR component (built on modernc.org/sqlite + components-contrib) exposes this as a dedicated knob that makes sidecars retry on `SQLITE_BUSY` for up to 10s instead of immediately fataling. WAL mode is already the component default (`disableWAL: false`) — no extra config needed. A rejected metadata key fails loudly at component init, so a misconfigured value surfaces immediately on startup. (2) **supervised layout** — `make h-builds-h-tab` (`.zellij/h-builds-h.kdl`) uses `cli/scripts/_supervise.sh` instead of `_pane.sh` so every service restarts automatically on exit with capped exponential backoff (2s→30s, reset to 2s after a healthy run), making the unattended cron loop self-healing.
- **SQLite name resolver in COMPOSE too** — `dapr/appconfig.yaml` (the config the compose sidecars mount) also uses `nameResolution: sqlite`, sharing one DB on a named volume (`dapr-nr`, mounted at `/nr` on every `-dapr` sidecar). Before this, compose used the self-hosted default (mDNS), which caches a callee's `(IP, internal-gRPC port)`; on `--force-recreate` the new sidecar comes up on a fresh ephemeral port while the cached entry still points at the old one → `connection refused` until the mDNS TTL expires (the "warm the invoke path after a recreate" dance). The SQLite resolver re-registers the current address on start, so a caller resolves the fresh port immediately — a recreate needs no warm-up. **Two compose-specific requirements:** (a) the daprd image runs **nonroot (65532)** and named volumes are `root:root`, so the sidecars set `user: "0:0"` to write the shared `/nr` DB (they're Dapr infra sidecars, separate containers from the non-root agent apps — this does NOT touch the agent process-identity model); (b) all sidecars must agree on the resolver, so switching requires recreating **every** sidecar (a half-migrated mDNS↔sqlite stack can't resolve across the split). The 2026-07-05 concurrency caveat above applies more here (11 sidecars vs local's ~6) — `busyTimeout: "10s"` is the mitigation; watch for WAL lock-stalls under heavy churn.
- **`actorStateStore: "true"`** in both statestore YAMLs is load-bearing for Dapr Workflows, which ride on the actor runtime. Missing it → cryptic actor-runtime failure at startup. It also backs `dapr-mcp`'s `GenericActor` state — it's the single auto-discovered actor state store, shared by all actor-hosting apps. Actor state is composite-keyed by `appID || actorType || actorId || key`, so `dapr-mcp` (`GenericActor`) and `workflow-svc` (internal workflow/activity actors) never collide.
- **`dapr-mcp` dual listeners** — the `@dapr/dapr` JS actor SDK hosts actors via `DaprServer`, which is express-based and owns its own HTTP listener; it cannot share Fastify's socket. So `dapr-mcp` runs the `GenericActor` host (express) on `ACTOR_APP_PORT` and serves MCP-SSE on `APP_PORT` (Fastify) in the same process. Dapr's `--app-port` points at the **actor port** (8012 local / 8010 in compose), because the sidecar calls actor callbacks there; MCP clients connect directly to `APP_PORT` (8011). The local actor port is **8012, not 8021** — on macOS a `launchd` daemon already listens on `127.0.0.1:8021`, so binding the actor host there fails with `EADDRINUSE` (the JS SDK logs an optimistic `Listening on 8021` first, then the async bind error surfaces as `Failed to start server. Is port 8021 in use?`). Startup order is load-bearing: `registerActor → waitForSidecar → DaprServer.start → actor.init` (`start()` does not auto-call `init()`).
- **`cron-tick` binding → `workflow-agent`** — `dapr/cron.yaml` (and `dapr/local/cron.yaml`) is a `bindings.cron` component scoped to `workflow-agent`; Dapr POSTs to `/cron-tick` on that app on the configured schedule. The route name must equal the binding name. No k8s copy (workflow-agent is local/compose-only, like the other Python agents).
- **`workflow-cron-tick` binding → `workflow-svc`** — `dapr/workflow-cron.yaml` (and `dapr/local/`) is a second `bindings.cron`, scoped to `workflow-svc`, POSTing `/workflow-cron-tick` every 60s. The handler scans saved workflows and fires any whose cron `schedule` is due (next fire after `lastRunAt`, else `savedAt`, has passed), stamping `lastRunAt` — stamp-forward means missed fires self-heal (one fire, no catch-up storm); `disabled: true` skips. **Gotcha:** Dapr probes an input binding with `OPTIONS`, and both the probe and the tick arrive as `application/json` with an empty body — Fastify 404s an unhandled method and 400s an empty JSON body, either of which makes Dapr log "app has not subscribed". So the route lives in an encapsulated Fastify plugin scope with its content-type parsers cleared, and answers both POST and OPTIONS.
- **Reusable workspaces (`workspaceId`)** — a workflow may carry a top-level `workspaceId`; agents key their workspace dir on `workspaceId ?? workflowInstanceId`, so a recurring/cron workflow reuses one provisioned dir instead of a fresh per-run one. `/setup` is idempotent: it hashes the setup spec into `.agent-setup-complete` and short-circuits on an unchanged spec, so skills/config are installed once. `workspaceId` is injected into every step by `generic.workflow.ts` and persisted on saved workflows.
- **Host ⇄ compose workspace interchangeability** — the agent workspace root (`../h-workspace`) is SHARED by both modes, but each writes it as a DIFFERENT uid (host run-scripts = your uid; compose agents = `agent-svc`, uid/gid **10001**), so whichever ran first would own the pre-clone + worktrees and lock the other out (a cross-uid filesystem problem — same class as the poisoned bun cache above). Two changes make the modes interchangeable so the IDENTICAL config runs in either: **(1) mode-agnostic paths** — the worktree pre-clone path is NOT baked. `values.yaml`/`values.local.yaml` leave `clonePath` EMPTY, so the agent's `/worktree` route defaults `repoPath` to `<sharedRoot>/repo` (resolved from `AGENT_BASE_DIR` — host `…/h-workspace/repo` ≡ compose `/workspace/repo` via the bind mount), and `cli/scripts/clone.sh` pre-clones there (its default dir is `repo`). Baking a mode-specific `clonePath` (e.g. `/workspace/h`) breaks host mode — this bit us live 2026-07-20 (create-worktree `cannot change to '/workspace/h'`). **(2) shared `AGENT_GID` ownership** — run `sudo cli/scripts/setup-agent-workspace.sh` ONCE (idempotent): it group-owns the workspace by `AGENT_GID` (10001, the container's `agent` group), setgid + group-writable, and adds you to the group; the host run-scripts set `umask 002` (via `_lib.sh`) and compose runs as gid 10001, so files EITHER mode creates stay group-writable and both modes share the workspace. **`_lib.sh` also SELF-HEALS the membership-in-effect gap** (`_agent_enter_group`, added 2026-07-21): supplementary groups resolve at LOGIN, so a shell started before `setup-agent-workspace.sh` ran its `usermod` — or any long-lived / automated session — carries your groups WITHOUT `agent` (gid 10001) even though `/etc/group` lists you; since group-write only helps group MEMBERS, such a host process can't touch compose-created (gid 10001) files and mkdir-EACCESes the shared workspace. The self-heal detects it (member on paper via `id -nG <user>` — the NSS/DB lookup, NOT the live process's group set — while the live process lacks the gid) and `exec sg agent`-re-execs the run script, so every host launch carries the group with NO re-login / sudo / chown. Two subtleties it encodes: `id -nG <user>` (not a bare `id -nG`, which reads the very-process-that-lacks-it), and capturing the run-script path at `_lib.sh`'s TOP LEVEL (inside the function `BASH_SOURCE[1]` is _lib.sh's own call site, not the sourcing script). Validated live 2026-07-21 — a host-mode two-panel chain (`agent-panel ∥ agent-panel → feature ⊕ verify ⊕ create-pr`) opened PR #53, then a `loop-until-clean` review→revise loop drove it review-clean. (Earlier: 2026-07-20 PR #52, feature-pr → pr-review → revise.) Full setup: docs/h-builds-h-runbook.md; see memory `agent-process-identity`.
- **Grooming workflow shared-context pattern** — the `cli/scripts/invoke-workflow-grooming.sh` grooming workflow uses a symmetrical naming scheme: the Dapr workflow instanceId, the file the groom step writes, and the actor used to persist findings are all keyed by the same id (`groom-${ISSUE_ID}`). The groom step writes `groom-${ISSUE_ID}.md` into the worktree cwd (file-based handoff, reliable across steps in the same workflow) AND calls `actor_state_set(actorId='groom-${ISSUE_ID}', key='findings')` via dapr-mcp (actor-based, durable in Redis, inspectable from any session via `actor_state_get`). The writeback step reads the file with `cat`; any external session can read the actor state. `--dry-run` sets `DRY_RUN=1` in the task payload so workflow-agent builds only the first three steps. The script seeds the task and POSTs to workflow-agent (same pattern as `invoke-workflow-agent.sh`) so the trace is end-to-end: workflow-agent → workflow-mcp → workflow-svc → claude-agent.
- **Chart-rendered workflows (`cli/charts`)** — `helm template` is used purely client-side (no cluster) to render a workflow template into a `run_workflow` request body. YAML is the canonical artifact; JSON conversion is a final processing step at the wire boundary only (`_render.sh: yaml_to_json` / `h_cli.infrastructure.helm: to_wire_json`). Delimiter coexistence is deliberate: engine tokens (`{{step.field}}`) are emitted via the `h.token` helper (`printf`), agent-side `$VARS` are inert text, and `{"$ref": ...}` needs nothing. The syrupy goldens in `cli/h/tests` are the chart's contract tests — rendered hermetically (`include_local=False`, so a dev's gitignored `values.local.yaml` can't skew them) from the hostile fixture; re-bless with `--snapshot-update` only deliberately, reviewing the `.ambr` diff. Org-specific chart defaults live in `cli/charts/workflows/values.local.yaml` (gitignored, auto-merged by both render paths).
- **Chart template gate (`--set template=<name>`)** — helm evaluates *every* template even under `-s`, so one template's `required` values would break every other template's render. Both render paths (`_render.sh`, `h_cli.infrastructure.helm`) pass `--set template=<name>` and each template body is wrapped in `{{- if eq .Values.template "<name>" }}`. A new template MUST add this gate or it breaks all existing renders. (The `template` value was named `group` before the 2026-07-08 vocabulary migration.)
- **Publish mode / templates** — `--set publish=true` renders a template with per-run inputs as `{{params.*}}` engine tokens and no instanceId: a parameterized saved workflow. `h workflow publish <template>` saves it; fire with `h workflow run <key> [-p k=v]... [--agent A] [--model M] [--fresh] [--instance-id readable-id] [--via routing-agent]`, `run_saved_workflow` (MCP), or a `workflow-trigger` event. **Content-values vs machinery is the CLI's load-bearing split:** a template's content-param space is unbounded, so every CONTENT value is populated with `-p key=value` (`@path` splices a file) — slug, spec, issueNumber, and any custom param. FLAGS are the closed machinery vocabulary — the finite *how-it-executes* set: `--agent` (executor — expands via the shared `AGENT_IDENTITY` table to `runActivity`/`agentId`) and `--model` (sets the `model*` slots) are execution machinery; `--via` is the routing axis (submit through an agent's babysitter); `--fresh`/`--instance-id`/`--watch` are run mechanics. (`h chain run` keeps its own machinery flags — `-w`/`-t`/`--parallel`/`--kind` — because it *composes*, not populates.) Params resolve like step results (`{{params.x}}` / `$ref`), seeded under the reserved results id `params` — a step must not use that id. Fire-time params merge over stored defaults key-by-key.
- **Fire-time identity (identity-as-params)** — publish-mode renders emit the identity fields as tokens (`activity: "{{params.runActivity}}"`, `agentId`, per-step `model*`) plus a rendered `params:` defaults block: values.yaml/values.local.yaml supply DEFAULTS, not finals. `toRequest` merges fire-time params over stored defaults; `generic.workflow.ts` resolves the activity name (unresolved token or unknown activity fails the step loud, never a silent default agent). Override per fire with raw params (`-p runActivity=run-openhands -p agentId=openhands-agent`) or, uniformly across BOTH `h workflow run` and `h chain run`, with `--agent claude|openhands|pi` → the shared `AGENT_IDENTITY` table in `cli/h/src/h_cli/config.py` (`agent_identity_params`). Saved workflows published BEFORE identity params have no slots — `--agent` seeds inert params (chain fails loud; republish to open slots). Exception: pr-review's executor is pinned (not parameterized) to claude-agent, the loop's consistent reviewer — `--agent` on it warns and keeps claude-agent. Under the trust model this pin is operational, not a security boundary (docs/plans/reviewer-identity-security.md — a minimal-surface reviewer returns as a per-run trust profile if untrusted repos do). Non-publish renders bake identity literals exactly as before.
- **`workflow-trigger` topic (triggers as data)** — workflow-svc subscribes to this single well-known topic; an event `{key, params}` fires the named saved workflow (the pub/sub sibling of `POST /workflow/run/:key`). One topic, not per-template topics, because Dapr subscriptions are declared at sidecar startup. Payload problems (unknown key, disabled, malformed) are *acked* as `{skipped}`; infra failures 500 so Dapr redelivers. The plugin-feedback → plugin-improvement flow is this pattern: a `plugin-improvement` chart template + a trigger event — no domain routes in any agent service.
- **Re-firing an existing instanceId ATTACHES by default (`fresh` opt-in)** — the invoker reuses a RUNNING/PENDING instance, and since the `fresh` flag landed it also returns a TERMINAL instance as-is instead of purging and re-running it (Dapr durability is the standard; purge-and-rerun was a test-flow convenience). Opt in per fire with `fresh: true` — `h workflow run <key> --fresh`, `h feature run --fresh`, the `fresh` param on `run_workflow`/`run_saved_workflow`, or the field on any `/workflow/run*` body / babysitter submit. A retry that must actually re-execute a FAILED instance under the same id needs `fresh: true`.
- **Standard `POST /workflow` (submit-and-forward) + the watcher engine** — every agent service registers the endpoint from the shared agent-server packages: `{key|steps, params?, instanceId?, workspaceId?, policy?|watch?, watchMeta?}` → `202 {instanceId, watching}` immediately. Supervision is DURABLE and engine-owned: every workflow-svc fire path (HTTP run routes, trigger events, cron) writes a `watch:sub:<instanceId>` row in the same handler that schedules; the workflow-cron-tick scan (60s) enforces the wall-clock budget (terminate, default 45 min), runs engine-owned retries (`retry: {maxAttempts, fresh}` — re-fires the same id with purge), finalizes outcomes with a cost tally off the `run:` mirrors (zero matches → `costGap`, never a silent $0), writes `watch:ledger:<date>`, and publishes terminal `workflow-events`. Rows are epoch-fenced: any re-fire of an id (including `fresh` without a watch) bumps `epoch` so a stale scan decision no-ops. Kill switch: `state_save watch:config {enabled:false}` (the heartbeat `watch:__tick__` records disarmed vs dead). Escalations (`escalate: {onOutcome, key}`) are fail-closed on `watch:config.maxEngineFiresPerDay`. Machines run the scan; agents are only for judgment — never build orchestration on an agent looping `await_workflow`. `workflow-agent` is NOT the exclusive workflow entry point. Inspect with `h watch list` / `GET /watch/list`.
- **MCP servers are agent-runtime dependencies** — `dapr-mcp`/`obs-mcp`/`workflow-mcp` down doesn't just blind human observability: agent runs silently lose those tools (observed: a run skipped its `actor_state_set` persistence without erroring because dapr-mcp was down). Workflow task prose that depends on an MCP tool should require the agent to report tool-unavailable explicitly; keep the MCP set running whenever agents run.
- **Worktree fetch-before-branch** — `addWorktree` in `packages/js/git-core/src/git-client.ts` accepts a `remoteBase` option. When set (and no explicit `baseRef` is given), it fetches `origin/<remoteBase>` before cutting the new branch, so the worktree starts from the latest remote tip rather than the potentially-stale local checkout. The `/worktree` route in `agent-server` defaults `remoteBase` to `"main"` for all worktree-cutting workflows (grooming, feature-request, triage). Pass `remoteBase: ""` explicitly to opt out.
- **Run ledger is best-effort** — observability must never break a run, so every ledger write (the `AGENT_RUNS_DIR` files and the statestore mirror) swallows errors; the on-disk files are the source of truth. The `runs:index` / `run:<id>` keys follow the flat-keyspace convention so `dapr-mcp` can read them. `obs-mcp` reads Zipkin/Loki over HTTP and the ledger off `AGENT_RUNS_DIR` (fs) — it has **no Dapr sidecar**, so its `--app-port` (8013) is just the MCP listener.
- **Statestore shared keyspace** — the Redis state store sets `keyPrefix: none`, so keys are global (no app-id prefix). This is deliberate: it lets any service — and `dapr-mcp` — read each other's keys (e.g. `task:…`, `tasks:index`, `__workflow_index__`, saved workflow keys) for dogfooding/inspection. Actor/workflow runtime state uses its own composite keying and is unaffected. With a flat keyspace, avoid key collisions across services — a registry prefix names the single component that owns writing it (the existing keys: `task:`, `feedback:`, `__workflow_index__`, `watch:` — the watcher engine's registry (`watch:sub:<instanceId>`, `watch:index`, `watch:config`, `watch:__tick__`, `watch:ledger:<date>`), written ONLY by workflow-svc; `chain:` — the chain engine's registry (`chain:sub:<chainId>`, `chain:index`, `chain:config`, `chain:__tick__`, `chain:ledger:<date>`), the sibling of `watch:` that sequences workflows (a chain FIRES THE NEXT workflow where a watch RE-fires one instance), also written ONLY by workflow-svc — one writer per key is a design invariant, everyone else reads). **Path-position state keys must be percent-encoded**: Dapr's state HTTP API carries the key in the URL path on get/delete but in the body on save, so a key embedding a `/` (the repo segment in `wf:owner/name:…`, `cron:sub:owner/name:…`) saves fine yet 404s (`ERR_DIRECT_INVOKE`) on every read. Every `@dapr/dapr` `state.get`/`state.delete` call site wraps its key in core-dapr's `pathStateKey` (the sidecar URL-decodes the segment, so stored keys stay raw); a new store MUST do the same. The `check-state-keys` content guard deliberately treats every `.state.get(...)` and `.state.delete(...)` in scanned production TypeScript as a Dapr call; unrelated APIs must avoid that shape or be kept outside those source trees, so the broad match cannot silently miss a Dapr call. Found live 2026-07-15 — no `cron:sub:*` row had ever landed for a slashed repo.
- **`docker-compose.local.yml`** — required for local dev (`--profile infra`). Overrides the scheduler's broadcast address to `localhost:50007` so host-side daprd processes can reach it. Without it the scheduler advertises its internal Docker IP, unreachable from the host on macOS. Never use this file with full-Docker profiles — Docker containers resolve `localhost` as their own loopback, not the scheduler container.
- **`docker compose down -v`** — always pass `-v`. Without it the scheduler's etcd volume persists and can replay a prior workflow on next startup.
- **Compose env precedence (shell exports shadow `.env`)** — compose interpolates `${VAR}` from the process environment FIRST, the project `.env` file second. The user profile exports `GH_TOKEN`, so after editing a secret in `.env` a plain `docker compose … --force-recreate` silently stamps the OLD exported value back into the containers. **Encoded fix: always invoke compose via `cli/scripts/compose.sh`** (same args as `docker compose`; it strips every key defined in `.env` from the process env first, making `.env` the exclusive source for the keys it defines) — the Makefile targets and README commands all route through it, and the guard is STRUCTURAL: `docker-compose.yml`'s `x-h-compose-guard` key references `${H_COMPOSE:?…}`, which only the wrapper sets, so raw `docker compose` (any subcommand — interpolation runs at file parse) fails loud with a pointer to the wrapper. If containers still look stale, verify with `docker exec <ctr> printenv GH_TOKEN` against `.env`. Applies to every var in `.env`, not just `GH_TOKEN`. Bit us live 2026-07-16 (two stale recreates of claude-agent).
- **Local port allocation** — every `cli/scripts/run-*.sh` pins a unique set of ports (app, `--dapr-http-port`, `--dapr-grpc-port`, `--dapr-internal-grpc-port`) so any combination can run simultaneously without collision; the full map is in `README.md`. All sidecars pin a distinct `360xx` gRPC port and a `610xx` internal-gRPC port. On Linux (default ephemeral range 32768–60999), the `610xx` internal-gRPC ports sit above the ceiling — removing that exposure for internal-gRPC specifically. The `360xx` sidecar API gRPC ports remain inside the Linux ephemeral range (residual exposure); `net.ipv4.ip_local_reserved_ports` is the sysctl to protect all pinned ports. On macOS (ephemeral range 49152–65535) the `610xx` ports fall inside it, so the residual applies on both platforms. `50006`/`50007` (placement/scheduler) bind inside containers and are unaffected. `dapr-mcp` additionally runs a second app listener on `ACTOR_APP_PORT` (8012 local / 8010 compose) for actor callbacks — that, not the MCP port, is its Dapr `--app-port`.
- **Run scripts are idempotent** — each `cli/scripts/run-*.sh` sources `cli/scripts/_lib.sh` and calls `stop_stale <app-id> <ports…>` before `exec dapr run`. This runs `dapr stop --app-id <id>` then force-frees the app/http/grpc ports it pins (SIGTERM, then SIGKILL if still bound), so re-running a script cleanly replaces a prior instance instead of failing with `invalid configuration for HTTPPort. Port N is not available`.
- **Headless host-mode bring-up (agent-friendly, no zellij/TTY)** — the `make dev` / `make h-builds-h` zellij layouts are the INTERACTIVE view (one pane per service, for a human to watch); each `run-*.sh` they launch blocks in the foreground, so they can't be driven unattended. The DETACHED sibling is `cli/scripts/up-local.sh` (`make up-local` / `up-local-wait` / `down-local`, `MODE=dev|h-builds-h`): it launches every service for a mode under `_supervise.sh` in a `setsid` process group (logs → `.local-logs/<svc>.log`, pidfiles under `.local-logs/pids/`) and RETURNS immediately; `wait-local.sh` gates readiness by TCP-probing each service's app port (the only host-mode "stack UP" signal — compose healthchecks don't apply to `dapr run`). This is the canonical way for an agent to stand up local mode from scratch: `make infra-up` (control plane in compose) → `make up-local-wait` (services on the host) → work → `make down-local`. A true from-scratch reset also needs `compose … down -v --profile all` AND clearing the `./dapr-etcd` **bind** mount (not a named volume, so `-v` misses it — stale etcd replays scheduled workflows) and `/tmp/dapr-h-nr.db`. Service membership per mode lives ONCE in `cli/scripts/_services.sh` (ports/app-ids parsed from the run scripts, never duplicated); `scripts/check-services.mjs` (wired into `bun run lint`) fails if that list drifts from the `.zellij/*.kdl` pane set. See docs/plans/agent-local-mode-bringup.md.
- **Codex on a ChatGPT subscription (not only an API key)** — `codex-agent` authenticates via `OPENAI_API_KEY` by default (API pricing). To run on a ChatGPT (Plus/Pro/Team) plan instead, `codex login` once on the host (writes `~/.codex/auth.json`), leave `OPENAI_API_KEY` empty, and set **`CODEX_AUTH_MODE=chatgpt`** — `run-codex-agent.sh` picks it up and `agent-cli/src/agents/codex.ts` `validateEnvironment` accepts it as an alternative to the key (the Enterprise-only `CODEX_ACCESS_TOKEN` also satisfies the gate). The `codex` subprocess inherits `HOME`/`CODEX_HOME` via the invoker's `mergeProcessEnv` (`{...process.env, ...env}`), so it finds `auth.json` with no extra plumbing. **Gotcha:** a ChatGPT-account plan **rejects explicit API model ids** — `o4-mini`/`gpt-5-codex` both 400 with "not supported when using Codex with a ChatGPT account"; the account default is used ONLY when `--model` is omitted. So in chatgpt mode the run script defaults `AGENT_MODEL` empty and `buildInvocation` omits `--model`. Container mode (a writable `CODEX_HOME` mount + the one-auth.json-per-runner concurrency rule) is docs/plans/codex-chatgpt-auth.md Phase 2.
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
