# Playbook: integrating a new agent into h

Seed notes toward an `integrate-agent` skill. Captures the repeatable shape for adding a coding
agent to h at parity with the existing ones, distilled from wiring `openhands-agent` and drafting
the `pi` integration ([#24](https://github.com/stiproot/h/issues/24) — the first worked example).

## The contract

Every agent in h is the same three things plus wiring:

1. **A strategy** (`packages/js/agent-cli/src/agents/<name>.ts`) — how to invoke the CLI and parse
   its stream. Implements `AgentStrategy` (`types.ts`): `type` (added to the `AgentType` union),
   `name`, `validateEnvironment`, `extractSessionId`, `extractMetrics`, optional
   `prepareEnvironment`/`ensureReady`, and `buildInvocation`/`buildInvocationEffect`. Registered in
   `invoker.ts` (`<Name>InvokerLive = layerAgentInvoker(<name>Strategy)`) and re-exported from
   `index.ts`. *(CLI agents only. Framework agents — the Python ones — implement `IAgentRunner`
   directly over `agent-core`'s ReAct loop instead.)*
2. **A thin service** (`apps/<name>-agent/`) — an `IAgentRunner` impl (`infrastructure/<name>-runner.ts`)
   that drives the strategy, plus a composition root (`index.ts`) that registers the **shared**
   `agent-server` routes (`/run`, `/setup`, `/clone`, `/worktree`, `/workflow`, `/dapr/subscribe`).
   The service is deliberately tiny — copy the nearest existing agent. Hex boundaries apply and are
   lint-enforced (see ARCHITECTURE.md § Boundaries).
3. **A workflow activity** (`apps/workflow-svc/src/infrastructure/activities/run-<name>.activity.ts`)
   — a Dapr `invoker.invoke("<name>-agent", "run", …)` call, registered in `activity-registry.ts`
   (both the `activities` array and the `getActivity` switch).

Then wiring: **identity** (`cli/h/src/h_cli/config.py`: `AGENT_IDENTITY` maps `--agent <name>` →
`(run-<name>, <name>-agent)`; `AGENT_URLS` maps the app-id → localhost URL), **deploy**
(`docker-compose.yml` app + sidecar, `cli/scripts/run-<name>-agent.sh`, `dapr/resiliency.yaml` +
`dapr/local/`, a unique port block), and **docs** (`README.md` agent list + **port table**,
`CLAUDE.md` app-tree + activity list + agent-cli list).

## The touchpoint checklist (copy-from-template)

Pick the closest existing agent as the template (a **CLI** agent → `openhands-agent`; a Python
**framework** agent → `dapr-agent`/`langgraph-agent`) and mirror it. Order that lands green:

- [ ] Strategy `agents/<name>.ts` + `type` in `types.ts` + `AGENT_ENV_KEYS` (if a new key) +
      `invoker.ts` + `index.ts` + `agents/<name>.test.ts`.
- [ ] `apps/<name>-agent/`: `package.json` (name), `tsconfig*.json`, `src/index.ts`,
      `src/infrastructure/<name>-runner.ts` (`AGENT_ID`, `DEFAULT_AGENT_BASE_DIR`), `Dockerfile`
      (CLI install RUN, `COPY apps/<name>-agent/…`, `--filter=<name>-agent...`), runner test.
- [ ] `run-<name>.activity.ts` + `activity-registry.ts` (import, array, switch case).
- [ ] `cli/h/src/h_cli/config.py`: `AGENT_IDENTITY` (+`<name>` and `<name>-agent` keys), `AGENT_URLS`.
- [ ] `docker-compose.yml` (app + `-dapr` sidecar, profiles, ports, healthcheck), `run-<name>-agent.sh`,
      `dapr/resiliency.yaml` + `dapr/local/resiliency.yaml`, `.env.example`.
- [ ] Port block: next free after the current max (as of #24, claude-coder holds `8014/3514/36014/61015`
      → next is `8015/3515/36015/61016`). Pin app / dapr-http / dapr-grpc / dapr-internal-grpc.
- [ ] `README.md` (agent list, start block, profile table, stack table, **port-allocation table**),
      `CLAUDE.md` (app-tree, `run-{…}.activity.ts` list, agent-cli `agents/` list).
- [ ] k8s: NOT required for parity — only `claude-agent` has k8s manifests.

## CLI-agent gotchas (the decisions worth stating up front)

- **Headless invocation.** Find the non-interactive mode: a JSON/JSONL event stream is ideal (parse
  it like claude-agent's stream). Avoid modes with known non-exit bugs; the runner's ~300s timeout
  is the backstop.
- **Large prompts.** Pass the task via a temp `--file`, not a single arg (E2BIG) — openhands does this.
- **Autonomy.** The agent must run tools without interactive approval (worktree, unattended). Some
  CLIs need a `--yolo`/`--dangerously-skip-permissions` flag; some (pi) have no permission popups by
  design and only need a "trust this dir" flag.
- **Auth + model.** Map `request.llmConfig`/`request.model` → the CLI's model/provider flags and env
  vars. Prefer pointing at h's LLM proxy (`LLM_BASE_URL`) where the CLI supports a custom base-url.
- **MCP.** Not every CLI supports MCP. If it doesn't (pi), the agent is a **coding/feature executor**,
  not an orchestrator — omit the MCP-provisioning block; it simply won't have h's workflow/dapr tools.
- **Cost/usage.** If the CLI doesn't emit token usage, `costUsd` may be unknown — that's fine; the
  watcher tolerates a `costGap`. Never fabricate `$0`.
- **PATH.** The run script must prepend the CLI's install dir (`~/.local/bin`) so the child resolves.
- **Pre-create the workspace dir** before spawn, or an ENOENT reads as a missing binary.

## What "at parity" excludes

Identity is fire-time params: a new agent is reachable per-fire via `-p runActivity=run-<name>
-p agentId=<name>-agent` or `--agent <name>` with **no chart change**. Only touch
`cli/charts/workflows/` if you want the agent selectable as a named chart default. The `pr-review`
executor is deliberately NOT parameterized (untrusted-diff security invariant) — `--agent` is
ignored there.
