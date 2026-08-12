# Carried follow-ups — deferred items from archived plans

Status: Deferred — the one home for open items carried out of plans archived to `impl/`; each has a named revisit trigger, none blocks current work
Established: 2026-07-28

## Why this doc exists

A plan archives when its work is done and its durable context is lifted. But a finished
plan often leaves one or two *deliberately deferred* items — too small to keep a whole plan
active, too real to drop. Before this doc they either kept a completed plan artificially
"Active" or vanished on archive.

The convention, therefore: **an archived plan's remaining open items move here, and its
`Lifted to:` line points at this file.** One greppable home, one status line, no
proliferation of near-empty follow-up docs. An item leaves here by being built, by becoming
a GitHub issue (the h-builds-h loop's queue — the route `panels-as-a-modifier` took for
#76–#79), or by being explicitly dropped with a reason.

This absorbs the former `workflow-registry-followups.md` (established 2026-07-12), whose
items are §5–§10 below; its two resolved items are recorded as such rather than deleted, so
the record of *why* they closed survives.

---

## From [chain-composition-surface](./impl/chain-composition-surface.md)

### 1. Slice E — per-member `--budget` is parsed but not enforced — RESOLVED 2026-08-11

`h chain run` accepted a per-member `--budget DUR` and validated its format, then refused it
with a warning. It now maps to `watch: {maxDurationMs}` on the member entry, which the
`fireWorkflow` → `invokeWithWatch` seam registers as an ordinary watch row — so the WATCHER
budget-terminates an overrunning member and the chain fails as a unit via D6 teardown.

Built and merged via PR #108 ([per-member-budget](./impl/per-member-budget.md)). The engine
half had already landed inside [fire-descriptor](./impl/fire-descriptor.md); this was the CLI
half. Two things outlived it and are carried below as §1a and §1b.

### 1a. Per-member budget: no LIVE acceptance run yet

Acceptance items 1–2 of the plan — registering a chain with a member budget and watching the
watcher actually budget-terminate that member, with the chain finalizing failed — have never
been run. They need a service stack (chain engine + watcher on the cron tick); everything
merged is unit-level plus a CLI-level refusal check.

*Revisit when:* a service stack is up for other reasons and a chain is being fired anyway —
this rides along rather than justifying its own bring-up.

### 1b. Chain-wide `--budget` silently dropped on `--local` — RESOLVED 2026-08-11

`chain.py` refused a PER-MEMBER `--budget` on `--local` by name while accepting a chain-wide one
and then dropping it — one command, two budget positions, one stated answer and one silent.

Resolved by completing a mirror rather than adding a refusal: `local-runtime`'s `chain.ts` already
reimplemented the chain engine's `decide` (stages, join, loop-until-clean, iteration budget) and
lacked only its wall-clock branch — the one branch needing a deadline rather than durability.
`ChainJob` now carries `budgetMs`, `runChain` stamps an absolute deadline and checks it between
stages, and the CLI passes it through including the per-member-count default, so a local chain is
bounded like a registered one. The guarantee is weaker by one step and documented as such: the
driver declines to START a stage, where the engine terminates a running instance.

The per-member budget stays refused — it is a watch policy, and there is no watcher here.

---

## From [chain-plan-atom](./impl/chain-plan-atom.md)

### 2. No first-class `plan` member kind

`-t plan` has no entry in the closed `MEMBER_KINDS` literal, so it rides `--kind answer`
with both threading halves declared explicitly (`--capture plan=plan` /
`--input spec=plan.plan`), which fully replaces the kind's coded contract. It works; it is
just more ceremony than the other kinds need. A `plan` kind would carry the contract in
code like its siblings — added on BOTH sides (engine `MEMBER_KINDS` + CLI tables), per the
standing rule.

*Revisit when:* plan-then-implement chains become routine enough that the explicit
threading flags are noise (the spec-review pipeline would make this so).

---

## From [codex-chatgpt-auth](./impl/codex-chatgpt-auth.md)

### 3. Codex cannot consume h's SSE MCP servers

Codex's `--url` speaks **streamable-HTTP only**, so `mcpJsonToCodexToml` skips every `sse`
entry — meaning `dapr`, `obs`, and `workflows` are unreachable from a codex run. Codex has
full github-MCP parity (the PR layer works), so this only bites if codex ever needs to
orchestrate rather than code.

*Revisit when:* a codex run needs workflow/state/observability tools — or when h's MCP
servers gain a streamable-HTTP transport beside SSE, which would close it for free.

### 4. Codex container concurrency + k8s creds

Two open questions the Phase-2 container work deliberately left: (a) `auth.json` is
one-per-runner by OpenAI's own rule, so running host **and** container codex on one ChatGPT
plan long-term can rotate each other's refresh token — currently handled by convention, not
mechanism; (b) a k8s Secret is immutable, so a self-refreshing `auth.json` there needs a
seeded writable volume, unbuilt. Also unbuilt: the Enterprise `CODEX_ACCESS_TOKEN` path
(the gate already accepts it; nothing exercises it).

*Revisit when:* codex runs concurrently at fleet scale, or codex is deployed to k8s.

---

## From [agent-host-mode-bringup](./impl/agent-host-mode-bringup.md)

### 5. `make check-env-local` — the headless `.env` contract

Phase 3 documented the one-time provisioning step but deferred the machine check: a target
that fails loudly listing the `.env` keys a headless host-mode bring-up requires
(`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `GH_TOKEN`, …)
*before* launching, instead of each `run-*.sh` hard-failing one at a time.

*Revisit when:* a bring-up fails on a missing key often enough to be annoying — or fold it
into the hardening audit's `check-env-parity.mjs` idea, which overlaps.

---

## From [workflow-watcher-registry](./impl/workflow-watcher-registry.md) (the former `workflow-registry-followups.md`)

### 6. `--cron` vs `--schedule` — unify or coexist?

`h workflow publish --schedule "*/30…"` crons a *saved workflow by key* (fired by the
workflow-cron-tick over saved schedules). The `--cron` primitive is *target-scoped* (a
`cron:sub:<repo>:<slug>:<workflow>` row pointing at a `wf:` record + its goal). Two
mechanisms that both "run a workflow on a clock." Decide: generalize into one, or keep them
deliberately distinct (schedule = fire-a-template forever; cron = recur-until-goal).
Leaning coexist, but worth an explicit call before either grows more surface.

### 7. `--dynamic-cron` — an agent registers a cron mid-run

We chose the deterministic `arm-revise`/`arm-cron` *step* over an agent deciding, mid-run,
to register a cron. This remains open for the case where the follow-up work is *discovered
by the agent* and can't be a fixed step. Semantics unresolved (recurrence of THIS workflow,
or of discovered follow-up work, or both?), and it needs a `register-cron` MCP tool — a
surface expansion that must clear the executor's minimal-MCP review first.

### 8. Liveness-on-death for `wf:` rows

The build assumes clean self-reporting: a workflow writes its own `wf:running` then
`done`/`failed`. A run that **dies before writing a terminal status** leaves a non-terminal
row nothing else may write (single-writer). The fix is a READ concern: a reader (chain/cron
engine) should treat a non-terminal row whose Dapr instance is gone as `orphaned` (the
existing UNKNOWN-streak logic), with the watcher supervising the live instance as the
backstop. Not wired yet.

### 9. Cron source mode 3 — dynamic params

A cron deriving its params **fresh each tick** rather than re-firing fixed params (mode 1)
or a frozen definition (mode 2). Needs a param-source contract — where fresh values come
from (a reader plugin, prior `wf:` output, a GitHub query). Modes 1 and 2 shipped; the
discovery cron already covers the common "enumerate a source → fan out" shape without it.

### 10. Compose-to-disk — authoring a new template file

`h template compose … --save` persists the composed *definition to workflow-svc state*, not
a new `.tmpl.yaml` on disk. Authoring a genuinely new reusable **template file** alongside
the others (re-composable, git-trackable) is wanted but unspecced.

### 11. Optional worktree for a workflow, and the `review-pr` case — security-gated

A step should accept an optional `worktreePath`: reuse a prior chain member's, else create
one. Clean for h-authored branches. The sharp part is **`review-pr` gaining a worktree**:
reading the tree for context is one risk tier; *running commands* on a PR's code executes
untrusted third-party code in a secret-bearing agent. Three lines to choose between:
(1) read-only context, no execution; (2) full worktree + execution behind a
no-secrets/egress-restricted posture; (3) keep the reviewer read-only via MCP and hand
"needs to run" to a separate trusted validation workflow. Creation must be a conditional
*workflow step* (a `withWorktree` param), never an agent tool. `review-pr` capabilities
stay as-is until this is decided. See [reviewer-identity-security](./reviewer-identity-security.md).

### Resolved since the list was written

- **`h cron rm <id>`** — BUILT. `h cron rm REPO SLUG WORKFLOW` → `POST /cron/disarm`
  (single-writer, epoch-fenced, keeps the row for audit).
- **`loop-until-clean` chain strategy** — BUILT. The engine strategy shipped with the chain
  engine; `--strategy loop-until-clean --max-iterations N` is live and e2e-validated. Its
  one rough edge (loop × stages) was resolved CLI-side by
  [chain-engine-followups](./impl/chain-engine-followups.md) #79b: `startCursor` is the
  review member's STAGE, and stages inside the loop segment must be single-member, refused
  loud at registration.

---

## From [h-builds-h](./impl/h-builds-h.md)

The plan's phase-4 backlog, minus the items that its own supersession made moot (the
`issue-sweep` promotion died with the sweep; the runner-side terminate listener shipped —
`invoker.terminate` now reaches the subprocess through the run's scope finalizer).

### 16. Worktree GC — the disk-leak half

[chain-engine-followups](./impl/chain-engine-followups.md) #76 fixed the *collision* half by
making `addWorktree` reuse an existing worktree for a branch. The **leak** half is untouched:
a finalized chain never removes its worktrees, so `../h-workspace` grows without bound. Reuse
makes this benign, which is why it was deferred — a lifecycle sweep (prune worktrees whose
`feature/*` branch has a merged or closed PR) can follow.

*Revisit when:* disk pressure appears.

### 17. Template drift-check

A workflow that diffs `get_workflow(<key>)` against a fresh publish render and alerts when
they diverge — catching live-control-plane tampering, or simply a saved definition that has
fallen behind its template. Cheap, and it composes from existing pieces.

### 18. k8s cron leader guard

A hard prerequisite before the loop can ever run on Kubernetes: the cron binding double-fires
across replicas. Until this exists, the loop is deliberately local/compose only.

---

## From [panels-as-a-modifier](./impl/panels-as-a-modifier.md)

### 12. Panelist attribution and expression cosmetics

Two minor findings from the panel e2e that were never filed: posted PR reviews carry no
`[panel:<agent>]` prefix (design Q4 called for one; `panelize`'s preamble doesn't inject
posting-attribution prose), and two console/grammar papercuts — rich markup swallows a
`[label]`-shaped member label in a chain-run line, and `--strategy`/`--max-iterations` must
precede the `--` separator, which deserves a hint in the `ExprError` for known Typer flag
names.

### 13. Panel shape extensions

Deferred by design, not by accident: `--panel N` / same-agent perspective assignment (a
prompt-engineering slice), positional per-branch `--model` mirroring the roster, write-panel
sugar over `--parallel` stage composition, and per-branch worktree isolation if the advisory
read-only concurrency preamble proves insufficient.

---

## From [schedule-and-fallback](./impl/schedule-and-fallback.md)

### 14. Active usage-limit self-report (4b)

The passive classifier (`classify-stop`) ships and covers the common case. The active half —
a template declaring `status: {enum:[COMPLETE, STOPPED_EARLY, USAGE_LIMITED]}` plus a
`stoppedEarly(results)` reader in `generic.workflow.ts` mirroring `goalResolved` — was
deferred because it needs the structured signal surfaced to where the watcher reads (the
`run:` mirror or `wf:` row).

*Revisit as part of* [model-fallback-continuity](./model-fallback-continuity.md) Phase 2/3,
which owns the fallback story end to end and is the natural consumer of a durable signal.

---

## From [structured-workflow-outputs](./impl/structured-workflow-outputs.md)

### 15. Rung-3 extract — deferred with a tripwire

Zero rung-2 validation failures across every contracted live run, so no speculative extract
machinery was built (*build what's needed*). The tripwire is explicit: **the first
expensive re-run burned by a tail-of-output validation failure.** The shape to build when it
trips is pinned — a composition (a cheap-agent extract atom), never LLM credentials on
workflow-svc.

---

## From [local-ci-execution](./impl/local-ci-execution.md)

### 16. Branch protection requiring the `guards` check

With the self-hosted runner live (2026-07-29), the `guards` check reports again, so
requiring it on `main` is safe — the old "never add branch protection, the check never
reports" warning is inverted. An operator repo-settings action (plus deciding whether the
h-builds-h loop's merges go through PRs only). *Revisit when:* the next time a red-CI
commit lands on main, or when tightening the merge protocol in `docs/DRIVER.md`.

---

## From [live-state-containment](./impl/live-state-containment.md)

### 19. Rotate the exposed GitHub PAT

The PAT was readable by every agent process (including the dropped SUB_AGENT_UID) for an
unknown period via the pre-clone's tokened remote URL. The URL is scrubbed, the guard
(`scripts/check-git-credentials.mjs`) prevents recurrence, but the token itself was never
rotated — an operator action on github.com.

*Revisit when:* immediately, at the operator's next console session — this is the only
carried item that is a standing exposure rather than a parked improvement.

---

## From [cost-containment](./impl/cost-containment.md)

### 20. Kimi's daily budget number

Kimi is operator-denied; the budget machinery (`h agents budget kimi <usd>`) is built and
e2e-validated. The remaining decision is the NUMBER — whether $X/day of uncached Moonshot
(~$3+/review, no prompt caching honored) is worth the roster diversity, decided against
honest tallies now that B1/B3 landed.

*Revisit when:* the operator wants kimi back on rosters — re-allow + set the budget in two
commands, no build needed.

### 21. A2 — per-run maxCostUsd ceiling (premise refuted)

Deferred with evidence: no current strategy stream carries per-event COST (claude reports
cost only in the terminal result event; codex/openhands/pi never), and pricing tables are a
non-goal — so a mid-run ceiling has nothing to compare against. Per-run spend is bounded by
`maxDurationMs`; days by the A1 budget fence.

*Revisit when:* any strategy's stream gains per-event cost, or the no-pricing-table
non-goal is deliberately reversed.

### 22. Audit follow-ups: codex first-turn tokens; py agents never populate cost

Two gaps the Phase 1 audit filed but did not fix: codex's `extractMetrics` reads the FIRST
`turn.completed` event (multi-turn runs would drop later turns' usage — verify against a
captured multi-turn events.jsonl before fixing), and the Python agents' `record_run` mirrors
always carry `costUsd: null` (their runners never populate `cost_usd`), so every py run is a
permanent cost gap.

*Revisit when:* a codex or py-agent run's spend matters to a budget decision — today both
executors are low-volume.

---

## From [harness-batch-continuation](./impl/harness-batch-continuation.md)

### 23. Decide whether agent pushes run the pre-push hook

An agent silently set `core.hooksPath` on the SHARED agent clone (disarmed since). Real
arguments both ways: PR #98 broke oxfmt three times (a hook would have caught it), but a
blocked push mid-run is a failure mode agents handle badly. Decide explicitly and set it in
provisioning, not by accident.

*Revisit when:* the next formatting-broken agent PR, or the next provisioning-surface change.

### 24. `.env` AGENT_MODEL stopgap — revert or keep

`AGENT_MODEL=claude-sonnet-4-6` (raised from haiku) was a stopgap for panelize's silent
model downgrade; #99 fixed the defect properly (loud strip, `--model` works with rosters),
so the raise can probably revert — but that is a deliberate cost/quality call, not a
mechanical one.

*Revisit when:* the next cost review of default-model spend.

### 25. `x-w0` saved-workflow litter

A row published by the once-unmocked test (cause fixed via pytest-socket). Deleting it needs
an operator-allowed `state_delete` on `x-w0` + removing it from `__workflow_index__` — the
write was permission-blocked 2026-07-29 and again 2026-07-31. The 14 finalized chain rows
noted alongside it are NOT litter: finalized rows are by-design audit retention.

*Revisit when:* an operator session with state-write permission — two one-line calls.

### 26. system-c4-container layout polish

The container diagram (PR #104) compiles and is complete, but its render is the scruffiest
of the set: long crossing arrows and several relationship labels overlapping element boxes
(the C4 grid did NOT collapse — this is UpdateRelStyle-offset polish, not a structure
problem). Carried from docs/plans/impl/core-component-diagrams.md.

*Revisit when:* the next time the container diagram is updated for a topology change — fix
the offsets in the same change. (2026-08-06: still open. The two-substrate story was added as
its OWN diagram rather than by extending this one — a trial extension rendered as an unreadable
5000px column, which is evidence the diagram is already at capacity, not just scruffy.)

## From [direct-execution-runtime](./impl/direct-execution-runtime.md)

### 27. A stdio MCP server for the local substrate

A driver reaches the local substrate by shelling out (`h delegate`, `h workflow run --local`).
A stdio MCP server would give it typed tools instead. Deliberately unbuilt: Bash already works, so
building it now would be speculative machinery — the `delegate-locally` skill closes the ergonomic
gap that actually hurt.

*Revisit when:* a driver's Bash-shaped use of `h delegate` proves clumsy in practice — e.g. it
needs to stream partial results, or to fan out more than a shell one-liner can express.

### 29. Diff-aware diagram-staleness check

`scripts/check-diagrams.mjs` keeps the canonical set navigable and well-formed, but no machine can
tell that a hand-authored sequence/C4 diagram has gone WRONG — the one obligation that actually
gets missed (it was missed across the whole local-substrate build until the operator asked).
A stronger guard: each diagram declares the source paths it models, and a diff-aware check fails
when a change touches those paths without touching the diagram — the shape `check-plans` already
uses for citation rot. Not built because it needs an accurate `models:` attribution for all 16
existing diagrams, which is real work and easy to get subtly wrong.

*Revisit when:* a stale hand-authored diagram misleads someone — or when adding the next few
diagrams makes the attribution cheap to write from memory.

## From the first agent-built PR on the local substrate (#110)

### 30. `h worktrees sweep` is still untested against reality

`list` and `rm` have now been exercised on a real checkout (the worktree this very feature was
built in): `list` found it, `rm` refused it as dirty, `rm --force` removed it and deleted the
branch. `sweep` — the BATCH form, which classifies many entries and removes the safe ones — has
only ever run against monkeypatched git. Its per-entry classification and its
`removed N, skipped M` accounting are unverified against a filesystem.

*Revisit when:* two or more real worktrees accumulate — run `sweep --dry-run` against them
first, and compare its classification to `list` before letting it remove anything.

### 31. An unexplained spawn failure on the local substrate

A `revise-pr` member died in 8ms with `Command 'claude' not found` (agent-cli's parent-level
ENOENT path), then the identical member, cwd and command succeeded minutes later. Three probes
failed to reproduce it: the same `h delegate --cwd <that worktree>` in the foreground, a fresh
standalone `h workflow run revise-pr --local`, and a direct `spawnSync('claude')` in both cwds.
PATH was verified identical in foreground and background jobs, and `.env` sets no
`SUB_AGENT_UID`, so the privilege-drop path was not involved.

Note the diagnosis is genuinely ambiguous by construction: ENOENT on the EXECUTABLE and ENOENT
on the CWD are indistinguishable at that layer — a gap agent-cli's own comments already call the
"masquerades as a missing binary" problem.

**The disambiguation is BUILT (2026-08-12), so a recurrence is now diagnosable.** `AgentSpawnError`
carries the `cwd`, and the invoker stats it before blaming the binary: a broken working directory
reports itself by name at exit 1, and only a NotFound with a *healthy* cwd still reports exit-127
"command not found". Verified live through the local runner, not just in unit tests. Building it
surfaced a second, unrelated hole in the same path: Node raises ENOTDIR (a cwd that exists but is
not a directory) as a SYNCHRONOUS throw rather than the async `error` event it uses for ENOENT, so
it escaped the platform's `Effect.async` as a DEFECT and crashed the run instead of resolving as a
failed result like every other spawn failure — now caught at `Command.start` and typed.

The ROOT CAUSE of the original 8ms failure remains unknown, and this does not find it — it only
guarantees the next occurrence says which of the two things was missing.

*Revisit when:* it happens again — the error will now name the cause, so the next report either
points at the cwd (a worktree that vanished mid-run) or genuinely at PATH.

### 32. `loop-until-clean` has never completed a loop-back live

The strategy's live exercise so far: it fired the review stage, captured `FINDINGS`, advanced to
the revise stage, and failed the chain as a unit when that member died — all correct, and all
BEFORE the loop-back. The path that re-enters the review stage with `iterations + 1`, and the
`stopped after N iteration(s)` budget exit, are covered only by unit tests
(`packages/js/local-runtime/src/domain/chain.test.ts`).

*Revisit when:* the next real review→revise cycle — check that the SECOND review actually reads
the revised diff rather than a cached one, and that each iteration gets its own ledger group.
