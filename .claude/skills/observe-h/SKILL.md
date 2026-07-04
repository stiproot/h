---
name: observe-h
description: >
  Observe and debug the h stack — what agents did, workflow status, distributed traces, and
  logs. Use when asked to inspect a run, see what an agent did, debug a failed or stuck workflow,
  correlate a trace, check system health, or answer "what happened" for any agent/workflow activity.
  Explains the observability surfaces (the obs/workflows/dapr MCP servers, the run ledger, Zipkin,
  Loki), the workflowInstanceId join key, and which tool answers which question.
---

# Observing the h stack

h orchestrates several agents (claude, openhands, dapr-agent, dapr-claude-loop, langgraph) via a
Dapr Workflow service. This skill is the map for observing it.

## The join key: `workflowInstanceId`

One id ties everything together. It is the Dapr workflow instance id, the agent workspace key, a
Zipkin span attribute/name, and the group key of the run ledger. Given an instanceId you can pivot to:
the workflow status, the per-step agent run records, the distributed trace, and (for dockerized infra)
logs. Start from it whenever you can.

## Surfaces and which tool to use

| Question | Tool |
| --- | --- |
| What agents ran recently? What did one do? | `obs` `runs_list` / `run_get` (the run ledger) |
| Distributed trace of a request across services | `obs` `trace_search` / `trace_get` (Zipkin) |
| Infra logs (redis, scheduler, …) | `obs` `logs_query` (Loki) |
| One-glance health + recent activity | `obs` `system_overview` |
| Workflow status / definition / schedule | `workflows` `get_workflow_status` / `get_workflow` / `list_workflows` |
| Raw state store / actors | `dapr` `state_get` / `state_get_bulk` / `actor_*` |

Slash commands wrap the common flows: `/observe`, `/runs`, `/run <id>`, `/trace <id|search>`,
`/logs <selector>`, `/workflow <id>`.

## The run ledger — "what the agent did"

Every agent run writes a durable record (best-effort; never blocks the run):

- On the shared volume: `{RUNS_DIR}/<group>/<agentId>-<ts>/` with `summary.json` (status, model,
  turns, tokens, costUsd, toolCalls, sessionId, durationMs, inputPreview), `output.txt` (full output),
  and `events.jsonl` (the agent event stream — full for CLI agents, one synthesized event for the
  Python loop agents). `<group>` is the workflowInstanceId (or workspaceId).
- Mirrored to the Dapr statestore as `run:<runId>` plus a `runs:index` list — so the same records are
  also reachable via the `dapr` MCP (`state_get runs:index`, then `state_get run:<runId>`).

`obs` `runs_list` reads the ledger newest-first; `run_get` returns one run's summary + output + events.
A runId is `<group>:<agentId>:<ts>`.

## How to debug, by symptom

- **"What did agent X do on run Y?"** → `/run Y` (or `obs run_get`). Read summary → output → events;
  then `trace_search name:<instanceId>` for the cross-service trace.
- **"Workflow is stuck/failed."** → `workflows get_workflow_status <instanceId>`; then `obs runs_list`
  filtered to that instanceId to see which step's agent run failed; `run_get` for the error + events.
  To short-circuit a run that is genuinely stuck or no longer needed: `workflows terminate_workflow`
  (or `h workflow terminate <instanceId>`).
- **"Is anything broken right now?"** → `/observe`.
- **"Trace this request end-to-end."** → `obs trace_search` by service or instanceId → `trace_get`.

See `references/data-model.md` for the exact record shapes and endpoints.

## Caveat: logs

Only **dockerized infra** logs (redis, scheduler, placement, grafana, …) reach Loki. Host-run
`dapr run` apps/agents (the normal `make dev-tab` mode) do **not** — for app/agent activity rely on
traces (Zipkin) and the run ledger, not `logs_query`.
