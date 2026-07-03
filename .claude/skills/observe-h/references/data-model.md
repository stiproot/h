# Observability data model & endpoints

## Run ledger

**On disk** (`RUNS_DIR`, default `../h-workspace/.runs` local / `/workspace/.runs` docker):

```
{RUNS_DIR}/<group>/<agentId>-<ts>/
  summary.json   # see schema below
  output.txt     # full final output
  events.jsonl   # one JSON event per line
```

`<group>` = workflowInstanceId, else workspaceId, else `adhoc`. `<ts>` = epoch ms. runId =
`<group>:<agentId>:<ts>`.

**summary.json**
```json
{
  "runId": "…:claude-agent:1700000000000",
  "agentId": "claude-agent",
  "workflowInstanceId": "…", "workspaceId": null,
  "workspacePath": "…/workspaces/…",
  "status": "completed | failed",
  "model": "claude-…", "turns": 4,
  "tokens": { "input": 0, "output": 0 },
  "costUsd": 0.0, "toolCalls": 0, "sessionId": "…",
  "startedAt": "ISO", "endedAt": "ISO", "durationMs": 0,
  "inputPreview": "first 280 chars", "error": null
}
```

**Statestore mirror** (global flat keyspace, `keyPrefix: none`):
- `runs:index` → array of `run:<runId>` keys.
- `run:<runId>` → the summary plus `dir` and `outputPreview`.
- Reachable via the `dapr` MCP: `state_get runs:index`, then `state_get run:<runId>`; or any sidecar's
  Dapr state API, e.g. `http://localhost:3503/v1.0/state/statestore/runs:index`.

## Zipkin (traces)

Base `http://localhost:9411`. `obs` wraps these:
- `GET /api/v2/traces?serviceName=&spanName=&lookback=<ms>&endTs=<ms>&limit=` → search.
- `GET /api/v2/trace/{traceId}` → full span list.
- `GET /api/v2/services` → services reporting (used by `system_overview`).

All 8 services report at 100% sampling locally. Run activities carry `workflow.instance_id` as a span
attribute, and agent spans include `claude cli` / `openhands cli`. (k8s tracing is disabled —
`samplingRate: "0"`.)

## Loki (logs)

Base `http://localhost:3100`. `obs logs_query` wraps
`GET /loki/api/v1/query_range?query=<LogQL>&start=<ns>&end=<ns>&limit=`. Labels available:
`service`, `container`, `service_name`. **Dockerized infra only** — host-run apps are absent.

## MCP servers wired into this repo

| Server | URL (local) | Owns |
| --- | --- | --- |
| `obs` | `localhost:8013/sse` | traces, logs, run ledger |
| `workflows` | `localhost:8005/sse` | workflow save/run/list/get/status |
| `dapr` | `localhost:8011/sse` | state store + actors |

Start them with `./scripts/run-obs-mcp.sh`, `./scripts/run-workflow-mcp.sh`, `./scripts/run-dapr-mcp.sh`.
