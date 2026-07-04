---
name: analyze-workflow-run
description: Analyze an h workflow run across every observability source — workflow status, the run ledger (per-step activity + agent outcomes), Zipkin traces, the worktree state, and pub/sub follow-ups — to determine the run's status, what each step did, and the root cause when it failed. Use after kicking off a workflow, when monitoring or debugging a run, or to answer "what happened / why did it fail" for a workflow instance.
---

# Analyze a workflow run

Equips you to analyze an h workflow run the way an experienced operator does: by correlating
*every* source, not trusting any single one. The join key across all of them is the
**workflow instance id** (for the agent-built path this is a readable id like
`triage-ABC-123`, which is also the worktree dir name and the run-ledger group).

## Cardinal rule: never diagnose from one source

The most common mistake is reading the agent's own `task.result` and believing it. That field is the
**agent's self-report — often a guess**. A real failure (e.g. a `tessl install` or `worktree` step
that errored) does not appear there; the agent will say "the failure is *most likely* during setup or
worktree…" without knowing which. The **run-ledger per-step records are authoritative** — a failed
activity records its real error there. Always verify the self-report against the ledger and Zipkin.

## The sources and what each answers

| Source | Answers | Where |
| --- | --- | --- |
| Workflow status | Is it RUNNING / COMPLETED / FAILED / TERMINATED? final output? | `workflow-svc /workflow/status/<id>` |
| Task state | The agent's overall status + self-reported result (a *claim*) | statestore `task:<id>` |
| **Run ledger** | **Per-step truth**: which setup/clone/worktree activity and which agent run succeeded or failed, with the real error | `<RUNS_DIR>/<id>/*/summary.json` (+ `output.txt`, `events.jsonl`) |
| Zipkin | Error spans for activities/agent runs — catches failures that never reach the ledger | `localhost:9411` |
| Worktree | What the run actually produced on disk (the change, or nothing) | `git -C <target repo> worktree list`; `git status` in the worktree |
| Pub/sub | Follow-up tasks the run seeded (e.g. a plugin-improvement task) | statestore `tasks:index` |

## How to use it

Run the bundled script with the instance id (run from the h repo root):

```bash
~/.claude/skills/analyze-workflow-run/scripts/analyze-run.sh <workflowInstanceId> [taskId]
# e.g. analyze-run.sh triage-ABC-123
```

It prints all seven sections. Endpoints/paths default to the local layout and are overridable via env
(`WF_SVC_URL`, `DAPR_STATE_URL`, `RUNS_DIR`, `TARGET_REPO_PATH`, `ZIPKIN_URL`).

## How to interpret it

1. **Status first** (§1). RUNNING → still in flight; re-check. Terminal → diagnose.
2. **On FAILED, find the failing step in the ledger** (§3), not from the task.result. The first
   `[failed]` record names the activity/agent and carries the error. That is the root cause.
3. **Cross-check Zipkin** (§6) for the same error — and for failures the ledger might miss (an
   activity that never recorded, an agent that died before writing its summary).
4. **Confirm what was produced** (§5): did the worktree get the intended change, or is it empty /
   polluted with scaffolding? An empty worktree on a "done" task is a red flag.
5. **Check the loop** (§7): did the run seed the expected follow-up task (e.g. plugin improvement)?
6. **Watch for masked success**: a `done` task whose ledger shows a failed precondition, or whose
   agent output rode on a globally-available skill, is a *false green* — call it out.

Report: the run's true status, the per-step outcome, the root cause (with the ledger/Zipkin evidence,
not the agent's guess), what it produced, and any follow-up it triggered.
