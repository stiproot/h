# Phase 1 — Live drift & bug fixes

Status: Active — 11 item(s), 2 complete (A16, A29 — both 2026-07-28)
Established: 2026-07-23
Parent: [hardening-audit index](./README.md) — read its context + executing-agent instructions first.

Confirmed bugs/drift to fix directly: quick wins, no new machinery. Small, mechanical, high confidence — do these first. Items A1/A18/A28 overlap on codex: treat them as one work item (the codex wiring) plus its guard.

## [x] A16. dapr-agent / dapr-claude-loop-agent tools.py: write_file escapes the workspace and nothing pins containment

*Severity: medium · effort: small*

**Gap:** Both zero-test Python agents ship a write_file tool that resolves target = cwd / path with no containment check — a Python Path absolute path or '..' segments make cwd/path escape the workspace entirely (Path('/w') / '/etc/x' == Path('/etc/x')) — and read_skill/make_tool_fns likewise have no tests. The langgraph-agent's PresetStore shows the repo already knows the intended discipline (it rejects '/', '\\', '..' in keys), so the tool duplicated in two apps is missing both the guard and the test that would have forced the decision. These are LLM-invoked tools: the path argument is model-controlled.

**Evidence:** `/home/stiproot/code/h/apps/dapr-agent/src/infrastructure/tools.py:86 (def write_file: target = cwd / path; mkdir(parents=True); write_text — no containment)` · `/home/stiproot/code/h/apps/dapr-claude-loop-agent/src/infrastructure/tools.py (89-line sibling, same shape)` · `/home/stiproot/code/h/apps/langgraph-agent/src/infrastructure/preset_store.py:15-18 (the guard pattern that exists elsewhere)` · `find over apps/dapr-agent, apps/dapr-claude-loop-agent: zero test_*.py files`

**Do:** Add a shared containment helper and apply it in all THREE copies, not two: (1) apps/dapr-agent/src/infrastructure/tools.py (write_file at :86, read_skill at :81), (2) apps/dapr-claude-loop-agent/src/infrastructure/tools.py (write_file at :83, read_skill at :78), (3) apps/langgraph-agent/src/infrastructure/tools.py (write_file at :38). In each: `target = (cwd / path).resolve()` then `if not target.is_relative_to(cwd.resolve()): return "Error: path escapes workspace"` (mirror PresetStore._path's fail-loud style; for read_skill, reject skill_name containing '/', '\\', or '..' as preset_store.py:16 does). Since the duplication is deliberate (thin apps), the cleanest home for the helper + one test suite is packages/py/agent-core (already a shared uv workspace member with a pytest suite run via `uv run --package agent-core pytest`), e.g. agent_core/workspace_paths.py `contained_path(cwd, path) -> Path` raising ValueError — then each app's tools.py calls it. Add tests: packages/py/agent-core/tests/test_workspace_paths.py pinning (a) relative writes inside tmp_path succeed, (b) '../x' rejected, (c) absolute '/etc/x' rejected, (d) symlink-inside-pointing-out resolved and rejected; plus per-app tests/test_tools.py in apps/dapr-agent, apps/dapr-claude-loop-agent, apps/langgraph-agent asserting write_file refuses escape and read_skill rejects traversal skill_names (these apps currently have zero tests; wire them into make lint/test the same way agent-core's pytest runs). Also update docs/plans/agent-process-identity.md's 'narrow tool surface' clause to note containment is now enforced, keeping the trust-model claim true.

**DONE 2026-07-28.** `agent_core.workspace_paths` (`contained_path`, `safe_name`) + 13 unit
tests; applied in all THREE apps — including dapr-claude-loop-agent, which dispatches by tool name
inside `execute_tool` rather than defining `write_file`, so a `def write_file` grep misses it.
`agent-core` was added as a dependency of the two apps that lacked it (they would have
ImportError'd otherwise). Both zero-test apps gained a pytest suite, wired into `make test-py`
(5 tests each). Verified at runtime, not just by test: an absolute path and a `../../..` traversal
are both refused and the victim file is never created, while legitimate writes still land.

## [ ] A1. AGENT_IDENTITY table has already drifted from activity-registry (codex missing) and nothing checks the sync

*Severity: medium · effort: small*

> **Verified 2026-07-28 — PARTLY STALE.** `AGENT_IDENTITY` now HAS the codex entry
> (`cli/h/src/h_cli/config.py:57-58`), so the "`--agent codex` fails with unknown-agent" half no
> longer reproduces. The *unchecked-sync* half stands: nothing pins the table against the activity
> registry, which is what let it drift in the first place. Re-scope before implementing.

**Gap:** The stated rule on AGENT_IDENTITY — 'only agents whose run activity takes the shared {cwd,model,task} input belong here — extend as more agents earn a run-* activity' — is unchecked, and drift has already happened: run-codex exists in the engine's activity registry with the shared input shape and a full codex-agent service, but AGENT_IDENTITY has no 'codex' entry, so `h workflow run --agent codex` / `h chain run --agent codex` fail with unknown-agent even though the runtime fully supports it.

**Evidence:** `cli/h/src/h_cli/config.py:49-56 (AGENT_IDENTITY — claude/openhands/pi only)` · `apps/workflow-svc/src/infrastructure/activity-registry.ts:47 (case "run-codex")` · `apps/workflow-svc/src/infrastructure/activities/run-codex.activity.ts:10-17 (shared {task,cwd,model,...} input shape)` · `docker-compose.yml:403-425 (codex-agent + sidecar services exist)`

**Do:** Two-part fix. (1) Close the drift: in cli/h/src/h_cli/config.py add "codex"/"codex-agent" → ("run-codex", "codex-agent") to AGENT_IDENTITY and "codex-agent": "http://localhost:8016" to AGENT_URLS (port from cli/scripts/run-codex-agent.sh:29), plus the playbook's skipped doc touchpoints (README agent list/port table, CLAUDE.md app-tree + activity list). (2) Encode the guard: add cli/h/tests/test_agent_identity_sync.py (runs under the existing `uv run --package h-cli pytest`) that resolves the repo root via Path(__file__).resolve().parents[3], regex-extracts every `case "run-([a-z-]+)"` label from apps/workflow-svc/src/infrastructure/activity-registry.ts, and for each opens apps/workflow-svc/src/infrastructure/activities/run-<name>.activity.ts and classifies it shared-input iff its `type Input` block declares both `cwd?: string` and `model?: string` (derives the exclusion set — run-langgraph/run-dapr-agent/run-dapr-claude-loop/run-claude-managed lack these — from source instead of a second hand-maintained frozenset that could itself drift); assert every shared-input activity has AGENT_IDENTITY entries under both `<name>` and `<name>-agent` keys whose runActivity matches, and that the corresponding `<name>-agent` app-id appears in AGENT_URLS. This makes the playbook's line-44 checklist item machine-checked per the Harden-by-encoding principle.

## [ ] A18. codex-agent is fully wired but invisible on every doc and steering surface

*Severity: medium · effort: medium*

**Gap:** A complete codex agent integration exists (Effect-based app landed PR #53 via commit 39d5b78, run script with pinned ports 8016/3516/36016/61017, compose profile, run-codex activity, agent-cli codexStrategy) but appears in NO surface an agent or developer loads: not in CLAUDE.md's App layouts (apps list, packages/js/agent-cli agents/ listing, and the run-{claude,openhands,pi,...} activity list all omit it), not in README.md's Agents table, workspace tree (lines 28-40), run-scripts list (lines 170-181), compose component table, or either port table (lines 250-281 — CLAUDE.md's port-collision invariant explicitly says 'the full map is in README.md', now false), and not in the CLI's AGENT_IDENTITY table — so `h workflow run --agent codex` silently has no identity mapping and any agent planning off the docs cannot route work to it.

**Evidence:** `/home/stiproot/code/h/apps/codex-agent/src/index.ts:1 and /home/stiproot/code/h/apps/codex-agent/src/infrastructure/codex-runner.ts (the app exists)` · `/home/stiproot/code/h/cli/scripts/run-codex-agent.sh:30-38 (ports 8016/3516/36016/61017)` · `/home/stiproot/code/h/docker-compose.yml:403-446 (codex-agent + codex-agent-dapr services)` · `/home/stiproot/code/h/apps/workflow-svc/src/infrastructure/activity-registry.ts:6,47 (run-codex registered)` · `/home/stiproot/code/h/packages/js/agent-cli/src/agents/codex.test.ts:4 (codexStrategy exists)` · `/home/stiproot/code/h/README.md:11-19 (Agents table: pi-agent present, codex absent), README.md:241-262 (compose table), README.md:265-283 (port map has pi-agent 8015 row, no codex 8016 row)` · `/home/stiproot/code/h/cli/h/src/h_cli/config.py:49-56 (AGENT_IDENTITY: claude/openhands/pi only)` · `git log: 39d5b78 'feat(codex-agent): ... (#53)'` · `dims: steering-drift, doc-gaps`

**Do:** 1) Add "codex": ("run-codex", "codex-agent") and "codex-agent": ("run-codex", "codex-agent") to AGENT_IDENTITY in /home/stiproot/code/h/cli/h/src/h_cli/config.py:49 (run-codex.activity.ts takes the shared {cwd,model,task} input, meeting the table's stated inclusion criterion). 2) Add a pytest in cli/h/tests (e.g. test_config.py) asserting every runActivity value in AGENT_IDENTITY appears in workflow-svc's activity registry and, conversely, that every run-*-agent pair in apps/workflow-svc/src/infrastructure/activity-registry.ts with the shared input shape has an AGENT_IDENTITY entry — encoding the coverage invariant per 'Harden by encoding'. 3) Update docs: CLAUDE.md App layouts (apps/codex-agent entry, codex.ts in the agent-cli agents/ listing, run-codex in the activities line, codex in the AGENT_IDENTITY prose), README.md Agents table / workspace tree / run-scripts list / compose component table / both port tables (8016/3516/36016/61017 from run-codex-agent.sh:30-38). Note: drop the original claim that --agent codex fails silently — it errors loudly (workflow.py:190-196); the fix enables routing, it does not close a silent-failure hole.

## [ ] A28. agent-integration-playbook was not updated by the newest agent integration (codex)

*Severity: medium · effort: small*

> **Verified 2026-07-28 — PART 3 DONE, parts 1–2 STALE, re-scope before implementing.**
> Part 3 landed with the plans-grooming pass: the playbook was never a plan (it is durable
> operational how-to, so the plan-management lift table puts it in a skill), and it is now
> **`.claude/skills/integrate-agent/`** with frontmatter and a codex worked example written as
> *what happens when you skip the checklist* — the missing `AGENT_IDENTITY` rows, the
> under-wired compose env (the missing `H_SKILLS_DIR` that turned setup into `cp -r /. …`),
> the global-config MCP model and its SSE gap, the explicit auth-mode contract, and the
> container-private `CODEX_HOME` requirement. Every `docs/plans/agent-integration-playbook.md`
> citation was repointed.
> Parts 1–2 no longer reproduce: `AGENT_IDENTITY`/`AGENT_URLS` carry codex
> (`config.py:57`), README mentions it, and the proposed guard EXISTS as
> `cli/h/tests/test_agent_identity_sync.py` (source-derived exclusion set, as specified) —
> all landed via [codex-chatgpt-auth](../impl/codex-chatgpt-auth.md). What remains open is the
> overlap with **A22** (skill rosters still omit `run-pi`/`run-codex`), which this item's
> relocation does not address.

**Gap:** docs/plans/agent-integration-playbook.md is the designated integration recipe (memory: 'seed of an integrate-agent skill'), but the codex-agent integration — the first Effect-composition-root agent, first telemetry-package consumer, OpenAI-keyed — left no trace in it (grep 'codex' across docs/plans/ and skills/ returns nothing), so the playbook's lessons stop at pi and the newest integration pattern is captured nowhere durable.

**Evidence:** `/home/stiproot/code/h/docs/plans/agent-integration-playbook.md:1` · `/home/stiproot/code/h/apps/codex-agent/src/index.ts:1-30 (Effect Layer composition root, telemetry makeTracingLive)` · `grep -rn codex docs/plans/ skills/ -> no matches`

**Do:** Three parts. (1) Functional: add the codex rows to cli/h/src/h_cli/config.py — AGENT_IDENTITY ("codex": ("run-codex", "codex-agent"), "codex-agent": (...)) and AGENT_URLS (port 8016 per cli/scripts/run-codex-agent.sh) — or add a comment there documenting why codex is excluded from --agent. (2) Docs the playbook checklist mandates: README.md agent list + port-allocation table row, CLAUDE.md app-tree entry for apps/codex-agent + run-codex in the activities line + codex.ts in the agent-cli list, .env.example OPENAI_API_KEY note. (3) Playbook: append a short codex worked example to docs/plans/agent-integration-playbook.md (JSONL thread.* event parser, OPENAI_API_KEY via Config.withDefault, mirrors pi/openhands — do NOT claim it introduced the Effect/telemetry pattern) and, per the harden-by-encoding principle, add a small guard (e.g. scripts/check-agent-parity.mjs run from root lint, or a cli/h/tests pytest) asserting every `run-<name>` case in apps/workflow-svc/src/infrastructure/activity-registry.ts has a matching AGENT_IDENTITY row or an explicit exclusion entry — that guard would have caught this drift at PR #53.

## [ ] A22. Skill agent/activity rosters omit run-pi and run-codex

*Severity: medium · effort: small*

**Gap:** workflow-orchestrator's 'Available activities' list — the menu an orchestrating agent builds steps from — omits run-pi and run-codex (both registered activities), and observe-h's agent roster stops at langgraph, omitting pi-agent and codex-agent; agents following these skills cannot dispatch to or reason about those agents.

**Evidence:** `/home/stiproot/code/h/skills/workflow-orchestrator/SKILL.md:46-47 (lists run-claude/run-openhands/run-dapr-agent/run-dapr-claude-loop/run-claude-managed/run-langgraph only)` · `/home/stiproot/code/h/.claude/skills/observe-h/SKILL.md:13 ('several agents (claude, openhands, dapr-agent, dapr-claude-loop, langgraph)')` · `Current truth: /home/stiproot/code/h/apps/workflow-svc/src/infrastructure/activity-registry.ts (run-pi and run-codex cases; run-pi at the runPiActivity registration, run-codex at line 47)`

**Do:** Immediate fix: (1) in /home/stiproot/code/h/skills/workflow-orchestrator/SKILL.md line 46, extend the activity list to `run-claude / run-openhands / run-pi / run-codex / run-dapr-agent / run-dapr-claude-loop / run-claude-managed / run-langgraph`; (2) in /home/stiproot/code/h/.claude/skills/observe-h/SKILL.md line 13, extend the roster to `(claude, openhands, pi, codex, dapr-agent, dapr-claude-loop, langgraph)`. Durable guard: create /home/stiproot/code/h/scripts/check-steering.mjs (it does not exist yet) with a rule that parses the `run-*` names from apps/workflow-svc/src/infrastructure/activity-registry.ts (the `case "run-…"` literals in getActivity) and fails if any is absent from skills/workflow-orchestrator/SKILL.md; wire it into the root package.json `lint` script beside scripts/check-templates.mjs, matching the existing content-guard pattern.

## [ ] A23. packages/js/telemetry (and git-core in README) missing from all package listings

*Severity: medium · effort: small*

**Gap:** packages/js/telemetry — the Effect/OpenTelemetry tracing layer (tracing/spans/bridge/context — the machinery CLAUDE.md's Observability section describes abstractly as 'initTracing (JS)') that codex-agent already consumes via makeTracingLive — appears in neither README.md's packages tree (lines 41-47 list agent-cli/agent-server/core/core-dapr/core-vercel/logger only; git-core is also missing there) nor CLAUDE.md's App layouts packages/js listing, which enumerates every other JS package file-by-file — so agents editing tracing code have no map for it, the Docker gotcha ('add its package.json COPY line to all relevant app Dockerfiles') has no anchor naming it, and a contributor cannot discover the repo's tracing package from any doc.

**Evidence:** `/home/stiproot/code/h/packages/js/telemetry/src/{tracing.ts,spans.ts,bridge.ts,context.ts,index.ts} on disk; package name 'telemetry' (packages/js/telemetry/package.json:2)` · `/home/stiproot/code/h/apps/codex-agent/src/index.ts:18 (imports makeTracingLive from telemetry)` · `/home/stiproot/code/h/README.md:41-47 (packages tree omits telemetry and git-core)` · `/home/stiproot/code/h/CLAUDE.md App layouts: packages/js listing covers agent-cli, agent-server, core, core-dapr, core-vercel, git-core, logger — no telemetry entry` · `dims: steering-drift, doc-gaps`

**Do:** (1) Add a `packages/js/telemetry/src/` block to CLAUDE.md's App layouts packages/js section (one-liners for index.ts — re-exports; tracing.ts — makeTracingLive/TracingLive Effect OTel layer + getTracer; spans.ts; bridge.ts; context.ts), and cross-link it from the Observability section's "initTracing (JS)" sentence so the abstract name resolves to the concrete package. (2) Add `telemetry/` and `git-core/` lines to README.md's packages/js tree (currently lines 43–48). (3) In the same pass, fix the adjacent verified drift: add `codex-agent` to README's apps list and an `apps/codex-agent/src/` block to CLAUDE.md's App layouts (it is entirely undocumented too). (4) For the automated guard: scripts/check-steering.mjs does NOT yet exist — if another audit finding creates it, extend its presence rule to cover `packages/js/*` and `packages/py/*` directory names appearing in both README.md's tree and CLAUDE.md's App layouts; otherwise create that script and wire it beside check-templates.mjs in the root lint pipeline (root package.json `lint`).

## [ ] A20. Retired 'family' vocabulary and marker-protocol residue in the steering agents load every run

*Severity: low · effort: small*

**Gap:** h-runtime.md — copied into every CLI agent's ~/.claude/CLAUDE.md at setup — still teaches the pre-2026-07-08 'families' vocabulary (retired for 'template' per CLAUDE.md's publish-mode gotcha) and its output-contract rule still legitimizes 'markers the task asks for' although marker parsing was retired 2026-07-15 (structured-only) and author-workflow-template explicitly forbids marker conventions; workflow-orchestrator and h-issues skills carry the same 'family' wording.

**Evidence:** `/home/stiproot/code/h/apps/claude-agent/steering/h-runtime.md:20 ('parameterized *families*'), :33 ('Any narrative, evidence, or markers the task asks for')` · `/home/stiproot/code/h/skills/workflow-orchestrator/SKILL.md:15,17,19 ('Prefer a published family', 'parameterized **families**', 'if a family fits')` · `/home/stiproot/code/h/skills/h-issues/SKILL.md:18 ('a rough edge in a workflow family')` · `Current truth: /home/stiproot/code/h/CLAUDE.md publish-mode gotcha ('named `family` before the 2026-07-08 vocabulary migration'); /home/stiproot/code/h/skills/author-workflow-template/SKILL.md:76 ('No output markers'); /home/stiproot/code/h/apps/workflow-svc/src/domain/structured-output.ts`

**Do:** Reword the retired vocabulary only: in /home/stiproot/code/h/apps/claude-agent/steering/h-runtime.md:20 change 'parameterized *families*' to 'parameterized *templates* (saved workflows with open {{params.x}} slots)'; in /home/stiproot/code/h/skills/workflow-orchestrator/SKILL.md:15,17,19 replace 'family/families' with 'template(s)'/'parameterized saved workflow(s)'; in /home/stiproot/code/h/skills/h-issues/SKILL.md:18 change 'a rough edge in a workflow family' to 'a rough edge in a workflow template'. Do NOT remove 'or markers' from h-runtime.md:33 — templates still legitimately ask for prose markers (e.g. cli/charts/workflows/templates/feature.yaml:115) and the line encodes the required ordering relative to the structured block. Then lock the vocabulary with a forbidden-regex check (e.g. /\bfamil(y|ies)\b/ scoped to skills/**/SKILL.md and apps/claude-agent/steering/*.md, with an allowlist escape comment) in a new scripts/check-steering.mjs, wired into root package.json's lint beside check-templates.mjs.

## [ ] A21. cli/README command reference is two shipped plan-cycles behind the CLI

*Severity: low · effort: small*

**Gap:** cli/README.md's command block documents neither the schedule-and-fallback surface (no --at/--in, --fallback-agent/-model/-after/-max on `h workflow run`, no `h workflow pause|resume`, no `h schedule list|rm` entries — all shipped and e2e-validated 2026-07-18) nor the inline-chain-cron surface (chain EXPR shown without --parallel/--stage/--cron/--max-fires/--id/--inline, and threading shown as `--input PARAM=BB` instead of the dotted `id.field` SRC form — shipped 2026-07-20), so an agent or human reading the CLI's own README composes with a stale flag set.

**Evidence:** `/home/stiproot/code/h/cli/README.md:95 (workflow run flag list ends at --cron/--max-fires), :97-101 (chain EXPR: only --agent/--model/--fresh/--kind + '--input PARAM=BB'; no schedule/pause/resume commands in the block)` · `Current truth: /home/stiproot/code/h/cli/h/src/h_cli/commands/workflow.py:325,334 (--at/--in), :291 (fallback_agent); /home/stiproot/code/h/cli/h/src/h_cli/infrastructure/chain_expr.py:7-48 (--parallel connector, --stage/--cron/--max-fires/--id/--inline, dotted inputs); /home/stiproot/code/h/cli/h/src/h_cli/commands/schedule.py`

**Do:** Update cli/README.md's command block: (1) line 95 — extend the `h workflow run` line with `[--at ISO | --in DUR]` and `[--fallback-agent A [--fallback-model M] [--fallback-after DUR] [--fallback-max N]]` (copy the wording from root README.md:353-354, which is already correct); (2) after line 96, add three lines: `uv run h workflow pause <instanceId> <key> --in DUR` (terminate + arm a resume continuation reusing the workspace), `uv run h workflow resume <schedId>` (fire the continuation now), and `uv run h schedule list|rm <id>` (the one-shot cron:sched surface); (3) lines 97-100 — extend the chain EXPR description with the `--parallel` infix connector and per-member `--stage N / --cron CADENCE / --max-fires N / --id NAME / --inline` flags (per chain_expr.py:7-48), and change `--input PARAM=BB` to `--input PARAM=SRC` with SRC = flat key or dotted `id.field` (the D5 namespaced-blackboard form). Optionally, since no guard covers README-CLI sync and the repo's 'harden by encoding' principle applies, add a small pytest in cli/h/tests (e.g. test_readme_flags.py) asserting each Typer-registered flag/command name in commands/{workflow,chain,schedule}.py appears somewhere in cli/README.md — cheap drift tripwire, though this hardening is optional given the low severity.

## [ ] A24. apps/claude-agent/CLAUDE.md carries a misplaced dapr-claude-loop-agent doc section

*Severity: low · effort: small*

**Gap:** The workspace-rules steering file loaded for claude-agent contexts devotes lines 21-74 (of 74) to documenting a different service entirely (dapr-claude-loop-agent's layout, run script, Docker profile, and demo workflow) — content that belongs in apps/dapr-claude-loop-agent/ and that dilutes the actual workspace rules (path confinement + review format) an agent must obey.

**Evidence:** `/home/stiproot/code/h/apps/claude-agent/CLAUDE.md:21-74 ('## dapr-claude-loop-agent' section with that app's layout tree and run instructions)` · `Correct home: /home/stiproot/code/h/apps/dapr-claude-loop-agent/ (the app the section describes)`

**Do:** Delete the `## dapr-claude-loop-agent` section (apps/claude-agent/CLAUDE.md:21-74) outright rather than moving it: every accurate piece already has a long-lived home (root CLAUDE.md App layouts + hex-lint gotcha for the no-import-linter rationale; README.md rows 18/178/192/226/258/274 for run script, compose profile, and ports), and the section's unique claims are wrong (port 8005 vs actual 8007; obsolete `docker compose --profile claude-managed` vs `cli/scripts/compose.sh --profile dapr-claude-loop-agent`). Leave apps/claude-agent/CLAUDE.md as the two workspace rules + code-review output format, matching the shape of apps/openhands-agent/.openhands/skills/steering-rules.md. Optionally add a stanza to scripts/check-templates.mjs (or a new scripts/check-steering.mjs wired into root `lint`) asserting per-app agent steering files (apps/*/CLAUDE.md, apps/openhands-agent/.openhands/skills/steering-rules.md) contain no `## <other-app-name>` headings, encoding the rules-only invariant.

## [x] A29. h-builds-h.md carries an actively false status line

**DONE 2026-07-28** — fixed as part of a full plans-grooming pass, and hardened beyond what
this item asked. `h-builds-h.md` now reads `Status: Complete` with both supersessions stated
up front (the `issue-sweep` agent tick retired 2026-07-12; `claude-coder` retired 2026-07-14),
its phase-4 leftovers lifted to `docs/plans/carried-followups.md` §16–§18, and it is archived
to `docs/plans/impl/` — as is `workflow-watcher-registry.md`, per this item's note, plus 17
other completed plans. The generalization: `scripts/check-plans.mjs` (wired into `bun run
lint`) now enforces the status vocabulary, `Established:`, `Lifted to:` on archived plans, and
that every `docs/plans/**.md` citation from outside `docs/plans/` resolves. As this item
predicted, a headline-word regex would have been the wrong guard — the check validates that a
plan's claim is *well-formed*, never that it *should* be archived.

*Severity: low · effort: small*

**Gap:** docs/plans/h-builds-h.md states 'Status: design complete (2026-07-05); phase 0 not started' while the loop it designs has been operating for weeks (the runbook exists, PRs #52/#53 were produced by it) — a status a checker keyed on DONE/SHIPPED words would not flag, and one that misleads any reader reconstructing system state from the plans.

**Evidence:** `/home/stiproot/code/h/docs/plans/h-builds-h.md:3` · `/home/stiproot/code/h/docs/h-builds-h-runbook.md:1-14` · `git log: 39d5b78 'feat(codex-agent): ... (#53)' — loop-produced PR`

**Do:** Fix docs/plans/h-builds-h.md:3 to reflect reality, e.g.: "**Status:** SHIPPED — the loop runs live (two engine crons, no sweep agent; operational home: docs/h-builds-h-runbook.md; mechanism: docs/plans/workflow-watcher-registry.md §9-§10). Validated live 2026-07-20 (PR #52) and 2026-07-21 (PR #53)." Then, per the plan-management skill, lift the still-open items from its progress log (phase-4 backlog, the review-comment-resolution note) into the runbook or an issue BEFORE archiving to docs/plans/impl/. Note: workflow-watcher-registry.md is also DONE (2026-07-12) yet still sits in docs/plans/ — archive both in the same pass so impl/ (currently only revise-rebase-stale.md) reflects the actual completed set; do NOT claim it is already archived.

## [ ] A30. README workspace layout omits the skills/, docs/, and web/ top-level dirs

*Severity: low · effort: small*

**Gap:** README.md's workspace-layout tree lists apps/packages/dapr/k8s/config/cli but not skills/ (the harness skill source, documented only in CLAUDE.md), docs/ (the plans discipline + runbook), or web/ (the viz sandbox), so from README alone a new contributor finds the CLI and charts but not the skills or the planning/runbook docs — undermining the onboarding path (no dead links exist, but these dirs are simply absent).

**Evidence:** `/home/stiproot/code/h/README.md:27-58 (tree ends at docker-compose.yml; no skills/, docs/, web/ entries)` · `/home/stiproot/code/h/skills/ (exists: linear, analyze-workflow-run, workflow-orchestrator, h-issues, author-workflow-template)` · `grep -n 'skills' README.md -> only an external oxc docs URL match`

**Do:** Edit /home/stiproot/code/h/README.md's workspace-layout tree (the fenced block at lines ~28-73) to add three entries in tree order: `skills/` — harness agent skills copied into agents' ~/.claude/skills at setup (linear, analyze-workflow-run, workflow-orchestrator, h-issues, author-workflow-template; see CLAUDE.md 'h skills'); `docs/` — plans discipline (docs/plans/, archived under docs/plans/impl/) + docs/h-builds-h-runbook.md; `web/` — experimental runtime-viz sandbox, deliberately outside the apps/* workspace glob (see web/README.md). Drop the original proposal's 'scripts/check-docs.mjs presence check' — no such script exists (scripts/ has only check-tsc.mjs and check-templates.mjs). Optionally, to honor 'harden by encoding', add a small scripts/check-readme-tree.mjs (run from root `lint` beside check-templates.mjs) that asserts every tracked top-level directory (`git ls-tree -d --name-only HEAD` minus an allowlist) appears in README.md's layout block; this is optional — the primary fix is the doc edit.

## Log

- 2026-07-23 — Split out of the monolithic hardening-audit plan.
