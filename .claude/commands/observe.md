---
description: System observability snapshot — service health, recent runs, recent failures
---

Use the `obs` MCP `system_overview` tool, then give a tight snapshot:

- Which services are currently reporting traces.
- The most recent agent runs (agentId, status, model, turns, tokens, costUsd, toolCalls, duration).
- Anything that failed or looks off.

Keep it scannable. If something looks wrong, say what and suggest the next `obs`/`workflows` call to dig in.
