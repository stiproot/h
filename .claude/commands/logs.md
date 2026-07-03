---
description: Query Loki logs with a LogQL selector
argument-hint: "<LogQL selector>"
---

Call the `obs` MCP `logs_query` tool with the selector `$ARGUMENTS` — e.g. `{service="redis"}` or
`{container="scheduler"} |= "error"`. Render the lines newest-first with their timestamp and labels.

Caveat to keep in mind (and mention if relevant): only **dockerized infra** logs reach Loki. Host-run
`dapr run` app/agent stdout does **not** — for app/agent activity use `obs` `trace_search` (Zipkin) and
the run ledger (`obs` `runs_list` / `run_get`) instead.
