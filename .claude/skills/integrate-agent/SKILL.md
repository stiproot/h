---
name: integrate-agent
description: >
  The repeatable recipe for adding a coding agent to h at parity with the existing
  ones — the three pieces every agent is (a CLI strategy, a thin service, a workflow
  activity) plus the identity/deploy/docs wiring, the touchpoint checklist to work
  through in the order that lands green, and the CLI-agent gotchas (headless
  invocation, large prompts, autonomy flags, auth/model mapping, MCP, cost, PATH).
  Use whenever adding, removing, or bringing to parity an agent service in h —
  `apps/<name>-agent/`, a `packages/js/agent-cli` strategy, a `run-<name>` activity,
  or an `AGENT_IDENTITY` entry — and when auditing whether an existing agent is
  fully wired. Applies to the h repo only.
---

# Integrating a new agent into h

The repeatable shape for adding a coding agent to h at parity with the existing ones,
distilled from wiring `openhands-agent`, the `pi` integration
([#24](https://github.com/stiproot/h/issues/24)), and `codex-agent` (the worked example at the
bottom).

**This checklist is machine-backed in one place:** `cli/h/tests/test_agent_identity_sync.py`
asserts that every shared-input `run-*` activity in `activity-registry.ts` is reachable via
`--agent`. If you add a strategy and an activity but forget `AGENT_IDENTITY`, that test fails.
Nothing else on this list is guarded — work through it deliberately.

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
`dapr/host/`, a unique port block), and **docs** (`README.md` agent list + **port table**,
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
      `dapr/resiliency.yaml` + `dapr/host/resiliency.yaml`, `.env.example`.
- [ ] Port block: next free after the current max (as of #24, pi-agent holds `8015/3515/36015/61016`
      → next is `8016/3516/36016/61017`; `8014/3514/36014/61015` freed by claude-coder's retirement).
      Pin app / dapr-http / dapr-grpc / dapr-internal-grpc.
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
`cli/charts/workflows/` if you want the agent selectable as a named chart default. The `review-pr`
executor is deliberately NOT parameterized — `--agent` warns and keeps the pin there
(docs/plans/reviewer-identity-security.md).

## Worked example: codex-agent (2026-07-23/24)

Codex followed the shape above — a `codex.ts` strategy parsing the CLI's JSONL `thread.*` events,
a thin `apps/codex-agent/` service, a `run-codex` activity — and it is a useful example precisely
because **the checklist's wiring half was skipped and the omissions each cost a debugging
session**. Read it as a list of what happens when you don't finish the list.

- **`AGENT_IDENTITY`/`AGENT_URLS` were never added**, so `--agent codex` didn't resolve at all
  until they were backfilled. This is now the one guarded step
  (`cli/h/tests/test_agent_identity_sync.py`).
- **Compose env was under-wired**, and each gap surfaced only in a container run: missing
  `GH_TOKEN` broke worktree fetch, the PR push, and the github-MCP bearer; a missing
  `H_SKILLS_DIR` turned setup's `cp -r $H_SKILLS_DIR/. …` into `cp -r /. …` — a copy of the whole
  root filesystem. **Diff your compose service against the nearest existing agent's, key by key.**
- **MCP is not optional if the agent touches PRs.** Codex provisioned none, so `--agent codex` on
  implement-pr/revise-pr would implement and then fail at every PR step. Codex configures MCP
  *globally* (a `config.toml` in `CODEX_HOME`), not per-cwd like claude's `.mcp.json`, so the
  runner translates h's `.mcp.json` into codex TOML each run. **Its `--url` is streamable-HTTP
  only, so h's SSE servers (dapr/obs/workflows) are skipped** — codex is a coding/PR executor,
  not an orchestrator.
- **Auth mode is an explicit env contract, never a sniff.** `validateEnvironment` passes on
  `OPENAI_API_KEY` *or* `CODEX_AUTH_MODE=chatgpt` *or* `CODEX_ACCESS_TOKEN` — fail-closed, the
  same shape as `MCP_CONFIG_MODE`. And a ChatGPT-account plan **rejects explicit API model ids**,
  so `buildInvocation` omits `--model` when none is set.
- **A per-agent state dir must be container-private.** Pointing `CODEX_HOME` at the host-shared
  workspace polluted codex's SQLite app-server state with cross-uid files (host uid 1000 wrote
  them 0644; the container user then couldn't write → "readonly database" → fatal). The fix is a
  dedicated in-image `/codex-home`, with the host credential mounted read-only and seeded in.

Two general lessons worth carrying to the next agent: **any agent-owned state dir is subject to
the same cross-uid hazard as the workspace** (see docs/plans/impl/agent-process-identity.md), and
**a local e2e passing does not imply a container e2e passes** — codex was fully green locally
while four container wiring bugs and one deep blocker were still live.
