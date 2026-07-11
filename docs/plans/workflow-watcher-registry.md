# Plan: standalone workflows, rich registry keys, watchers as cron-invokers

**Status:** design in progress — living doc, iterating. Captures the decisions from the
2026-07-11 design session. Not yet implemented.

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
- A cron's only job: **invoke a workflow on a clock.** It holds a pointer + a cadence, nothing else.
- **Two records per cron'd thing:**
  - **Workflow record (the brain):** `wf:<repo>:<slug>:<workflow>` →
    `{ status, workflow: <saved-key>, subject: {source, pr|issue, filter}, iteration }`.
    Self-sufficient — `h workflow run` it once, done.
  - **Cron record (the clock):** `cron:<repo>:<slug>:<name>` →
    `{ status: active, target: wf:<repo>:<slug>:<name>, cadence }`. Holds only enough to invoke.
- The cron is an OPTIONAL recurrence wrapper on a standalone workflow — cron-or-not is orthogonal to
  the work.
- **Cron scan:** for each `cron:*` with `status == active` → read its `target` `wf:` record → if not
  in-flight → run `wf.workflow` with `wf.subject`. The fired workflow's agent does the judging
  ("machines loop, agents judge").
- **The sweep collapses into a cron** (a `github-issues` source): discovery is a GitHub query, dedup
  is the `wf:*` keys, spec-composition dissolves (feature-pr reads the issue itself).

### 6. Lifecycle  *(agreed)*
- **Termination handshake (no cross-writing):** the *workflow* flips its OWN `wf:` row to `done`
  when the subject is resolved (e.g. PR clean); the *watcher engine* READS that row, sees `done`,
  flips `watcher:` to inactive. The workflow never writes `watcher:*`; the watcher only reads
  `wf:*`. Single-writer intact.
- **In-flight guard:** don't re-invoke while a run is live — epoch-fence / check the live Dapr
  instance status (the trick the existing watcher already uses).

### 7. Cron creation — CLI  *(to build)*
- **Standalone:** `h cron add …` — create a cron independent of running a workflow (first-class CLI
  feature). (`h watch …` stays for the supervise primitive.)
- **`--cron`:** on a workflow → statically register a cron (re-invokes it on the clock until `done`).
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
cron:cron:<repo>:<slug>:<name>   → { status, cadence, ref: wf:<repo>:<slug>:<name> }        # recur a workflow
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

## Proposed build order
1. **`revise.yaml`** standalone template — unblocks PR #30 *and* proves the standalone-workflow +
   durable-state model.
2. **Rich `wf:<repo>:<slug>:<workflow>` keys** — the per-workflow status rows + the read/write
   helpers; retrofit `feature-pr`/`pr-review`/`revise` to read/write them.
3. **Cron engine** — the dumb workflow-invoker scanning `cron:*` → invoking the target `wf:*`
   record's workflow (a third sibling beside the existing watcher + chain engines).
4. **CLI** — `h cron add`, plus the `--cron` / `--dynamic-cron` flags.
5. **Retire `issue-sweep`** — replace with a `github-issues` cron (atomic cutover).
