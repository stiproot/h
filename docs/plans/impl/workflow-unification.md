# Workflow unification: families, triggers-as-data, and the babysitter

Status: Complete — all six phases landed 2026-07-04 (params, verify step, publish flow, triggers-as-data, the standard `POST /workflow`, CLI `--agent`); every deferred item has since been done or superseded
Established: 2026-07-04

Lifted to:
- Triggers-as-data + the single `workflow-trigger` topic → the CLAUDE.md gotcha of that name.
- The babysitter contract → superseded 2026-07-05 by the durable watcher engine ([watcher-primitive](./watcher-primitive.md)); what survives is `packages/js/agent-server/src/workflow-babysitter.ts` (submit-and-forward) and the CLAUDE.md standard-`POST /workflow` gotcha.
- "Machines run loops, agents make judgments" and "every workflow that changes code carries a verify step" → [ARCHITECTURE.md](../../../ARCHITECTURE.md) Principles; verification is now the `verify` overlay atom.
- Silent MCP degradation → the CLAUDE.md "MCP servers are agent-runtime dependencies" gotcha.
- Reusable workspaces / idempotent `/setup` → the CLAUDE.md `workspaceId` gotcha.
- The families→templates vocabulary → retired by [workflow-composition](./workflow-composition.md); the dictionary is ARCHITECTURE.md's Glossary.

## Context

An e2e test of the chart-rendered feature-request workflow (`h feature` → claude-agent as
orchestrator → workflows MCP → workflow-svc → claude-agent activities, target repo `trxy-v2`,
instance `feature-ci-lint-fix`) proved the plumbing works end-to-end but surfaced structural
friction:

1. **`h feature run` can't target claude-agent** — the trigger client speaks workflow-agent's
   `{taskId}` contract; claude-agent's `/run` takes `{input}`. The orchestrator hop had to be
   hand-rolled with `jq` + `curl`.
2. **`sourceRepo`/models only settable via gitignored `values.local.yaml`** — no CLI flags, no
   render-time validation that the repo path exists (fails late, at the worktree step).
3. **Agentic monitoring is fragile** — the orchestrator (haiku, `AGENT_MODEL` default; no knob to
   change it on this path) got one `await_workflow` TIMEOUT and returned early instead of
   re-awaiting. The durable workflow finished anyway; the "relay the result" contract was the only
   casualty. Also: the run ledger reported `toolCalls: 0` despite many MCP calls (metrics bug).
4. **False green** — the workflow COMPLETED, all ledger records `completed`, clean 3-file diff on
   the worktree… and `bun run lint` still failed. The implement agent claimed success without
   verifying (worktree had no deps installed, quietly discouraging verification). No verify step
   exists in the family.
5. **Domain leak** — workflow-agent's `cron_router.py` hardcodes the `plugin-feedback` topic
   subscription and a tessl-specific task template (`_improvement_problem`, a workflow definition
   trapped in a Python f-string). A domain use-case (plugin improvement) fused into a core service.
6. Minor: `skills/analyze-workflow-run/SKILL.md` points at `cli/scripts/analyze-run.sh`; actual
   path is `scripts/analyze-run.sh`. A stray Zipkin 404 span from a status poll racing instance
   creation.

## Design principles

- **Machines run loops, agents make judgments.** Deterministic code owns control flow, polling,
  budgets, and heartbeats; the LLM is engaged only at decision points (construct a workflow,
  judge a stuck step, evaluate an output).
- **Non-blocking supervision.** Nothing holds a connection open for a workflow's lifetime.
  Submit → `{instanceId}` immediately; completion/escalation arrive as events. `await_workflow`
  survives only as a convenience for short-lived workflows inside a ReAct loop.
- **Families are the shared construction substrate.** Charts (helm, golden-tested) author
  workflow shapes; published families are parameterized saved workflows in workflow-svc. Humans
  (CLI) and agents (MCP) both construct by *filling a family's params*. Freeform
  `run_workflow` stays as the escape hatch; recurring freeform compositions get **promoted**
  into chart families (dynamic discovers, static hardens).
- **Triggers are data on the family, not routes in a service.** Cron triggers already exist
  (`schedule` on StoredWorkflow); event triggers are their sibling. Domain use-cases (e.g.
  plugin improvement) become pure configuration: a family + a trigger.
- **Every workflow that changes code carries a verify step.** Deterministic trigger, agentic
  repair, machine-checkable exit condition (the repro command passes).

## Target architecture

```
authoring        cli/charts/workflows/*  (helm, syrupy goldens)
                     │  h workflow publish <family>
runtime store    workflow-svc saved workflows: {steps, params-slots, schedule?, trigger?}
                     │
construction     CLI: h feature run --spec-file … --agent …      (fills params)
                 Agent: list_families / run_family via MCP        (fills params)
                 Escape hatch: run_workflow with raw steps
                     │
execution        workflow-svc generic workflow  (resolveRefs: {{step.x}}, $ref, {{params.x}})
                     │
supervision      babysitter (shared agent-server pkgs, js+py): poll status + ledger heartbeat
                 + budgets → escalate to agent or terminate_workflow → publish terminal event
```

## Phases

### Phase 1 — engine + MCP primitives ✅ prerequisites for everything else

- **1a. `params`**: add `params?: Record<string, unknown>` to `WorkflowRequest`,
  `SaveWorkflowRequest`, `StoredWorkflow` (`workflow.model.ts`); `toRequest` merges stored
  defaults with fire-time overrides; `genericWorkflow` seeds `results.params = input.params`
  before the step loop so `resolveRefs` resolves `{{params.x}}`/`{"$ref": "params.x"}` for free.
  `run_saved_workflow` (MCP + `POST /workflow/run/:key`) accepts fire-time params.
  Tests: `resolve-refs.test.ts`, `workflow.model.test.ts`, router tests.
- **1b. `terminate_workflow`**: `terminate(instanceId)` on `IWorkflowInvoker` +
  `dapr-workflow-invoker` (POST `/v1.0-beta1/workflows/dapr/<id>/terminate`, sibling of `purge`);
  `POST /workflow/terminate/:instanceId` route; `terminate_workflow` MCP tool in workflow-mcp.

### Phase 2 — verify step in the feature family (independent, ships any time)

- `templates/feature.yaml`: add a `verify` step (run-claude, cwd = worktree) gated on
  `feature.verifyCmd`; task = "run `<verifyCmd>`; if it fails, fix and re-run; ≤N attempts;
  end with VERIFY: PASS/FAIL + evidence". Implement step's task also references the command.
- Chart values: `feature.verifyCmd` (empty = step omitted), `feature.models.verify`.
- Re-bless syrupy goldens in `cli/h/tests` deliberately; add a golden with verifyCmd set.

### Phase 3 — publish flow + first families

- Charts emit `{{params.x}}` tokens (via `h.token`) for values left unset → a rendered family
  has open slots. `h workflow publish <family>` renders + `save_workflow` (key = family name).
- `h feature run` gains `--spec-file` (formalize the existing path arg) and can run either
  fully-rendered (current) or `run_saved_workflow("feature", {spec, slug, …})`.
- Port `plugin-improvement` from `_improvement_problem` prose into a chart family
  (worktree → investigate → implement+bump → verify).

### Phase 4 — triggers as data; extract the domain leak

- `trigger?: {topic, params: <payload→params mapping>}` on `StoredWorkflow`; workflow-svc
  subscribes (MVP: one well-known `workflow-trigger` topic carrying `{key, params}`; per-topic
  subscriptions need a sidecar restart per new topic — acceptable later, note the constraint)
  and fires the family.
- Triage's diagnosis step publishes `{key: "plugin-improvement", params: {feedback, repo, tile}}`.
- Delete `/plugin-feedback` + its subscription from workflow-agent's `cron_router.py`.

### Phase 5 — babysitter + standard `POST /workflow` on every agent service

- Contract: `POST /workflow` `{key|steps, params?, workspaceId?, policy?}` → `202 {instanceId}`.
  Babysitter (deterministic): poll status + run-ledger heartbeat (`events.jsonl` staleness) +
  wall-clock/cost budgets per step; on trip → escalate (invoke own agent runner with the
  evidence: wait/retry/kill) or auto-`terminate_workflow`; on terminal → publish event.
- Implement in `packages/js/agent-server` (uses `core-dapr` DaprInvoker → workflow-svc) and
  `packages/py/agent-server` (uses `agent_core.workflows` toolset); wire into claude-agent,
  dapr-agent, workflow-agent. workflow-agent keeps only generic cron-tick/task machinery —
  evaluate whether it dissolves entirely.
- MVP babysitter state in-process; durable statestore record (`babysit:<instanceId>`) if needed.

### Phase 6 — CLI targets the standard endpoint

- `h feature run --agent <id>`: agent registry (id → URL) in `config.py` mirroring the port map;
  POST the family run to the agent's `/workflow`; `--watch` = client-side status polling
  (observational only).
- `h workflow terminate <id>`; `h workflow publish <family>` (from Phase 3).

### Deferred / follow-ups

- ~~Fire-time `instanceId`/`workspaceId` on `POST /workflow/run/:key`~~ — done 2026-07-04
  (route + MCP tool + babysitter key-mode + `h workflow run --instance-id`).
- ~~`toolCalls: 0` in the JS run ledger~~ — done 2026-07-04: the claude CLI stream nests
  tool_use blocks inside assistant events' `message.content[]`; the tally now counts them.
- ~~SKILL.md path drift~~ / ~~render-time sourceRepo validation~~ — done 2026-07-04 (warning
  when the rendered worktree step's sourceRepo doesn't exist locally).
- `h feature run --spec-file` formalization folded into Phase 6 (the positional already accepts
  a path; the family path is `h workflow run feature -p spec=@file`).
- `plugin-improvement` publish needs org config (`pluginImprovement.tile`/`sourceRepo` in
  values.local.yaml) — goldens cover the render; live publish awaits a real plugin repo setup.
- Babysitter escalation hook (agent-in-the-loop judgment on budget breach / repeated failure)
  — design next; the deterministic terminate + `workflow-events` emission is the substrate.
- claude-agent silent death (2026-07-04, window ~13:10–14:08): kernel clean (no OOM, suspend,
  or coredump); the bun process exited while its sidecar survived. Mitigated with fatal
  uncaughtException/unhandledRejection handlers so the next death is loud; root cause needs
  the original terminal's scrollback if still available.

- Fix `toolCalls: 0` in the JS run ledger for MCP-heavy runs.
- Fix `analyze-workflow-run/SKILL.md` script path (also in repo-root `skills/` copy).
- Render-time validation of `sourceRepo` existence (client-side check in `h feature`).
- Worktree deps-install knob so verify isn't cold-start expensive.

## Progress log

- 2026-07-04 — e2e test run (`feature-ci-lint-fix`) completed; friction list captured; plan
  agreed and written.
- 2026-07-04 — **Phase 1 (params + terminate) done and live-verified.** `params` on
  WorkflowRequest/SaveWorkflowRequest/StoredWorkflow, seeded into the results map as the
  reserved id `params`; `toRequest` merges fire-time over stored defaults; `run/:key` takes an
  optional `{params}` body. `terminate` on the invoker port (raw
  `/v1.0-beta1/workflows/dapr/<id>/terminate`), `POST /workflow/terminate/:instanceId`, and
  `terminate_workflow` + params-aware `run_saved_workflow`/`run_workflow`/`save_workflow` in
  workflow-mcp. 66 unit tests green. Live smoke: saved `params-smoke` with defaults, fired with
  an override → step cmd resolved `msg=fire-time-msg slug=default-slug`; `terminate-smoke`
  went RUNNING → TERMINATED via the new route.
- 2026-07-04 — **Phase 2 (verify step) done.** `feature.verifyCmd` + `feature.models.verify`
  in the chart (schema, values, template): when set, a trailing `verify` run-claude step runs
  the command in the worktree, fixes forward (≤3 attempts, no check-weakening), and ends with
  a `===VERIFY===` PASS/FAIL verdict. Chart default stays empty → base goldens unchanged; new
  golden pins the verify variant. Re-fired `feature-ci-lint-fix` (worktree still carrying the
  earlier wrong fix) with the verify step to close the false-green loop live.
- 2026-07-04 — **verify step proven live.** The re-run COMPLETED with `===VERIFY=== PASS`;
  independent `bun run lint` in the worktree exits 0. Implement corrected the real fix
  (`@types/node` dep + project references in `packages/social`); verify then caught and fixed a
  second latent failure (unsupported `no-underscore-dangle` key breaking oxlint config parsing
  in `apps/mobile`). The false green from the morning e2e is now a verified green.
- 2026-07-04 — **Phase 3 (publish flow + families) done.** Chart `publish` mode (feature:
  slug/spec → `{{params.*}}` slots, instanceId omitted); new publish-native
  `plugin-improvement` family porting `_improvement_problem` (worktree → setup → improve →
  optional verify; tile/sourceRepo are family config, slug/feedback are params). Family gate
  added (`--set family=<name>` from both render paths) because helm evaluates every template
  even under `-s` — without it one family's `required` broke other families' renders. CLI:
  `h workflow publish|run|terminate` (+ `save`/`run_saved`/`terminate` client methods;
  `-p key=value`, `@path` splices file content). 34 h-cli tests green (2 new goldens). Live:
  published `feature`, fired with `-p slug -p spec=@ci-lint-fix.md`, RUNNING → terminated via
  CLI; smoke worktree cleaned up.
- 2026-07-04 — **Phase 4 (triggers as data) done.** workflow-svc subscribes to the single
  well-known `workflow-trigger` topic (locked in with the user); events carry `{key, params}`
  and fire the named saved workflow — the pub/sub sibling of `POST /workflow/run/:key`. Payload
  problems ack as `{skipped}` (redelivery can't fix a payload); infra failures 500 so Dapr
  redelivers. CloudEvents content-type gets its own parser in an encapsulated Fastify scope.
  Deleted the plugin-feedback subscription, route, and `_improvement_problem` prose from
  workflow-agent (the leak is now a chart family + an event); WORKFLOWS.md/CLAUDE.md updated.
  52 workflow-svc tests green (6 new). Live: published `{key: "params-smoke", params:
  {msg: "via-trigger"}}` through the sidecar → family fired with merged params.
- 2026-07-04 — **Phase 5 (babysitter + standard `POST /workflow`) done.** `WorkflowBabysitter`
  + `registerWorkflowRoute` in js/agent-server (plain fetch, injectable for tests — 6 tests:
  terminal watch, budget-terminate, transient-failure resilience, submit errors); Python
  sibling `workflow_route.py` in py/agent-server (stdlib urllib via asyncio.to_thread, like
  run_ledger). Contract: `POST /workflow {key|steps, params?, instanceId?, workspaceId?,
  policy?}` → `202 {instanceId, watching: true}`; deterministic watch loop → terminal status
  or wall-clock budget breach → terminate; `workflow-events` published either way;
  `GET /workflow/watches` exposes the in-process table. Wired into claude-agent, dapr-agent,
  workflow-agent (no longer the exclusive entry point). Live on claude-agent: 202 immediate,
  watch reached `completed`, params resolved.
- 2026-07-04 — **Phase 6 (CLI --agent) done.** Agent registry in `config.py` (name → app port,
  full URLs pass through); `agent_service` client; `h workflow run <key> -p k=v --agent
  <name|url>` and `h feature run <spec> --agent <name|url>` submit through the agent's
  babysitter endpoint (non-blocking; watch via `h workflow status`); the legacy blocking
  workflow-agent path remains the no-flag default of `h feature run`. 40 h-cli tests green.
  Live: `h workflow run params-smoke -p msg=cli-via-agent --agent claude-agent` → 202 →
  claude-agent's watch table showed `completed` → params resolved on disk. Full repo suite
  (`make test`): all green.

## Learnings

- **Shared-context persistence (2026-07-04):** the feature family now persists the plan as
  `plan-feature-<slug>.md` in the worktree + actor state (`actorId 'feature-<slug>'`, key
  `plan`, via the dapr MCP) so a re-run or another session can pick it up — the grooming
  pattern, promoted into the chart. Decision: the **plan step keeps `permissionMode: plan`**
  (read-only investigation is load-bearing) and the **implement step does the persisting** —
  it receives the full plan via `{{plan.output}}` anyway. The plan step only *reads* a
  persisted plan (reuse-on-rerun), which plan mode permits.
- **Silent MCP degradation (2026-07-04, e2e audit):** during the persistence-audit run the
  dapr MCP was down (dev-tab teardown), so the agent's ToolSearch for `actor_state_set` found
  nothing and it skipped the durable write without mentioning it — plan file ✓, actor state ✗,
  no trace in the output. Chart prose now requires the agent to report persistence failures
  explicitly. Operational corollary: dapr-mcp/obs-mcp are part of the *agent runtime*, not
  just the human observability surface — agent runs degrade when they're down. The audited
  run's actor state was backfilled by hand. Same run proved the toolCalls tally fix live
  (61/5/1 across plan/implement/verify, previously 0) and the babysitter watch table +
  `===VERIFY=== PASS` end-to-end via `h feature run --agent claude-agent`.

- The dapr workflow layer is durable and self-sufficient once started — orchestrator agents
  abandoning their watch does not endanger the run, only the result relay. Supervision therefore
  belongs in code, with agents only at escalation points.
- A COMPLETED workflow + clean diff is not success: without a verify step, agent self-reports
  are claims. The `analyze-workflow-run` "never diagnose from one source" rule held up exactly.
- `resolveRefs` already recurses everywhere and supports `$ref`/`{{}}` — params support is a
  seeding trick, not an engine change. Side effect: the workflow's final output (the results
  JSON) now echoes `params` alongside step results — useful for debugging fire-time state,
  slightly larger outputs when a param carries a whole spec. Deliberate, revisit if it bites.
- The Fastify empty-JSON-body 400 (documented for the cron routes) also applies to
  `POST /workflow/terminate/:id` — callers must send `{}` or omit the content-type header. The
  workflow-mcp adapter always sends `{}`, so agent callers are unaffected.
- An MCP client only sees new tools (e.g. `terminate_workflow`) on a fresh SSE connection —
  running Claude sessions keep their stale tool list until they reconnect.
- claude-agent had silently exited between the e2e run and the smoke test (`EOF` on
  `/setup` via Dapr invoke, port closed). Worth understanding why before the babysitter phase —
  an agent service dying quietly is exactly what supervision must catch.
- `test_feature_render_json_is_a_valid_definition` (test_cli.py) runs the real CLI path, which
  merges the dev's gitignored `values.local.yaml` — adding `verifyCmd` there changed the test's
  outcome. Loosened to allow the optional verify step; hermetic step-shape assertions live in
  test_render.py. General rule: CLI-path tests must tolerate local-values variation.
