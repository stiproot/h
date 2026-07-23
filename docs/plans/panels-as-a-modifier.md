# Panels as a workflow modifier (not a separate workflow)

Status: Planning — vision + key decisions captured; needs design before implementation
Established: 2026-07-23

## The idea

Today a multi-agent panel is its OWN thing: the `agent-panel` chart template + the `agent-panel`
chain kind — a distinct workflow you compose as a member. That makes "run something as a panel" a
special workflow rather than a capability.

**Flip it: a panel should be a standard MODIFIER on ANY workflow.** "Run N agents concurrently and
synthesize" is orthogonal to *what* the workflow does — so it belongs as a dimension every workflow
member can carry, the same way `--agent`, `--model`, and `--stage` already are. Any workflow becomes
panelizable:

- **panel review** — `pr-review` run as a panel ⇒ N reviewers (claude ∥ codex ∥ openhands) each
  leave comments, verdicts synthesize into one CLEAN/NOT-CLEAN that drives `loop-until-clean`. (The
  immediate motivator — see [[codex-chatgpt-auth]] e2e: the user wants "a panel reviews and leaves
  comments, then codex revises until done".)
- **panel implement** — `feature` run as a panel ⇒ N implementations, pick/merge the best.
- **panel plan**, **panel revise**, … — any step where independent perspectives beat one attempt.

The existing `agent-panel` kind becomes the degenerate case (panelize a bare "answer this task"
step), or is subsumed entirely.

## Shape (to be designed)

A per-member flag, e.g. `--panel claude,codex,openhands` (explicit roster) or `--panel 3` (fan-out
count), that wraps the member's steps in the existing parallel-group machinery
(`generic.workflow.ts` whenAll — docs/plans/multi-agent-panel.md) and runs one branch per agent,
then a synthesis step. It composes with the current expression, e.g.:

```
-t feature verify create-pr --agent codex        # codex implements
-w pr-review --panel claude,codex,openhands       # PANEL reviews + comments
-t revise --agent codex                           # codex revises
--strategy loop-until-clean
```

## The load-bearing design questions

1. **Per-workflow synthesis is not one thing.** A panel's join differs by workflow:
   - *review* → aggregate N verdicts into one CLEAN/NOT-CLEAN (majority? any-blocker? unresolved
     threads?) AND leave all N sets of comments on the PR.
   - *implement* → choose/merge among N candidate branches (a judge? best-by-verify? human?).
   So "panel" needs a per-kind synthesis contract, not a single generic synthesizer. This is the
   crux — decide whether synthesis is declared by the workflow (each template ships a "how to
   synthesize a panel of me" step) or supplied at the panel site.
2. **loop-until-clean coupling.** The loop keys off the pr-review member's single structured verdict
   (chain-scan). A panel review must still emit ONE verdict at that seam — so panel synthesis for
   review has to produce the same structured-output contract a single pr-review does. Keeps the
   loop engine unchanged; the panel is invisible below the verdict.
3. **The executor pin.** `pr-review`'s executor is pinned to claude (`FROZEN_EXECUTOR_KEYS`,
   config.py) — an operational default, not a security boundary (docs/plans/reviewer-identity-security.md).
   A panel review inherently uses multiple executors, so the pin must relax to "the panel roster"
   for a panelized member. Decide how that interacts with the trust model.
4. **Comments + threads.** pr-review posts inline review comments and (long-term) resolves threads.
   N panelists posting must not collide or double-post; decide attribution (per-agent review) and
   whether resolution is per-panelist or on the synthesized verdict.
5. **Cost / concurrency.** Panelizing multiplies agent runs per stage; bound the roster and surface
   the cost (the watcher's cost tally already exists).

## Relation to what exists

- Reuses the parallel-group fan-out already in `generic.workflow.ts` + `agent-panel`'s coded
  contract (`chain-workflows.ts`) — this is a generalization of that, not new fan-out machinery.
- The `agent-panel` chart template + kind are the prior art to subsume; a migration keeps them
  working (or reframes them as `--panel` sugar) rather than an atomic cutover mid-design.

## Cross-links

- [[codex-chatgpt-auth]] — the e2e that motivated this (codex implement → panel review → codex revise).
- docs/plans/multi-agent-panel.md — the existing panel/parallel-group machinery this builds on.
- docs/plans/reviewer-identity-security.md — the pr-review executor-pin trust context (Q3).

## Log

- 2026-07-23 — Stub created while running the codex e2e (option A) with a single claude reviewer,
  because a panel-review-with-comments-and-loop-verdict is not yet built. Captured the reframing
  the user asked for: a panel is a per-workflow MODIFIER, not a separate workflow. Not yet designed
  — the open synthesis-contract question (Q1) is where design must start.
