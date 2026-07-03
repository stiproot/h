---
description: Workflow status + definition for an instance or saved key
argument-hint: "<instanceId | savedKey>"
---

For `$ARGUMENTS`:

- If it looks like a workflow **instance id**, call the `workflows` MCP `get_workflow_status`
  (runtimeStatus + output).
- If it's a **saved key**, call `workflows` `get_workflow` for the definition (steps, schedule,
  workspaceId), and `get_workflow_status` if you have an instance id for it.

Then, for the agent activity behind it, call `obs` `runs_list` filtered to the instanceId to show the
per-step run records, and offer `/run <instanceId>` for the full drill-down.
