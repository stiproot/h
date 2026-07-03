---
description: Drill into one agent run — summary, output, events, and its trace
argument-hint: "<runId | workflowInstanceId>"
---

For the run identified by `$ARGUMENTS`:

1. If it looks like a runId (`<group>:<agentId>:<ts>`), call the `obs` MCP `run_get`. Otherwise treat
   it as a workflowInstanceId and call `obs` `runs_list` to find the matching run(s), then `run_get`.
2. Summarise: status, model, turns, tokens, costUsd, toolCalls, sessionId, duration.
3. Show the final output.
4. Surface notable events from the event stream (tool calls, errors).
5. Correlate: call `obs` `trace_search` with `name` set to the run's workflowInstanceId to find the
   matching Zipkin trace; report the traceId and a short span breakdown (use `trace_get` if useful).
