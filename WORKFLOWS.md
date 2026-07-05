# Workflows

Workflows are composed from activities at call time — not hardcoded. Each entry below describes a pattern, the activities it uses, and the test script that demonstrates it.

---

## Single-agent, fixed skill

**Scenario:** Build a Node.js hex API using a pre-selected skill installed during workspace setup.

One agent. A skill is installed during setup. The agent uses it to complete a task. Output is optionally copied to `./output/`.

**Activities:** `setup` → `run-claude` → `copy-session`
**Script:** `cli/scripts/invoke-workflow-skill-creator.sh`

---

## Multi-agent handoff

**Scenario:** OpenHands builds the Node.js hex API; claude-agent reviews the result.

One agent builds; a second agent reviews or tests the result. The second agent receives the first agent's workspace path via cross-step reference.

**Activities:** `setup` (openhands-agent) → `run-openhands` → `setup` (claude-agent) → `run-claude`
**Script:** `cli/scripts/invoke-workflow-hex-api-test.sh`

---

## Multi-agent handoff with output

**Scenario:** OpenHands builds the Node.js hex API; claude-agent reviews it and the final output is copied to `./output/`.

Same as above but adds a summarization step and copies the final output to `./output/`.

**Activities:** `setup` (openhands-agent) → `run-openhands` → `setup` (claude-agent) → `run-claude` → `copy-session`
**Script:** `cli/scripts/invoke-workflow-hex-api-summary.sh`

---

## Dynamic skill discovery (claude-agent)

**Scenario:** claude-agent searches the Tessl registry at runtime, picks the best skill for a Node.js hex API, and implements it.

No skill is chosen at authoring time. The agent uses the Tessl MCP server (`mcp__tessl__search`, `mcp__tessl__install`) to search the registry, select the best match, install it, and complete the task.

**Activities:** `setup` → `run-claude`
**Script:** `cli/scripts/invoke-workflow-skill-search-claude.sh`

---

## Dynamic skill discovery (dapr-agent)

**Scenario:** dapr-agent searches for and installs a Node.js hex API skill, then implements it — using the Dapr Agents SDK tool loop.

Same pattern as above using the Dapr Agents SDK agent. Tools (`search_skills`, `install_skill`, `read_skill`, `write_file`) are plain Python functions injected at request time, scoped to the per-workflow workspace.

**Activities:** `setup` → `run-dapr-agent`
**Script:** `cli/scripts/invoke-workflow-skill-search-dapr.sh`

---

## Dynamic skill discovery (dapr-claude-loop-agent)

**Scenario:** dapr-claude-loop-agent searches for a Node.js hex API skill and implements it — using the Anthropic SDK directly, without the Dapr Agents SDK.

The Anthropic SDK agentic loop runs directly in Python behind a Dapr sidecar. Demonstrates Dapr service invocation without the Dapr Agents SDK.

**Activities:** `setup` → `run-dapr-claude-loop`
**Script:** `cli/scripts/invoke-workflow-skill-search-dapr-loop.sh`
**Payload:** `cli/scripts/payloads/dapr-claude-loop-workflow.json`

---

## Dynamic skill discovery (langgraph-agent)

**Scenario:** langgraph-agent searches for a Node.js hex API skill and implements it — using a pure LangChain/LangGraph ReAct agent, without the Dapr Agents SDK.

A LangGraph `create_react_agent` runs behind a Dapr sidecar, talking to the LiteLLM proxy directly via `ChatAnthropic`. The agent topology is built from config: the step's `graph` input selects tools, model, prompt, and max iterations, resolved through a tool registry. A `graph` config can also be saved by name (`POST /save`) and referenced by `preset`.

**Activities:** `setup` → `run-langgraph`
**Script:** `cli/scripts/invoke-workflow-skill-search-langgraph.sh`
**Payload:** `cli/scripts/payloads/langgraph-workflow.json`

---

## Agent-composed workflow via MCP

**Scenario:** claude-agent uses the workflows MCP server to dynamically compose and trigger a child workflow, which dapr-claude-loop-agent then executes to build a Node.js hex API.

claude-agent receives a high-level task and uses `mcp__workflows__run_workflow` to construct and submit a workflow at runtime — no workflow definition exists at authoring time. The composed workflow runs dapr-claude-loop-agent as its execution step.

**Activities (outer):** `setup` (claude-agent) → `run-claude`
**Activities (inner, composed by claude-agent):** `setup` (dapr-claude-loop-agent) → `run-dapr-claude-loop`
**Script:** `cli/scripts/invoke-workflow-agent-composed.sh`
**Payload:** `cli/scripts/payloads/agent-composed-workflow.json`

---

## Code review

**Scenario:** claude-agent reviews a code diff and produces structured Markdown feedback.

**Activities:** `setup` → `run-claude`
**Script:** `cli/scripts/invoke-workflow-code-review.sh`
**Payload:** `cli/scripts/payloads/code-review-workflow.template.json`

---

## Grooming (Linear issue)

**Scenario:** claude-agent grooms a Linear issue — reads the issue, analyzes a target-repo worktree against it, pulls extra context from any linked Notion page (and inspects production via an org ops plugin when the issue is about prod), then posts the consolidated findings back as a comment on the issue.

Follows the standard workflow-agent pattern: `invoke-workflow-grooming.sh` seeds a task into the Dapr state store and POSTs to workflow-agent, which builds and runs an ephemeral workflow via workflow-mcp → workflow-svc → claude-agent. The full trace is therefore end-to-end: `workflow-agent → workflow-mcp → workflow-svc → claude-agent`. Cuts a `groom/<ISSUE_ID>` worktree of the pre-cloned target repo, then a Sonnet `groom` step reads/analyzes and emits findings under a `===GROOMING FINDINGS===` marker, and a Sonnet `writeback` step posts them via the `linear` skill's `add-comment.sh`. `--dry-run` tells workflow-agent to build only the first three steps (read + analyze only, nothing posted). Write-back uses the `linear` skill (`add-comment.sh`) with `LINEAR_API_KEY` — no Linear MCP (it cannot authenticate headless).

**Activities:** `create-worktree` → `setup` → `run-claude` (groom) → `run-claude` (writeback)
**Script:** `cli/scripts/invoke-workflow-grooming.sh <ISSUE_ID> [context words...] [--dry-run]`
**Task payload:** `cli/scripts/payloads/domain/grooming-task.template.json` (workflow-agent task format — `taskId` + `problem`; gitignored — the template names your org's repo and plugins, see `cli/scripts/payloads/domain/README.md`)
**Prerequisite:** `workflow-agent` running; the target repo pre-cloned (`cli/scripts/clone.sh`); `.env` has `LINEAR_API_KEY`, `GH_TOKEN`, `NOTION_API_KEY` (and any credentials your domain template's inspection steps need, e.g. a live AWS SSO session).

---

## Claude Managed Agents

**Scenario:** claude-managed-agent runs an Anthropic-native agentic loop via the Claude Managed Agents API, orchestrated by a Dapr Workflow.

A single workflow step dispatches to the claude-managed-agent via Dapr invoke. The agent handles multi-tool tasks (calculator, word count, UTC time) through the Managed Agents runtime.

**Activities:** `run-claude-managed`
**Script:** `cli/scripts/invoke-workflow-claude-managed.sh`
**Payload:** `cli/scripts/payloads/claude-managed-workflow.json`

---

## Workflow persistence (save then run by key)

**Scenario:** A workflow definition is saved to the state store under a named key, then invoked by key — decoupling authoring from execution.

`workflow-svc` persists the workflow spec to Redis via the Dapr state API (`POST /workflow/save`) and returns the key. A subsequent `POST /workflow/run/:key` fetches and invokes the saved spec without re-submitting the definition. The saved key is also appended to `__workflow_index__` so it is discoverable via `GET /workflow/list`.

**Activities:** any (demo uses `run-claude`)
**Script:** `cli/scripts/invoke-workflow-persistence.sh`

---

## Reusable workspace (workspaceId)

**Scenario:** A workflow runs repeatedly (e.g. on a cron) against one provisioned workspace, instead of provisioning a fresh one each time.

By default an agent's workspace dir is keyed on the per-run workflow instance id, so every run starts empty and re-runs `setup`. Adding a top-level `workspaceId` to the workflow request pins the dir to a stable key (`{AGENT_BASE_DIR}/workspaces/{workspaceId}`) shared across runs. The `workspaceId` is injected into every step and forwarded to each agent's `/run`, `/setup`, and `/clone`; with no `workspaceId` the instance-id keying is unchanged.

`setup` is idempotent: it hashes its spec into `.agent-setup-complete` and short-circuits when re-run against an unchanged spec, so a recurring workflow keeps its setup step but only installs skills/config once. Changing the setup spec busts the hash and re-provisions. Saved workflows (`POST /workflow/save`) persist `workspaceId`, so a cron firing `POST /workflow/run/:key` reuses the same workspace every tick.

**Activities:** any (demo uses `setup`)
**Script:** `cli/scripts/invoke-workflow-workspace-reuse.sh`

---

## Scheduled workflow (cron)

**Scenario:** A saved workflow declares a schedule and `workflow-svc` fires it automatically — no external trigger needed.

`POST /workflow/save` accepts an optional `schedule` (a standard cron expression, evaluated in UTC), stored on the entry alongside `savedAt`/`lastRunAt`. A `bindings.cron` component (`workflow-cron-tick`, scoped to `workflow-svc`) POSTs `/workflow-cron-tick` every 60s; the handler scans the saved workflows and invokes any whose next cron fire-time (relative to `lastRunAt`, or `savedAt` before the first run) has passed, then stamps `lastRunAt`. Stamping forward makes missed fires self-healing — a daily job idle for a week fires once, not seven times.

This composes with **reusable workspace**: a scheduled workflow that also sets `workspaceId` provisions its workspace on the first tick and skips `setup` on every later one. That is the recurring-diagnostics use-case — install an ops plugin once, run the diagnosis on a schedule.

Note: this is local + compose only for now. On a multi-replica k8s deployment each replica would tick and double-fire; that needs a single-replica or leader guard (not yet wired).

**Activities:** any (demo uses `setup`)
**Script:** `cli/scripts/invoke-workflow-schedule.sh`

---

## Agent-built workflow (workflow-agent)

**Scenario:** Instead of a human authoring the workflow JSON, the `workflow-agent` reads a
plain-English task from the statestore and constructs the workflow itself.

A Dapr cron binding (`cron-tick`) triggers `workflow-agent` on a schedule (or `POST /run
{taskId}` triggers one task synchronously). The agent — a Dapr Agents SDK ReAct loop — uses the
**workflows MCP** to check for an existing workflow (`list_workflows`), build and `save_workflow`
one if none fits, `run_saved_workflow`, and `await_workflow` until it reaches a terminal state,
repairing and re-running on failure. The completed workflow's output is written back to the task
entry in the statestore.

The agent-built path is driven by `invoke-workflow-agent.sh <name> [VAR=value …]`, which seeds a task
from `payloads/<name>-task[.template].json` — searching the committed demo payloads first, then the
gitignored `payloads/domain/` — and triggers the agent. (Contrast the `invoke-workflow-*` scripts,
which post a pre-authored workflow directly to `workflow-svc`.)

**Task config:** `cli/scripts/payloads/<name>-task[.template].json`
**Script:** `cli/scripts/invoke-workflow-agent.sh trivial` (or `linear-read ISSUE_ID=<id>`, `repo-qa …`)

### Domain-specific tasks (payloads/domain/)

Org-specific tasks — production health checks, issue triage on a worktree of your repo,
multi-agent remediation, plugin-testing loops — are the same mechanism with domain content in the
`problem` text: real repo names, internal plugin installs (`tessl install <org>/<plugin>`), and
production-access instructions. Those payloads live in the gitignored `cli/scripts/payloads/domain/`
and are invoked identically (`invoke-workflow-agent.sh <name> …`); document them in a
`WORKFLOWS.md` in that directory. See `cli/scripts/payloads/domain/README.md`.

The machinery they compose is all committed: `create-worktree` for isolated per-run worktrees of a
pre-cloned repo, the `workflow-trigger` pub/sub topic (an agent publishes `{key, params}` via the
dapr MCP; `workflow-svc` subscribes and fires the named saved workflow with those params — e.g.
`{key: "plugin-improvement", params: {feedback, slug}}` fires the published `plugin-improvement`
chart family), and the report-marker convention (`===ISSUE REPORT===`, `===PLUGIN FEEDBACK===`,
`===VERIFY===`, …) for extracting structured sections from agent output.

### Feature request (feature-request)

The same worktree machinery as issue triage, but the work item is a written **Markdown spec read
from a file** rather than a Linear issue, and the run is a pure investigate-then-implement (no
prod diagnosis, no plugin-feedback publish). Specs live in the gitignored
`cli/scripts/payloads/domain/feature-requests/*.md`. The `workflow-agent` builds an ephemeral workflow:

1. `create-worktree` — run-specific worktree of the pre-cloned target repo on branch `feature/<slug>`,
   where `<slug>` derives from the spec's filename. Every later step runs in it via the step's `cwd`.
2. `setup` (claude-agent) — copies the h runtime steering (`steering/h-lab-runtime.md`) to the
   agent's user-global `~/.claude/CLAUDE.md` and the root-level h skills to `~/.claude/skills/`.
   No `tessl install` — the worktree is already a tessl project.
3. `run-claude` (`plan`, cwd = the worktree, `permissionMode: plan` — read-only) — reads the
   feature spec (spliced under `===FEATURE SPEC===`), reuses a persisted
   `plan-feature-<slug>.md` from a prior run when it still fits, otherwise explores the code and
   emits an `===IMPLEMENTATION PLAN===` without writing anything.
4. `run-claude` (`implement`, cwd = the worktree) — first persists the plan it received (the
   shared-context handoff: writes `plan-feature-<slug>.md` in the worktree AND
   `actor_state_set(actorId='feature-<slug>', key='plan')` via the dapr MCP — reporting
   explicitly if a persistence step fails), then implements, left as uncommitted working-tree
   changes. Makes no change if the feature already appears done.
5. `run-claude` (`verify`, cwd = the worktree; only when `feature.verifyCmd` is set) — runs the
   acceptance command, fixes forward on failure (≤3 attempts, no check-weakening), and ends with
   a machine-checkable `===VERIFY===` PASS/FAIL verdict. Without it, the implement step's
   self-report is an unchecked claim.

**Optional PR ending (`feature.createPr` / `--pr`):** by default the run ends as uncommitted
working-tree changes. Opting in appends a commit/push/PR epilogue to the *final* step's prose
(verify when present — gated on a PASS verdict — else implement): the agent commits the worktree,
pushes `feature/<slug>` with a one-shot `GH_TOKEN` URL (never persisted into git config), opens
the PR via the github MCP, and ends with a machine-checkable `===PR===` marker (URL or SKIPPED +
reason). Direct renders opt in with `h feature run <spec> --pr` (or `--set feature.createPr=true`);
a *published family* always carries the epilogue keyed off the fire-time `createPr` param —
`-p createPr=true` to end as a PR, param absent for a worktree-only run — so one saved family
serves both endings.

The invocation reads the `.md` and injects it into the task with `jq --rawfile` (JSON-safe for
arbitrary Markdown — quotes, backslashes, `$`), so it is a dedicated wrapper rather than a payload run
through `invoke-workflow-agent.sh`. The spec arg is either a `.md` path or a bare name resolved
against `cli/scripts/payloads/domain/feature-requests/` (with or without the `.md` suffix).

**Built workflow's activities:** `create-worktree` → `setup` (claude-agent) →
`run-claude` (plan) → `run-claude` (implement) → [`run-claude` (verify)]
**Task config:** `cli/scripts/payloads/domain/feature-request-task.template.json` (gitignored)
**Spec home:** `cli/scripts/payloads/domain/feature-requests/*.md` (gitignored)
**Script:** `cli/scripts/invoke-workflow-feature-request.sh <spec> [SLUG=<slug>]`
**Prerequisite:** the target repo pre-cloned into the shared workspace root — run
`cli/scripts/clone.sh` once. claude-agent + workflow-agent running, and `GH_TOKEN` set in `.env`.

**Chart strategy (co-existing):** `cli/scripts/invoke-workflow-feature-helm.sh <spec> [SLUG=<slug>]
[--pr] [--render-only]` renders the same workflow deterministically from
`cli/charts/workflows/templates/feature.yaml` (`helm template`, client-side only) and seeds a task
carrying the pre-built definition — the workflow-agent then runs it verbatim and monitors, instead
of constructing the steps itself. YAML is the rendered artifact; JSON conversion happens only at
the wire boundary. See [cli/README.md](./cli/README.md).

The `h` CLI supersedes both scripts:

- `h feature run <spec> --agent claude-agent` — render, then submit the definition to that agent
  service's standard `POST /workflow` (submit-and-forward, **non-blocking**: 202 with the
  instanceId immediately; supervision is the durable watcher engine in workflow-svc — a
  `watch:sub:<instanceId>` row, budget-terminate/retry on the cron-tick scan, terminal
  `workflow-events`; see `docs/plans/watcher-primitive.md` and `h watch list`). Without
  `--agent`, the legacy blocking workflow-agent path runs.
- `h workflow publish feature` — render in publish mode ({{params.slug}}/{{params.spec}} slots
  open, family config baked from values) and save as a reusable *family*; fire it with
  `h workflow run feature -p slug=… -p spec=@file.md [--instance-id feature-<slug>] [--agent …]`,
  the `run_saved_workflow` MCP tool, or a `workflow-trigger` pub/sub event `{key, params}`.

See `docs/plans/workflow-unification.md` for the architecture (families, triggers-as-data) and
its progress log, and `docs/plans/watcher-primitive.md` for the watcher engine that replaced the
in-process babysitter loops.

### Issue sweep (issue-sweep) — the h-builds-h loop

One judgment tick of the self-build loop (`docs/plans/h-builds-h.md`, operate via
`docs/h-builds-h-runbook.md`): reconcile in-flight `feature-issue-<n>` runs, enforce
budget/concurrency gates from the `sweep:config` statestore key, pick the oldest OPEN issue
labeled `agent-approved`, and dispatch ONE `feature` run (params `slug`/`spec`/`createPr`/
`issueNumber`, `fresh: true` on retries) to the coding agent's `POST /workflow`. Publish with a
cron schedule + `--workspace-id h-issue-sweep` (start `--disabled`); the sweep agent is the only
writer of the `sweep:*` registry. `issueSweep.dryRun` renders a tick that reports what it would
dispatch and touches nothing.

**Chart:** `cli/charts/workflows/templates/issue-sweep.yaml`
**Config:** `issueSweep.*` values (repo, label, coderWorkflowUrl, maxInFlight, models.sweep);
runtime knobs in `sweep:config`.

---

## Repo Q&A (workflow-agent)

**Scenario:** A plain-English task asks for questions to be answered about a git repository. The
`workflow-agent` parses the repo URL, optional branch, and the questions, then builds an **ephemeral**
two-step workflow (`run_workflow`, not saved — every repo/question set differs):

1. `clone-repo` — shallow (`--depth 1`), branch-aware clone of the repo into `./repo` in the
   claude-agent workspace. Backed by the `git-core` package via claude-agent's `/clone` route.
   Private GitHub repos authenticate server-side from `GH_TOKEN`; the token never enters the workflow
   definition, the task entry, or logs.
2. `run-claude` — the claude-agent explores `./repo` and answers the questions in its response.

The run-claude output is returned verbatim and written back to the task entry as `result`.

**Built workflow's activities:** `clone-repo` (claude-agent) → `run-claude`
**Task config:** `cli/scripts/payloads/repo-qa-task.template.json`
**Script:** `cli/scripts/invoke-workflow-agent.sh repo-qa REPO_URL=<url> BRANCH=<branch> QUESTIONS="<questions>"`
