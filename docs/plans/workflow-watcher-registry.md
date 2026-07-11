# Plan: standalone workflows, rich registry keys, watchers as cron-invokers

**Status:** living doc — design + build in progress. Items 1–4 LANDED on main (the standalone
`revise`, chain integration, the rich `wf:<repo>:<slug>:<workflow>` registry, and the cron
primitive — see the Build order). Items 5–7 (inline template run, cron CLI, retire issue-sweep)
remain. Captures the decisions from the 2026-07-11 design session and their implementation.

## North star

Workflows are **self-sufficient units** that read their subject from **durable state** and are
**independently executable**. Chains *sequence* them; watchers *recur* them on a clock. State keys
**encode the writer** so single-writer is structural, not conventional. This makes the system
portable across repos/targets and collapses the bespoke "sweep" into the generic watcher primitive.

## Why (what we found)

- **`revise` is not a real workflow** — it's a chain-only re-fire of `feature-pr`, with the review
  context threaded by the chain engine. It can't be run standalone.
- **The sweep's REVISE is registry-scoped, not PR-board-aware** → it re-implemented an issue (#24)
  that already had a manually-created PR (#30) → **duplicate dispatch** (the bug we hit
  2026-07-11).
- **The registry is plain last-write-wins state** (no concurrency control), so "single-writer per
  prefix" is a convention compensating for the store having no turn-based serialization.

## Decisions

### 1. CLI vocabulary — content values vs machinery  *(landed)*
- Template CONTENT values → `-p key=value`. The param space is unbounded, so one uniform syntax;
  `@path` splices a file.
- Machinery → the closed flag set: `--agent` (executor), `--model`, `--fresh`, `--instance-id`,
  `--via` (routing); chain composition `-w` / `-t` / `--parallel` / `--kind` / `--strategy`.
- `-t` populates **structure** (which template atoms); `-p` populates **values**. Siblings.
- `--agent` = the executor, uniformly across `feature`/`workflow`/`chain`. `--via` = routing.
- The `-p` parser is shared (`cli/h/src/h_cli/params.py`) so `workflow` and `chain` can't drift.
- chain `-p` is chain-level (seeds the shared `data` blackboard, threaded to every member);
  per-member `-p` is a fast-follow. `--slug` stays a flag (chain identity/branch/instanceId).

### 2. Standalone workflows  *(to build)*
- Each workflow is independently executable; chains are composition of standalone workflows.
- **Durable state is the interface between workflows** — the PR, the registry, GitHub — NOT the
  chain engine's in-memory blackboard. `pr-review` already honors this (`-p pr=N` → it reads the
  PR). `feature-pr` and `revise` must too.
- **`revise` becomes a first-class template** (`revise.yaml`): `h workflow run revise -p pr=N`
  reads PR #N's head branch + its review comments from GitHub, worktrees the branch, addresses the
  comments, verifies, pushes. In a chain, the engine threads only the **PR number**.

### 3. Rich registry keys — single-writer by construction  *(to build)*
- Key encodes the writer: **`wf:<repo>:<slug>:<workflow>`** — the workflow name is the leaf, and
  each workflow is the SOLE writer of its own key.
- `<repo>` + `<slug>` (the artifact through-line: issue → `feature/<slug>` branch → PR) make
  workflows portable across repos and targets.
- Single-writer becomes a property of the key structure (no shared key ⇒ no lost-update race).
- **Enumeration = GitHub, not a shared index.** The `wf:*` rows are per-workflow status caches read
  by exact key; "what exists?" comes from listing open issues/PRs. No shared index to race on.
- issue → slug: deterministic slug derivation (or a one-time `wf:<repo>:issue:<n> → slug` lookup).

```
wf:stiproot/h:pi-agent:feature-pr → { status: done,      instanceId: feature-pi-agent, pr: 30, branch: feature/pi-agent }
wf:stiproot/h:pi-agent:pr-review  → { status: done,      instanceId: pr-review-30,     pr: 30, outcome: findings }
wf:stiproot/h:pi-agent:revise     → { status: in-flight, instanceId: revise-pi-agent,  pr: 30, iteration: 1 }
```

**Who writes the row, and how (locked).** The workflow writes its OWN row — via a bookending
**state-write activity**, not the agent. A Dapr workflow can't do I/O directly (it `callActivity`s),
so `generic.workflow` brackets its steps:
```
callActivity(write-wf-row, { status: running, subject })   # at start
  … the workflow's real steps …
callActivity(write-wf-row, { status: done, output })       # at end
```
The `write-wf-row` activity runs on **workflow-svc** (which holds the Dapr state API), so an
executor's MCP surface is irrelevant — **claude-coder's github-only MCP never touches state**. It is
genuinely the workflow writing its own row (its own steps do it), single-writer, and a crash leaves a
stale `running` row that the reader marks `orphaned` (§Deferred). Bracketing is **opt-in**: only when
the workflow input carries the wf-identity, so non-registry workflows are unchanged.
- **Key parts:** `slug` (existing param), `workflow` (the saved key, passed in), `repo` (a NEW param,
  default = the target repo from values).
- **Value:** `{ status, instanceId, subject: params, output, updatedAt }`.
- **Readers** (chain/cron engines) read these rows by exact key.

### 4. Registry backing — facts *(reference)*
- The registry is **plain Dapr state** (`state_get`/`state_save`) in the `statestore` Redis
  component (`keyPrefix: none` → flat keys). It is **not** actor state.
- That same component is ALSO the **actor state store** (`actorStateStore: "true"`) because Dapr
  Workflows ride the actor runtime. One physical Redis; the registry and the actor/workflow runtime
  state live in different keyspaces via different access paths (state API vs actor API).
- Plain state = last-write-wins, no serialization → the reason single-writer matters.

### 5. Cron = dumb workflow-invokers — a third sibling of the build-pattern  *(to build)*
**Terminology (locked):** `watcher` KEEPS its existing meaning — it *supervises* a running workflow
instance and acts on rules (terminate/retry/escalate). The recurrence idea is a NEW, distinct
primitive: **cron**. Flag `--cron`; key prefix `cron:`.

- Watcher, Chain, and Cron are the **same build-pattern** — a policy row in a registry, evaluated by
  a pure `decide` on the cron-tick clock, acting through a closed vocabulary — differing only in the
  action: **watcher supervises** one instance, **chain sequences** (fires the next), **cron recurs**
  (re-invokes a workflow until done).
- A cron's only job: **invoke a workflow on a clock.** workflow-svc is the **sole cron engine and the
  sole writer of `cron:*`** (locked). The CLI passes `--cron <cadence>` as a field on the run request;
  workflow-svc persists the `cron:*` row in the same handler that invokes — symmetric with how
  `--watch` registers `watch:*`. The CLI never writes `cron:*` directly.
- **What a cron re-fires — three source modes (all resolved workflow-svc-side, on the tick):**
  1. **Saved key + fixed params** — the `cron:*` row holds `{ workflow: <saved-key>, params }`; each
     tick re-fires the *published* definition with those fixed params. Many crons can share ONE saved
     definition, each with different params — no duplication. (This is the `wf.workflow`/`wf.subject`
     shape below.)
  2. **Embedded hydrated definition** — the `cron:*` row holds the fully-hydrated definition (steps +
     params); each tick invokes it **as-is — no re-hydration, no publish required**. This is what lets
     an inline `h workflow run <template> -p … --cron "…"` recur with nothing saved separately:
     creating the cron is itself what persists the built definition (inside workflow-svc).
  3. **Dynamic params** *(deferred — see Deferred)* — the `cron:*` row references a definition plus a
     **rule** for deriving params fresh each tick (params change tick-to-tick). Powerful, but needs a
     param-source contract; addressed when the use-case arises.
- **Two records per cron'd thing:**
  - **Workflow record (the brain):** `wf:<repo>:<slug>:<workflow>` →
    `{ status, workflow: <saved-key>, subject: {source, pr|issue, filter}, iteration }`.
    Self-sufficient — `h workflow run` it once, done.
  - **Cron record (the clock):** `cron:<repo>:<slug>:<name>` → `{ status, cadence }` + one of the
    three source modes above. Holds only enough to re-invoke.
- The cron is an OPTIONAL recurrence wrapper on a standalone workflow — cron-or-not is orthogonal to
  the work.
- **Cron scan:** for each `cron:*` with `status == active` → if its subject is not in-flight →
  re-invoke per its source mode (saved-key+params / embedded definition / dynamic rule). The fired
  workflow's agent does the judging ("machines loop, agents judge").
- **The sweep collapses into a cron** (a `github-issues` source): discovery is a GitHub query, dedup
  is the `wf:*` keys, spec-composition dissolves (feature-pr reads the issue itself).

### 6. Lifecycle  *(agreed; termination = decision (b), locked 2026-07-11)*
- **Goal handshake (no cross-writing) — decision (b):** run-status and goal-status are DISTINCT. The
  `wf:` row's `status` (running/done/failed, 3b) means "the run's steps finished"; a separate
  **`resolved: bool`** means "the SUBJECT is resolved" (e.g. the PR **merged** — a real state check
  the workflow performs, not merely "a run succeeded"). The workflow reports `resolved` via a
  `===GOAL===RESOLVED` output marker that `write-wf-row` records; the cron/watcher engine READS
  `wf:*` and deactivates on `resolved`. The workflow never writes `cron:*`/`watcher:*`; the engine
  only reads `wf:*`. Single-writer intact. *(This replaces the earlier "flip wf: to done" sketch,
  which conflated run-status with goal-status — `done` means the run finished, not the goal met.)*
- **Cadence + budget:** a cron fires on its `cadence` when due, and carries a `budget.maxFires` cap.
  It deactivates on `resolved` **OR** when the budget is exhausted — so a goal that never resolves
  (a PR never merged) still stops, bounded.
- **In-flight guard:** don't re-invoke while a run is live — check the live Dapr instance status
  (epoch-fenced), the trick the existing watcher already uses.

### 7. Cron creation — CLI  *(to build)*
- **Standalone:** `h cron add …` — create a cron independent of running a workflow (first-class CLI
  feature). (`h watch …` stays for the supervise primitive.)
- **`--cron`:** on a workflow → statically register a cron (re-invokes it on the clock until `done`).
  workflow-svc persists the `cron:*` row in the same fire handler (single writer); the source mode
  (§5) is chosen by how the run was issued — a saved-key run → mode 1 (key + the fire-time params);
  an inline template run → mode 2 (the built definition is embedded in the cron, no publish needed).
- **`--dynamic-cron`:** the executing agent decides (mid-run) whether to register a cron — e.g.
  `pr-review`, on finding comments, registers the resolve-comments workflow + its cron itself
  (a self-propagating loop, no sweep needed).

### 8. How a chain moves + the unified `cron:*` registry — no actor  *(design)*
**How a chain moves today (`chain-engine.ts`/`chain-workflows.ts`):** a `chain:sub:<chainId>` row
holds `{ workflows[], cursor, currentInstanceId, data, status, epoch }`. On each cron tick,
`chain-scan` reads the current member's status → pure `decide` returns `wait|advance|finalize|
budget-terminate`. On `advance` it `capture(output, data)`s the finished workflow's `===MARKER===`
output into the blackboard, bumps cursor+epoch, `buildParams(data)`s the next workflow, and **fires
it**. The threading reads the workflow's *output markers, not an actor* — deliberately, so workflows
stay chain-agnostic (params in, markers out) and standalone. **workflow-svc is what invokes the next
workflow.**

**Unify the tick into one registry.** `watch-scan` and `chain-scan` are near-identical siblings;
plus the new recur-cron, that's three loops. Collapse to **one** `cron:*` registry, dispatched by
the middle segment:
```
cron:cron:<repo>:<slug>:<name>   → { status, cadence, <source> }                             # recur a workflow — <source> is one of the three §5 modes (saved-key+params | embedded definition | dynamic rule)
cron:chain:<repo>:<slug>         → { status, cadence, workflows: [wf-key, …], cursor, data } # sequence
cron:watch:<repo>:<slug>:<wf>    → { status, cadence, ref: <instanceId>, policy }            # supervise
```
Each `cron:*` is a **thin tick-registration pointing at the state it attends to**; workflow-svc
dispatches by type into the existing decide-logic (`chain-engine.decide`, `watch-engine.decide`, a
new `cron-decide`), reads the referenced records, and acts. Termination is uniform: the loop reads
the referenced records' state → `done` → deactivate.

**No actor anywhere.** Unique per-workflow keys mean nothing shares a mutable key:
- each `wf:<repo>:<slug>:<workflow>` has ONE writer (single-writer by construction);
- the chain record has ONE writer (the engine on the tick; epoch-fenced against overlapping ticks);
- so **plain state suffices** — the earlier "chain actor for concurrency" is unnecessary.
- The chain record's `workflows` array holds **`wf:` keys, not full workflow state**. The engine
  reads those `wf:` records to consolidate (e.g. after a parallel A‖B group, read `wf:A`+`wf:B`, thread
  what it needs, fire C). The **mapping logic** (which marker → which param) stays **engine code**;
  only the **accumulated state** is persisted — as plain single-writer state, not an actor.

## What this replaces / simplifies
- The bespoke `issue-sweep` agent workflow → a `watcher` record with a `github-issues` source.
- The chain's `loop-until-clean` strategy → a per-PR watcher firing `revise` until clean (looping
  outlives any single chain run).
- The duplicate-dispatch bug → fixed by durable-state truth + rich keys (a workflow checks `wf:*`
  before acting).

## Open questions
1. ~~`--watch` collision~~ **RESOLVED.** `watcher`/`--watch` KEEPS its meaning (supervise a running
   instance). The recurrence primitive is renamed **cron** (`--cron`, `cron:` key prefix) — a
   distinct third sibling of the build-pattern.
2. **`--cron` vs the existing `--schedule`.** `h workflow publish --schedule "*/30…"` already crons a
   *saved workflow by key* (fired by the workflow-cron-tick). The new `--cron` is *target-scoped*
   (points at a `wf:<repo>:<slug>` record and its subject). Do these generalize into one mechanism
   (a `cron:` row that targets either a saved key or a `wf:` record), or coexist?
3. **Source-reader plugin boundary + a GitHub read budget** — a busy tick must not hammer the API
   (the `workflow-instance` reader is a cheap local read; `github-*` readers are rate-limited).
4. **`--dynamic-cron` exact semantics** — agent registers a cron for this workflow's recurrence, for
   follow-up work it discovers, or both?
5. **Loop home** — keep `loop-until-clean` in the chain engine, or move looping to a standing cron
   entirely?
6. **`revise` registry write vs event** — when a standalone `revise` runs on an untracked PR, does
   it write its own `wf:` row directly (single-writer of that key — fine), and is that the whole of
   "add the PR to the registry"?
7. ~~Who writes a `wf:` row's `status`/`output`?~~ **RESOLVED.** The **workflow itself** writes its
   own row (`status` + `output`) — sole writer of the row it names, keeping it self-sufficient.
   Edge: a run that dies before writing `done` leaves a non-terminal row; since nothing else may
   write it, liveness-on-death is a **read** concern — the reader (chain/cron engine) treats a
   non-terminal row whose Dapr instance is gone as `orphaned` (existing UNKNOWN-streak logic), and
   the **watcher** primitive supervises the live instance. Never a second writer.

## Deferred (follow-up PRs)
- **Liveness-on-death for `wf:` rows.** The initial build assumes clean self-reporting (a workflow
  writes its own `done`). Handling a run that **dies before writing `done`** — the reader detecting a
  non-terminal row whose Dapr instance is gone and marking it `orphaned`, and the watcher backstop —
  is a **follow-up PR**, not part of the first cut.
- **Cron source mode 3 — dynamic params.** A cron that derives its params fresh each tick (params
  change tick-to-tick) rather than re-firing fixed params (mode 1) or a frozen definition (mode 2).
  Needs a **param-source contract** (how/where the fresh values come from — a reader plugin, prior
  `wf:` output, a GitHub query). Powerful; build when a concrete use-case lands. Modes 1 & 2 ship first.
- **Compose-to-disk — authoring a new template file.** Today `h template compose … --save` persists
  the composed *definition to workflow-svc state*, not a new `.yaml` on disk. Authoring a genuinely
  new reusable **template file** alongside the others (re-composable, `git`-trackable) is a wanted
  feature — **plan stub**, to spec and build later.
- **Optional worktree for a workflow (use-if-provided / create-if-absent) + the `pr-review` case.**
  A step should accept an optional `worktreePath`: reuse it when a prior chain member cut one, else
  create one. Clean for h-authored branches. The sharp part is **`pr-review` gaining a worktree**:
  reading the tree for fuller context is one risk tier; *running commands* on a PR's code executes
  untrusted third-party code in a secret-bearing agent — the exact blast radius the reviewer's
  minimal-surface invariant denies (reviewer-identity-security.md). Three lines to choose between:
  (1) read-only context, no execution; (2) full worktree + execution behind a no-secrets/egress-
  restricted runtime posture; (3) keep the reviewer read-only via MCP and hand off "needs to run"
  to a separate trusted validation workflow. Also: creation should be a conditional *workflow step*
  (a `withWorktree` param), never an agent tool — arming the reviewer with worktree/workflow tools
  would itself expand the minimal surface. **Plan stub** — decide the line, then build; `pr-review`
  capabilities stay AS-IS until then.

## Build order
1. ✅ **`revise.yaml`** standalone template — `revise` reads its subject from GitHub; unblocks PR #30.
   *(landed `1c71633`)*
2. ✅ **Chain integration** — `-w revise` fires the standalone `revise` (threading only durable refs:
   PR number + slug), not a feature-pr re-fire. *(landed `9e6d27f`)*
3. **Rich `wf:<repo>:<slug>:<workflow>` keys** — the per-workflow status registry. Split:
   - ✅ **3a — foundation**: `wf.model.ts` (WfRow / WfIdentity / wfKey), `IWfStore` + `dapr-wf-store`
     (exact-key get/save, no index). *(landed `9430f6c`)*
   - ✅ **3b — the write path**: the `write-wf-row` activity + `generic.workflow` bracketing (opt-in
     on the `wf` field on `WorkflowRequest`, running→done/failed around the steps), `WfStore` wired
     into the activity runtime. *(landed `3b497df`)*
   - **3c — wiring + retrofit** *(next)*. Two sub-steps:
     - **Variable rename (prereq, landing with 3c-i).** `sourceRepo` was ambiguous — it is a **local
       filesystem path** (the pre-clone the worktree is cut from), NOT a GitHub owner/name. Renamed to
       **`clonePath`** end-to-end (the `/worktree` wire field, `create-worktree` activity, the three
       worktree templates + their values, the CLI warning, tests). Three unambiguous names now:
       `repo` = `owner/name` (identity), `clonePath` = the source dir, `worktreePath` = the run tree.
     - ✅ **3c-i — repo as a fire-time identity param.** `repo` (owner/name) becomes a `-p repo=` content
       value. It is **identity-only for `feature`/`revise`** (a label for the wf-key; it does NOT touch
       `clonePath` or the worktree — the two are orthogonal). For **`pr-review`** it also feeds the
       review prose + MCP target, replacing the `required "prReview.repo"` with a `{{params.repo}}`
       param (publish-default from `prReview.repo`) — which makes pr-review genuinely repo-portable
       (no worktree to provision). `pr-review` also gains an identity-only `slug` param (the truer
       name `branch` is a deferred rename). Re-bless the syrupy chart goldens. *(NB: true clone-
       portability for `feature`/`revise` — worktree any repo — is a separate provisioning concern:
       the pre-clone / `clonePath`, out of 3c scope.)*
     - ✅ **3c-ii — wf-identity assembly (workflow-svc owns key construction).** A domain helper
       `wfIdentityFrom(params, workflowName)` builds `{repo, slug, workflow}`; the two fire paths
       (run-route by saved key, chain-scan by `kind` with slug = the chain slug) call it and set
       `request.wf`; chain `buildParams` threads `repo` into every member. Row-writing stays
       **opt-in** — no `repo`+`slug` ⇒ no row (standalone must pass `-p repo= -p slug=`; a chain seeds
       chain-level `-p repo=`). `feature-pr`/`pr-review`/`revise` now write rows. `generic.workflow`
       unchanged (consumes `input.wf` from 3b). No CLI change — `repo` rides the existing `-p`.
     - Inline template run (`h workflow run <template> -p …`, render+fire, no publish) is a **separate
       CLI item** (compose-on-fire, sibling to chain `-t`), not part of 3c.
4. **Cron engine** — the dumb workflow-invoker (third sibling beside watcher + chain), `cron:sub:<repo>
   :<slug>:<workflow>` keys, sole writer workflow-svc. Termination = decision (b): reads the target
   `wf:` row's `resolved` flag + a `budget.maxFires` cap + the live in-flight guard. Modes 1 (saved
   key+params) & 2 (embedded definition) ship; mode 3 (dynamic) deferred. Split:
   - ✅ **4a — foundation**: `cron.model.ts` (CronRow/CronSource/CronBudget/cronId + config/heartbeat/
     ledger), `ICronStore` + `dapr-cron-store` (sibling of the chain store), `CronStoreLive` in the app
     layer, and the `resolved` field added to `WfRow`. *(landed)*
   - ✅ **4b — the engine**: pure `cron-engine.ts` `decide(row, resolved, runtimeStatus, now)` →
     `wait | fire | deactivate(resolved|budget-exhausted)`; precedence resolved → budget → in-flight →
     cadence (isDue). *(landed)*
   - ✅ **4c — scan engine + tick**: `cron-scan.ts` (`registerCronForFire` + `scanCronsEffect` +
     epoch-fenced fire/deactivate), wired into the `workflow-cron-tick` beside the watch/chain scans
     (its failure never fails the tick). Fire builds the request from the source (saved key | embedded
     steps), stamps the wf-identity + fixed instance + fresh, mark-before-fire so a broken source
     self-limits against the budget. *(landed)*
   - ✅ **4d — entry points**: the `cron` field on `/workflow/run/:key` (a `CronPolicy` {cadence,
     budget}) registers via `registerCronForFire` in the same handler (sibling of `watch`; 400s
     without a wf-identity, mode 1 saved source, the initial run counted); and the `===GOAL===` →
     `write-wf-row.resolved` producer in `generic.workflow` (+ `revise` emitting `===GOAL===RESOLVED`
     on PR-merged) so the resolved handshake is live. *(landed)*
   - *(Follow-up: the `cron` field on the inline `/workflow/run` path pairs with item 5's embedded
     source; `h cron add` + `--cron`/`--dynamic-cron` CLI is item 6.)*
5. ✅ **Inline template run (CLI)** — `h workflow run <template> --inline -p …` renders the template
   (publish-mode) and posts its steps + merged params to `/workflow/run` (new `run_steps` client) —
   no saved key, no publish, leaving only the `wf:` status row. `-p`/`--agent`/`--model` override the
   rendered value-defaults; `--via` is rejected (direct-to-svc). Compose-on-fire, sibling to chain
   `-t`. *(landed)*
6. **Cron CLI** — `h cron add`, plus the `--cron` / `--dynamic-cron` flags (workflow-svc persists the
   `cron:*` row on the fire path; the source mode follows how the run was issued — saved key vs inline).
7. **Retire `issue-sweep`** — replace with a `github-issues` cron (atomic cutover).
