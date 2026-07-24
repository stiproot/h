# Running inside h

You are running as an agent inside h, an orchestration runtime that runs you as a step in a
Dapr workflow. This file describes the runtime you are in and the tools it gives you. It is runtime
context, separate from the rules of whatever repository you are working in.

## The h MCP servers

h exposes its runtime through MCP servers that are already wired into your environment. Use them
rather than guessing at the runtime's state.

- **dapr** — the Dapr runtime: key/value state and pub/sub.
  - Publish an event with `pubsub_publish` (topic + JSON data). Publishing is fire-and-forget — it
    succeeds even with no subscribers. This is how you hand work to another workflow without calling
    it directly.
  - Read and write shared state with `state_get`, `state_get_bulk`, `state_save`, `state_delete`.
- **workflows** — build, run, and inspect workflows: `list_workflows`, `get_workflow`,
  `save_workflow`, `run_workflow`, `run_saved_workflow`, `get_workflow_status`, `await_workflow`,
  `terminate_workflow`. Use these to start or check on other workflows. Saved workflows can be
  parameterized *templates* — steps carry `{{params.x}}` slots; fire with
  `run_saved_workflow(key, params, instanceId)` (fire-time params override stored defaults, a
  readable instanceId names the run's worktree) before composing raw steps from scratch.
  `terminate_workflow` short-circuits a run that is stuck or no longer needed.
- **obs** — read-only observability: `trace_search`, `trace_get`, `logs_query`, `runs_list`,
  `run_get`, `system_overview`. Use these to find out what a previous run did. The join key across
  traces, logs, and the run ledger is the workflow instance id.

## Output contracts

When a task contains an `===OUTPUT CONTRACT===` block holding a JSON schema, your final message
MUST end with a fenced ```json code block containing a single JSON object that matches that schema.
The block is machine-validated against the schema; a missing or mismatching block fails the step.
Put the fenced block last — nothing after it. Any narrative, evidence, or markers the task asks for
come before it. Tasks without an `===OUTPUT CONTRACT===` block are unaffected by this rule.

## Publishing an event for another workflow to pick up

When your task says to publish feedback, a result, or a request for follow-up work, publish it with
the dapr MCP's `pubsub_publish` to the topic the task names. Put the content another workflow needs
to act on in the event data — do not assume the subscriber can see your workspace, since it runs in
its own. After publishing, report what you published and to which topic.
