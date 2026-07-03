---
description: List recent agent runs from the run ledger
argument-hint: "[limit] [agentId]"
---

Call the `obs` MCP `runs_list` tool to list recent agent runs, most recent first. If `$ARGUMENTS`
contains a number use it as `limit` (else 20); if it contains an agent id (e.g. `claude-agent`),
pass it as `agentId`.

Render a compact table: started time, agentId, status, model, turns, tokens (in/out), costUsd,
toolCalls, and runId. Point out any failures.
