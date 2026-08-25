# Phase 3 — Cross-stack sync guards

Status: Complete — both guards landed in PR #55 (squash 940f5dc, closes #54)
Established: 2026-07-23
Parent: [hardening-audit index](./README.md) — read its context + executing-agent instructions first.

Tests that pin surfaces maintained in two places (TS engine ↔ Python CLI ↔ steering docs). Each would have caught drift this audit found live.

## [x] A2. WORKFLOW_KINDS closed literal is dual-maintained across engine (TS) and CLI (Python) with no sync guard

*Severity: medium · effort: small*

**Gap:** CLAUDE.md states a novel chain kind 'is added on BOTH sides, engine + CLI', but the two literals — ChainWorkflowKind in chain.model.ts and KNOWN_KINDS in chain.py — plus the CLI's four parallel per-kind dicts (KIND_KEYS, KIND_INSTANCE, KIND_MODEL_PARAMS, TERMINAL_ATOM_KIND) and config.py's hand-unioned MODEL_PARAM_SLOTS are kept in sync purely by discipline; an engine-side kind missing CLI-side is silently unreachable from `h chain run`, and a stale MODEL_PARAM_SLOTS silently drops --model params.

**Evidence:** `apps/workflow-svc/src/domain/models/chain.model.ts:50 (Schema.Literal("feature-pr", "pr-review", "revise", "agent-panel"))` · `cli/h/src/h_cli/commands/chain.py:62 (KNOWN_KINDS tuple duplicating the literal)` · `cli/h/src/h_cli/commands/chain.py:70-98 (KIND_* parallel dicts keyed by kind)` · `cli/h/src/h_cli/config.py:58-60 (MODEL_PARAM_SLOTS = manual union of KIND_MODEL_PARAMS)`

**Do:** Add cli/h/tests/test_kind_sync.py (runs in the existing `uv run --package h-cli pytest` suite; repo-relative file access is established practice via the chart goldens): (a) regex-extract the ChainWorkflowKind Schema.Literal list from apps/workflow-svc/src/domain/models/chain.model.ts (resolve via Path(__file__).parents[4] / 'apps/workflow-svc/src/domain/models/chain.model.ts', skip-with-failure-message if absent) and assert set-equality with h_cli.commands.chain.KNOWN_KINDS; (b) assert WELL_KNOWN.keys() == KIND_FIRE.keys() == KIND_MODEL_PARAMS.keys() == set(KNOWN_KINDS), and set(TERMINAL_ATOM_KIND.values()) | FROZEN_EXECUTOR_KINDS ⊆ set(KNOWN_KINDS) (TERMINAL_ATOM_KIND maps atom→kind, so its VALUES not keys are checked); (c) assert set(h_cli.config.MODEL_PARAM_SLOTS) == union(KIND_MODEL_PARAMS.values()). In the same change, fix the live drift the new test exposes: add "modelRevise" to MODEL_PARAM_SLOTS in cli/h/src/h_cli/config.py:60 so `h workflow run revise --model` / `--fallback-model` actually set the revise template's model slot.

## [x] A19. No machine guard checks steering docs against repo reality (the drift that produced every other finding)

*Severity: medium · effort: medium*

**Gap:** The repo's stated 'Harden by encoding' principle covers architecture (dependency-cruiser, import-linter) and content (check-templates.mjs) but nothing guards the steering surfaces themselves: no script asserts that every apps/* and packages/{js,py}/* directory appears in CLAUDE.md/README (CLAUDE.md's 'App layouts' presents itself as the per-app index steering every agent session, yet codex-agent and packages/js/telemetry appear zero times in it), that every activity in activity-registry.ts appears in the docs agents plan from, or that retired vocabulary (family, output markers) stays out of skills/ and steering/ — which is exactly how codex-agent, telemetry, and the family wording drifted unnoticed.

**Evidence:** `/home/stiproot/code/h/scripts/ (only check-tsc.mjs and check-templates.mjs exist)` · `/home/stiproot/code/h/scripts/check-templates.mjs (guards only bare force-push in chart templates)` · `/home/stiproot/code/h/CLAUDE.md App layouts vs disk: apps/codex-agent and packages/js/telemetry undocumented; grep -c 'telemetry|codex' CLAUDE.md → 0; grep codex README.md → no matches (verified 2026-07-22)` · `/home/stiproot/code/h/apps/codex-agent/src/infrastructure/codex-runner.ts + docker-compose.yml:403-425 + packages/js/telemetry/package.json (the components that drifted)` · `dims: arch-lint, steering-drift`

**Do:** Add scripts/check-steering.mjs, wired into root package.json "lint" beside check-templates.mjs: (a) assert every directory under apps/ and packages/js|py/ appears by name in CLAUDE.md (the App layouts / package sections) and README.md, with an explicit in-script allowlist for deliberate omissions (seed it empty; web/ is outside apps/ so needs no entry); (b) assert every `case "run-*"` activity name in apps/workflow-svc/src/infrastructure/activity-registry.ts appears in CLAUDE.md's activities line and skills/workflow-orchestrator/SKILL.md. DROP the proposed \bfamil(y|ies)\b forbidden-regex — 'parameterized families' is current vocabulary (apps/claude-agent/steering/h-runtime.md:20, skills/workflow-orchestrator/SKILL.md:15-19); if retired-vocab checking is wanted, scope it to chart-value syntax only (e.g. forbid `.Values.family` / `--set family=` in cli/charts and skills) plus `POST /cron/discover`. Then document apps/codex-agent (App layouts entry + run-codex in the activities list + AGENT_IDENTITY note if applicable) and packages/js/telemetry (packages/js listing, linking it to the existing initTracing prose at CLAUDE.md:422) to make the new guard pass.

## Log

- 2026-07-23 — Split out of the monolithic hardening-audit plan.
- 2026-07-23 — Carried out by h: issue #54 → chain `hardening-sync-guards` (feature-pr → pr-review CLEAN, 0 revise iterations) → PR #55, squash-merged (940f5dc). A2: `cli/h/tests/test_kind_sync.py` + `modelRevise` slot fix. A19: `scripts/check-steering.mjs` wired into root lint (enforcing) + codex-agent/telemetry documented in CLAUDE.md/README + `run-codex` in the orchestrator skill. Bonus: fixed a pre-existing-broken `agent-cli/invoker.test.ts` mock (Promise → `Effect.succeed`). Reviewer's two "verify" findings assessed as non-issues (run-* scope is per-spec; SKILL.md has all 8 activities). Both guards enforce on `bun run lint` / `uv run --package h-cli pytest` going forward.
