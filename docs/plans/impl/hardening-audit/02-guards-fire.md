# Phase 2 — Make the guards fire

Status: Complete — the one item (A0) landed 2026-07-29 via PR #100; verified firing live
Established: 2026-07-23
Parent: [hardening-audit index](./README.md) — read its context + executing-agent instructions first.

The single high-severity finding: every encoded guard is manual-invocation-only. Everything in phases 3–5 only matters if something runs it.

## [x] A0. Entire guard surface runs only on manual invocation — no CI or git hook executes it

> **VERIFIED COMPLETE 2026-07-31 (landed 2026-07-29, PR #100).** Both layers exist and FIRE:
> `.github/workflows/guards.yml` runs the full lint→build→test→pytest surface on every push
> (self-hosted `h-dev` runner, tools/ci-runner/ — it caught PR #103's ruff violations live on
> 2026-07-30), and the pre-push hook (`scripts/hooks/pre-push`, `core.hooksPath`) runs the lint
> half locally. The branch-protection follow-up is carried-followups §16.

*Severity: high · effort: medium*

**Gap:** Every encoded guard (check-tsc.mjs, check-templates.mjs, dependency-cruiser, import-linter, vitest/pytest, syrupy goldens) is wired only into `bun run lint` / `make lint` / test scripts that nothing triggers automatically: the repo has no .github/ directory, no pre-commit config, no husky, no core.hooksPath, and no non-sample .git/hooks — combined with the commit-directly-to-main convention, any invariant violation can land on main without a single guard ever running.

**Evidence:** `package.json:3 (lint pipeline exists but is invocation-only)` · `Makefile:104 (lint: lint-js lint-py — manual target)` · `repo root: no .github/, no .pre-commit-config.yaml, no husky dir; `git config core.hooksPath` empty; .git/hooks contains only samples (verified 2026-07-22)`

**Do:** Two-layer fix, ordered by fit with the repo's local-first design: (1) Tracked pre-push hook — add .githooks/pre-push running `bun run lint` (this alone fires check-tsc.mjs, check-templates.mjs, and the dependency-cruiser hex rules via turbo) plus `make lint-py`, and a `make install-hooks` target (`git config core.hooksPath .githooks`) invoked from the CONTRIBUTING.md setup steps and idempotently from cli/scripts/_lib.sh so agent/host launches self-heal it — this composes with the intentional commit-on-main convention (guards fire at push, not commit). (2) .github/workflows/lint.yml on push to main and pull_request: `bun install --frozen-lockfile && bun run lint && bun run test` + `uv sync --frozen && make lint-py && uv run --package h-cli pytest` — note the pytest job needs helm on the runner (the syrupy goldens shell out to `helm template`; see cli/h/src/h_cli/infrastructure/helm adapter), so add a helm setup step (e.g. azure/setup-helm). The webhook exclusion in docs/plans/h-builds-h.md:297 (local deployment, no inbound reachability) does not block Actions — they run on GitHub's runners and the repo already lives on GitHub (PRs #51-53). Also fix the stale claim at docs/plans/schedule-and-fallback.md:230 that "CI's bun run build regenerates" dist, or make it true by adding a build job.

## Log

- 2026-07-23 — Split out of the monolithic hardening-audit plan.
