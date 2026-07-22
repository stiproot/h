# Broaden `revise` to rebase a stale PR branch onto main

Status: Planning — teach `revise` to rebase a stale PR branch onto main + resolve conflicts
Established: 2026-07-22

## Context

PR #52 (`stiproot/h`, head `feature/issue-51-e2e`) is in `mergeable_state: "dirty"` — it has
real merge conflicts against `main`. There is **no** workflow that "refreshes" a PR (brings its
branch current with `main` and resolves conflicts), and the existing `revise` workflow does **not**
do this: today it only reads the PR's *unresolved review threads* and addresses code-review
feedback with a **plain push**. A repo-wide search confirmed rebase / merge-into-main / force-push
machinery exists **nowhere** in the codebase — this is net-new behaviour.

Decision (user): rather than a separate `refresh-pr` workflow, **broaden `revise`** so that, when
the branch is stale, it rebases onto the latest `origin/main` (resolving conflicts) before
addressing review threads. This is the cheaper and better-grained option because **`revise` is
already a first-class chain kind**, so the change touches **only the chart template + one golden
snapshot** — no engine, no CLI, no new template, no new kind.

Git strategy (user-selected): **rebase + `--force-with-lease`** (never a bare `--force`).

## Design (conservative broadening — rebase only *if stale*)

`revise` keeps its exact existing behaviour when the branch is NOT behind `main`. The new
rebase/force-push path activates ONLY on a stale branch. New task flow inside the `revise` step:

1. **Fetch + staleness check.** `git fetch origin main feature/<slug>`. Capture the PR's current
   remote tip: `EXPECTED=$(git rev-parse origin/feature/<slug>)`. `STALE` = `origin/main` is NOT an
   ancestor of `HEAD` (`git merge-base --is-ancestor origin/main HEAD` → non-zero exit ⇒ stale).
2. **Rebase if stale.** `git rebase origin/main`; resolve conflicts, up to 3 attempts, never
   weakening the code. If it cannot be resolved: `git rebase --abort`, push nothing, resolve no
   threads, and report the reason in `skipped` (goal stays `PENDING`).
3. **Address unresolved review threads** — unchanged from today (steps 1–2 of current prose).
4. **Acceptance gate** — the existing `verifyCmd` block, run on the FINAL tree (after rebase +
   thread edits) so one verify covers both. On failure after 3 attempts: push nothing, skip, report.
5. **Commit** thread edits — unchanged.
6. **Push (conditional).** If `STALE` (history was rewritten) → force-with-lease; else → the
   existing plain push. All-or-nothing per run: a run pushes only a rebased **and** verified tree.
7. **Reply + resolve threads**, then **report goal** — unchanged. Thread resolve still works
   post-rebase because it uses stable thread node ids (`PRRT_…`), not commit SHAs.

Output contract (`pr`/`url`/`skipped`/`goal`) is **unchanged**.

### Force-push gotcha (must get right)
`--force-with-lease` with **no args** relies on a remote-tracking ref for the named `origin` remote.
- **SSH path** (pushes to the named `origin` remote): plain `git push --force-with-lease origin
  feature/<slug>` works after the step-1 fetch (the `origin/feature/<slug>` tracking ref is set).
- **PAT path** (pushes to a one-shot token **URL**, not a named remote — so there is no tracking
  ref): MUST use the explicit lease form so the lease is defined:
  `git push --force-with-lease="feature/<slug>:${EXPECTED}" "https://x-access-token:${GH_TOKEN}@github.com/<owner>/<repo>.git" feature/<slug>`
  where `${EXPECTED}` is the `origin/feature/<slug>` SHA captured in step 1.

## Files to change

- **`cli/charts/workflows/templates/revise.yaml`** (the only substantive edit):
  - Header comment (lines 1–13) — note revise now also rebases a stale branch onto main.
  - `revise` step task prose (lines 96–138) — insert the fetch/staleness/rebase preamble before
    the existing thread-addressing steps; reword the acceptance-gate block (currently lines 107–114)
    to run on the final tree and to also guard the rebase; make the push (lines 119–128) conditional
    force-with-lease per the gotcha above; extend the `skipped`/report prose to name unresolvable
    rebase conflicts. Steps `worktree → setup → revise` and the output contract stay identical.
- **`cli/charts/workflows/values.yaml`** — no change needed. `revise.remoteBase: ""` stays (the
  task fetches `main` itself). `values.local.yaml`'s `revise.verifyCmd` /`gitAuth: pat` already
  drive the acceptance gate and the PAT push branch.
- **No engine/CLI changes.** `revise` is already registered (`ChainWorkflowKind`,
  `WORKFLOW_KINDS.revise`, `chain.py`'s dicts). Untouched.

## Tests / goldens

- `cli/h/tests/test_render.py`: `test_revise_is_worktree_setup_revise` still passes (step ids
  unchanged). `test_revise_golden` and any arm-revise compose snapshot that embeds revise prose will
  diff — re-bless with `uv run --package h-cli pytest cli/h -k render --snapshot-update`, then review
  the `.ambr` diff carefully (only the intended prose should change).
- `cli/h/tests/__snapshots__/test_render.ambr` — the re-blessed snapshot.

## Verification (end-to-end, against the real PR #52)

Requires the h stack running (host or compose).
1. Re-publish the saved workflow so the edited template takes effect:
   `uv run h workflow publish revise` (template edits don't reach the saved render until republished).
2. Fire against the conflicted PR:
   `uv run h workflow run revise -p pr=52 -p slug=issue-51-e2e --agent claude-agent`
   (`slug=issue-51-e2e` — the PR's head is `feature/issue-51-e2e`).
3. Watch: `uv run h watch list` and the run ledger / traces (obs MCP, `analyze-workflow-run` skill).
4. Confirm the fix: re-read PR #52 (github MCP `pull_request_read`) — `mergeable_state` should flip
   from `dirty` to `clean`/`blocked` (no longer conflicted), and the branch should sit on top of the
   current `main`.

## Notes / tradeoffs

- **First force-push in the codebase.** Scoped to `--force-with-lease` (never bare `--force`) and
  only on the agent-owned feature branch — the safe primitive for a rewritten branch. Worth a
  memory once landed.
- **All-or-nothing per run.** A run with an unresolvable rebase conflict (or a failing verify)
  pushes nothing and reports `skipped`; the next loop iteration retries. A genuinely un-rebaseable
  PR stays conflicted until a human steps in — acceptable for v1, surfaced via `skipped`.
