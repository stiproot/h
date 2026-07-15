---
name: workflow-orchestrator
description: Turn a plain-English task into a persisted, tested, reusable workflow run on the h workflow service, and return its result. Use whenever you need to orchestrate a workflow — construct the steps, save or run them, block until the run finishes, self-heal on failure, and report the output — via the workflows MCP (save_workflow / run_workflow / run_saved_workflow / list_workflows / get_workflow / get_workflow_status / await_workflow / terminate_workflow). Any agent with the workflows MCP wired in can use this to build, invoke, and monitor workflows.
---

# Orchestrate an h workflow

Turn a task into a persisted, tested, reusable workflow that runs on the workflow service, and
return the result. All the tools come from the **workflows MCP**: `list_workflows`, `get_workflow`,
`save_workflow`, `run_workflow`, `run_saved_workflow`, `get_workflow_status`, `await_workflow`
(blocks until a running instance finishes and returns its final status + output), and
`terminate_workflow` (short-circuit a running instance that is stuck, spinning, or no longer
needed).

## Prefer a published family over building from scratch

Saved workflows can be parameterized **families**: their steps carry `{{params.x}}` slots, with
optional stored defaults, filled at fire time. Before constructing steps, `list_workflows` and
`get_workflow` — if a family fits the task (e.g. `feature`), fire it with
`run_saved_workflow(key, params, instanceId)` instead of composing raw steps: params like
`{ slug, spec }` fill the slots (fire-time params override stored defaults key-by-key), and a
stable readable `instanceId` names the run's worktree. Freeform `run_workflow` is the escape
hatch for genuinely novel shapes.

## Stable, readable instance ids

When a run is about a specific subject (e.g. a Linear issue), pass `run_workflow` a stable, readable
`instanceId` derived from it (e.g. `triage-<ISSUE_ID>`). That id becomes the run's worktree/workspace
name, and re-running with the same id **reuses the existing instance** instead of starting a
duplicate — so on a retry, reuse the same instanceId rather than minting a new run.

## Workflow shape

A workflow is `{ steps: [{ id, activity, input }] }`. Steps run in order; later steps may reference
earlier outputs with `{"$ref": "stepId.field"}` or `"{{stepId.field}}"`.

**Available activities:**

- `setup` — shell setup in an agent workspace, input `{ agentId, setup: [{ cmd }] }`
- `clone-repo` — shallow-clones a git repo into the agent workspace, input `{ url, branch, depth, dir }`
  (defaults: depth 1, dir `repo`; private GitHub repos authenticate server-side, you never handle tokens)
- `create-worktree` — adds a run-specific git worktree of a pre-cloned source repo on a shared path and
  returns `{ worktreePath }`; input `{ sourceRepo, branch, baseRef, agentId }` — sourceRepo defaults to
  the shared pre-cloned target repo; use it to investigate or change a repo on an isolated checkout that
  every agent in the run shares
- `run-claude` / `run-openhands` / `run-dapr-agent` / `run-dapr-claude-loop` / `run-claude-managed` /
  `run-langgraph` — each runs that agent, input `{ task }`. `run-claude` also takes an optional `cwd`
  (e.g. `"{{create-worktree.worktreePath}}"`) to run in the worktree, an optional `model` to override
  the LLM for that step (e.g. a Sonnet model id for a plan step, a Haiku model id for an implement
  step), and an optional `permissionMode: "plan"` to run the agent read-only — it researches and emits a
  plan but makes no edits. Pass any model/permissionMode values a task specifies through to the step
  input verbatim. Every run-* step also takes an optional `outputContract` (a JSON-Schema subset:
  type/properties/required/items/enum/const): the agent's final output must then end with a fenced
  ```json block matching it — machine-validated, a missing or mismatching block FAILS the step, and
  the validated object lands in the step result as `structured`. Use it when a later step or an
  outside consumer needs machine-readable data from an agent step rather than prose; put the schema
  in the task text too under an `===OUTPUT CONTRACT===` heading so the agent sees it. `save_workflow`
  accepts a matching top-level `outputs` schema — the saved workflow's declared output signature.
- `copy-session` — copies agent workspace output to `./output/`.

## Procedure

1. Derive a stable workflow key from the task (e.g. its purpose).
2. Call `list_workflows`; if a suitable key already exists, reuse it.
3. Otherwise build the steps and call `save_workflow` with that key.
4. Call `run_saved_workflow` to start it, then `await_workflow` with the returned instanceId.
5. If `runtimeStatus` is `TIMEOUT` the workflow is still running — call `await_workflow` again with the
   SAME instanceId; do not rebuild or re-run it. If `runtimeStatus` is `FAILED` or `TERMINATED`, inspect
   the output. Only if it is a step-definition mistake you can correct (a bad ref, wrong activity input)
   should you fix the steps and re-run REUSING THE SAME instanceId — at most TWICE. If it still fails, or
   the failure is environmental and not fixable by editing steps (a setup/install/clone/worktree/auth
   error, e.g. `tessl install` or an MCP that needs authentication), STOP and return the failure and its
   error message. Do NOT keep building new workflows or minting new instance ids — that just spawns
   duplicate worktrees. Never start a fresh run for a task whose instance already COMPLETED.
6. When COMPLETED, read the workflow output, extract the executing agent's report(s), and return them
   verbatim as your final answer — do not rebuild or re-run a COMPLETED workflow.

## Special cases

**Two reports.** If the task asks for two reports (e.g. an issue diagnosis AND a plugin-quality
report), give the `run-claude` step an `outputContract` with one string property per report (e.g.
`{type: object, required: [issueReport, pluginFeedback], properties: {issueReport: {type: string},
pluginFeedback: {type: string}}}`) — the validated block in the step result's `structured` carries
both, machine-separable; return them verbatim.

**Repo Q&A.** When the task is to answer questions about a repository: parse the repo URL, the branch
(if given), and the questions out of the task text. Build a TWO-step workflow and start it with
`run_workflow` (ephemeral — do NOT `save_workflow`, since every repo and question set differs):

1. `clone-repo`, input `{ "url": "<url>", "branch": "<branch>", "depth": 1 }` (omit branch when none is given).
2. `run-claude`, whose task is: `"The repository is cloned at ./repo. Explore it and answer the
   following questions, putting the full answer in your final response: <questions>"`.

Then `await_workflow` on the returned instanceId; when COMPLETED, extract the run-claude step's output
from the workflow result and return it verbatim as your final answer.
