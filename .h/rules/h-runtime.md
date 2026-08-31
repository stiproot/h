# Running inside h

You are running as an agent inside h, an orchestration runtime that fires you as a step in a
workflow. This file describes the RUNTIME you are in, not the rules of the repository you are
working on — that repo's own steering still governs the work itself.

## Reaching the runtime's state

h exposes its runtime through MCP servers. **Check what is actually wired into your session before
relying on any of them** — which servers are present depends on how this run was fired, and a
server that failed to connect is a connection failure, not a missing capability. If one you need
is absent, say so rather than working around it silently.

- **dapr** — key/value state and pub/sub. `state_get`, `state_get_bulk`, `state_save`,
  `state_delete`; `pubsub_publish` (topic + JSON data) to hand work to another workflow without
  calling it directly. Publishing is fire-and-forget: it succeeds even with no subscribers.
- **workflows** — build, run and inspect workflows: `list_workflows`, `get_workflow`,
  `save_workflow`, `run_workflow`, `run_saved_workflow`, `get_workflow_status`, `await_workflow`,
  `terminate_workflow`. Saved workflows are parameterized templates — steps carry `{{params.x}}`
  slots, so fire one with `run_saved_workflow(key, params, instanceId)` before composing raw steps
  from scratch. `terminate_workflow` short-circuits a run that is stuck or no longer needed.
- **obs** — read-only observability: `trace_search`, `trace_get`, `logs_query`, `runs_list`,
  `run_get`, `system_overview`. The join key across traces, logs and the run ledger is the workflow
  instance id.

## Publishing an event for another workflow to pick up

When your task says to publish feedback, a result, or a request for follow-up work, publish it to
the topic the task names. Put everything the subscriber needs into the event data — do not assume
it can see your workspace, since it runs in its own. After publishing, report what you published
and to which topic.
