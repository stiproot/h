# Follow-ups: workflow registry / cron primitive

**Status:** backlog — deferred items carried out of
[workflow-watcher-registry.md](./workflow-watcher-registry.md) when that plan closed (2026-07-12,
DONE). None block the h-builds-h loop, which shipped complete (discovery cron → supervised
`feature-pr` (+arm-revise) → per-PR revise-until-merged cron; `issue-sweep` retired; §10 registry-
creation cut landed). These are the named follow-ups the plan parked, each to spec + build when a
concrete use-case lands. Ordered roughly by how soon a real need is likely.

## 1. `h cron rm <id>` — per-cron deactivate (CLI)

Today a single cron stops only via: its goal resolving (`===GOAL===RESOLVED`), its `maxFires`/daily
budget exhausting, or the family kill switch (`state_save cron:config {enabled:false}`, which pauses
EVERY cron). There is no targeted "stop this one cron" surface. Needs: a `DELETE`/deactivate path
(engine writes the row's `status: inactive`, single-writer) + `h cron rm <cronId>` / `h cron discover
rm <repo>:<label>`. Surfaced while writing the h-builds-h runbook; likely the first one actually
wanted operationally.

## 2. `--cron` vs `--schedule` — unify or coexist? *(plan Open Q2)*

`h workflow publish --schedule "*/30…"` crons a *saved workflow by key* (fired by the
workflow-cron-tick over saved schedules). The `--cron` primitive is *target-scoped* (a
`cron:sub:<repo>:<slug>:<workflow>` row pointing at a `wf:` record + its goal). Two mechanisms that
both "run a workflow on a clock." Decide: generalize into one (a `cron:` row that targets either a
saved key or a `wf:` record), or keep them as deliberately-distinct tools (schedule = fire-a-template
forever; cron = recur-until-goal). Leaning coexist, but worth an explicit call before either grows
more surface.

## 3. `--dynamic-cron` — an agent registers a cron mid-run *(plan Open Q4)*

We chose the deterministic `arm-revise`/`arm-cron` *step* over an agent deciding, mid-run, to register
a cron (the register-cron activity is engine-side, no agent tool). `--dynamic-cron` remains an open
idea for the case where the follow-up work is *discovered by the agent* and can't be a fixed step.
Exact semantics unresolved: does the agent register a cron for THIS workflow's recurrence, for
follow-up work it discovers, or both? Needs a register-cron MCP tool (surface-expansion review — the
executor's minimal MCP surface is a security invariant) before it can exist.

## 4. `loop-until-clean` chain strategy *(plan Open Q5 — partially resolved)*

**Resolved in practice:** the "keep revising a PR until it's clean/merged" loop is now the per-PR
**revise recur cron** armed at PR birth (§10, Job 2) — looping outlives any single chain run, which is
the better home. **Still stubbed:** the `loop-until-clean` *chain strategy* itself (chain.model.ts has
the `ChainStrategy` literal + `loopControl` shape, but the engine strategy is deferred). Build it only
if a genuine within-a-chain loop (distinct from the standing revise cron) turns up; otherwise consider
removing the stub.

## 5. Liveness-on-death for `wf:` rows *(plan Deferred + Open Q7)*

The build assumes clean self-reporting: a workflow writes its own `wf:running` then `done`/`failed`.
A run that **dies before writing a terminal status** leaves a non-terminal `wf:` row that nothing else
may write (single-writer). Handling it is a READ concern: the reader (chain/cron engine) should treat
a non-terminal row whose Dapr instance is gone as `orphaned` (the existing UNKNOWN-streak logic), with
the **watcher** primitive supervising the live instance as the backstop. A follow-up PR, not wired yet.

## 6. Cron source mode 3 — dynamic params *(plan Deferred)*

A cron that derives its params **fresh each tick** (params change tick-to-tick) rather than re-firing
fixed params (mode 1, saved key+params) or a frozen definition (mode 2, embedded steps). Needs a
**param-source contract** — where the fresh values come from (a reader plugin, prior `wf:` output, a
GitHub query). Powerful; modes 1 & 2 shipped, mode 3 waits for a concrete use-case. (Note: the
discovery cron already covers the common "enumerate a source → fan out" shape without mode 3.)

## 7. Compose-to-disk — authoring a new template file *(plan Deferred, plan stub)*

`h template compose … --save` persists the composed *definition to workflow-svc state*, not a new
`.yaml` on disk. Authoring a genuinely new reusable **template file** alongside the others
(re-composable, `git`-trackable) is wanted but unspecced. Plan stub.

## 8. Optional worktree for a workflow + the `pr-review` case *(plan Deferred, plan stub — security-gated)*

A step should accept an optional `worktreePath`: reuse a prior chain member's, else create one. Clean
for h-authored branches. The sharp part is **`pr-review` gaining a worktree**: reading the tree for
context is one risk tier; *running commands* on a PR's code executes untrusted third-party code in a
secret-bearing agent — the blast radius the reviewer's minimal-surface invariant denies
([reviewer-identity-security.md](./reviewer-identity-security.md)). Three lines to choose between:
(1) read-only context, no execution; (2) full worktree + execution behind a no-secrets/egress-
restricted runtime posture; (3) keep the reviewer read-only via MCP and hand "needs to run" to a
separate trusted validation workflow. Creation must be a conditional *workflow step* (a `withWorktree`
param), never an agent tool. Decide the line, then build; `pr-review` capabilities stay AS-IS until
then.
