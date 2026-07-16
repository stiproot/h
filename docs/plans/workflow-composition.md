**Status:** EXPLORATORY (2026-07-07) — design locked, not yet implemented. This plan tightens h's
workflow architecture by dissolving the "family" concept into a clean primitive stack (template →
workflow → chain) and adding two composition operators. It supersedes the flag-driven,
template-conditional style (`feature --pr`) with explicit composition.
**Living doc** — update Decisions as they resolve and append to the Progress log as phases land.

# Workflow composition: templates, overlays, and chains

## Framing

Today a "family" (a helm-templated workflow like `feature`) carries two things that don't belong to
it: **flags that mutate step *prose*** (`feature --pr` flips a template conditional that rewrites what
the final step's agent is told to do), and **no way to compose** — so conceptually separate operations
(implement, create-pr, review, revise) got fused into one template selected by flags. The goal here is
to make composition *explicit and first-class*, so the pieces stay independent and plug-and-play, yet
can be strung into "a feature all the way to a reviewed PR".

The insight that drives the whole design: **"family" was never a primitive — it was just a
parameterized workflow.** Once we (a) stop mutating step prose with flags and (b) add real composition
operators, "family" dissolves into "template", and the architecture tightens.

---

## 1. Vocabulary (adopt into core docs)

These terms replace "family" and must land in [CLAUDE.md](../../CLAUDE.md),
[README.md](../../README.md), and [WORKFLOWS.md](../../WORKFLOWS.md) as part of this work.

- **Template** — the authored, parameterized, composable unit (what a "family" pretended to be). A
  blueprint. A helm chart is *one way to author a template*; it is not the template itself.
- **Workflow definition** — a template (or an *overlay* of templates) rendered and bound to params:
  the concrete `{instanceId, steps}` body handed to the engine. The artifact at the wire boundary.
- **Workflow** — a workflow definition *executed*: a durable run with an instanceId, run-ledger
  records, spans, and a `watch:` row. The runtime instance.
- **Overlay** — *spatial* composition: merge N templates into **one** workflow definition (compose-file
  semantics, `docker compose -f a -f b`). Shares context within a single run.
- **Chain** — *temporal* composition: run N workflows in sequence/parallel under a **strategy**. Shares
  context across runs via the chain actor.
- **Chain actor** — a Dapr actor, keyed by the chain's `slug`, holding the shared-context blackboard
  (`data`) that chained workflows read and write.
- **Strategy** — how a chain executes its members: `sequential`, `parallel`, `loop-until-clean`.

The stack: **templates —(overlay)→ workflow definition —(execute)→ workflow —(chain)→ chain.**
"Family" retires.

---

## 2. The two composition axes

The two operators are not redundant — they map onto a real technical boundary: **where the agent's
context breaks.**

- **Overlay** composes units that run in the **same context** — the same worktree, one continuous
  agent run. `implement ⊕ create-pr ⊕ verify`: the agent commits what it just wrote; no context
  re-establishment. One workflow, one instanceId.
- **Chain** composes units across a **context handoff** — a *different* agent, reading fresh.
  `review` runs as `claude-coder` reading the PR; `revise` is a separate run addressing comments.
  Separate workflows, separate instanceIds.

The canonical "feature → reviewed PR" decomposition:

```
[ implement ⊕ create-pr ⊕ verify ]  →  [ review ]  →  [ revise ]
        one workflow (overlay)          chain           chain
```

Overlay is chosen partly for **performance** (avoid N context re-reads), not only aesthetics — this is
why `implement`+`create-pr` must overlay, not chain.

---

## 3. Shared state: the chain actor (generic by design)

> **SUPERSEDED (Phase 4, 2026-07-08).** This section is the original pre-implementation design. It was
> reversed: there is **no chain actor**. The shared context is the `chain:sub:<id>` row's `data`
> field, written only by the engine, which threads state by parsing each hop's OUTPUT (see Decision 4
> and the Phase-4 progress entries). The `{slug, data}` shape and generic-blackboard reasoning below
> still hold — they just live on the row, not in an actor. Kept for the record.

Cross-workflow sharing is the load-bearing problem. Decision: a **Dapr actor keyed by the chain
`slug`** is the shared-context object. Params carry only the *handle* (the slug → the actor address);
the actor carries the *state*. Precedent: `issue-sweep` already keys shared findings by a stable id.

The schema is deliberately **generic and dynamic** — a free-form blackboard, not a fixed struct:

```ts
// The chain actor's state, addressed by actorId = `chain-${slug}`.
interface ChainState {
  slug: string;                    // stable chain id + git-branch token
  data: Record<string, unknown>;   // the shared blackboard; templates key out what they need
}
```

`data` maps directly onto the actor's key/value state: a template writes `actor_state_set(actorId=
chain-${slug}, key=<k>, value=<v>)` and reads `actor_state_get(...)`. Each template **keys out of
`data` exactly what it expects** and writes back what it produces. Conventional keys (not enforced):
`worktreePath`, `branch`, `spec`, `plan`, `prNumber`, `prUrl`, `reviewFindings`, `sha`.

**Tradeoff (accepted deliberately):** a dynamic `Record` means the port contract — which keys a
template consumes/produces — is **convention + documentation, not a compile-checked schema.** We buy
maximum flexibility (any template composes with any other; no schema migration to add a key) at the
cost of static guarantees. Each template's header MUST document its `data` inputs/outputs so the
contract stays legible. A missing expected key is a runtime concern the template handles (fail loud,
never silent).

### Two sharing mechanisms, one per axis

| Composition | Shares state via | Scope |
|---|---|---|
| **Overlay** (templates → one workflow) | `{{step.output}}` / `$ref` (existing engine) | within one workflow |
| **Chain** (workflows → sequence) | **the chain actor's `data`** | across workflows |

The actor's `data` *is* the chain's port surface. In a **parallel** strategy it is also the
aggregation point: each fan-out member appends to `data` (actor turn-based writes serialize, so no
race), and the join reads the merged result.

---

## 4. Composition is two flag axes over one `-t` list

Templates are named with a repeated `-t` flag (compose's `-f` ergonomic). Two independent selectors
act over the same list, and **chain-level flags apply to every member** (`--watch`, `--agent`,
`--slug`, `--model`), with per-member override left for later:

- **Composition mode** — overlay (merge → one workflow) vs chain (sequence).
- **Chain strategy** — `sequential` | `parallel` | `loop-until-clean`.

```sh
# Overlay: merge templates into one workflow (replaces `feature --pr`)
h workflow run -t implement -t create-pr -t verify --slug dark-mode --agent openhands

# Chain: sequence workflows to a reviewed PR
h chain run -t feature -t pr-review -t revise \
    --strategy loop-until-clean --slug dark-mode --agent openhands --watch
```

`--pr` is gone: opening a PR is `-t create-pr`, not a flag that rewrites prose.

### The overlay-inside-a-chain-hop corner

If `--chain` made *every* `-t` a separate workflow, `implement` and `create-pr` would split into
separate runs — re-introducing the context re-establishment overlay exists to avoid. Resolution for
v1: **overlay is authoring-time, chain is invocation-time.** Pre-compose `implement ⊕ create-pr ⊕
verify` into a named template, then chain flat single-template hops. This mirrors compose exactly (`-f`
merges *before* `up`; you don't nest merges inside a sequence). Inline overlay-in-a-hop is a possible
v2 nicety, deferred until needed.

---

## 5. Who runs the chain: chain-as-policy (mirrors watch)

A chain must not be "an agent looping `await_workflow`" — the watcher-primitive ruling
([watcher-primitive.md](./watcher-primitive.md)) says machines run durable loops, agents are for
judgment. The destination is therefore the **same shape as watch**:

> A chain is a registered policy `{workflows: […], strategy, slug}` in a `chain:` registry, evaluated
> by an engine on the `workflow-events` clock, that fires the next workflow(s) per strategy when the
> previous reach terminal — acting through a closed vocabulary (fire-next, fan-out, join, finalize).

This resolves the "who supervises the chain?" tension: workflows still never supervise (the doc's
invariant holds); the **chain engine** does the sequencing, exactly as the **watch engine** does
budgets. A chain is to sequencing what a watcher is to supervision — one more registry beside
`watch:` (`chain:`), one more engine on the same tick.

**Staging note:** an interactive CLI chain (blocks + polls, non-durable) is the cheap way to feel the
ergonomics first; the durable policy engine is the destination that makes a chain a first-class
primitive rather than a script. See Phase 1 vs Phase 4.

---

## 6. Strategies (the concurrency experiments)

`strategy` is a field on the chain policy:

- **sequential** — fire next on terminal. The event-driven baseline.
- **parallel** — fan out N members on the shared context at once (e.g. `review-security` ∥
  `review-perf` ∥ `review-correctness`), each appending to the chain actor's `data`, then a **join**
  barrier before the next hop.
- **loop-until-clean** — `review → revise → review …` until a **predicate** holds (the reviewer emits
  `===REVIEW=== CLEAN`) or a **budget** trips (max iterations). The budget is the watch engine's
  concern — another place chain and watch rhyme. Without the budget an implementer/reviewer
  disagreement could spin forever.

---

## 7. Phased rollout

Each phase is independently shippable; the riskiest concept (the actor contract) is proven first for
almost nothing.

**Phase 1 — Chain the workflows we already have (cheap probe).** No template surgery. Chain the
existing `feature` → `pr-review` → `revise` via a `-t` CLI command, a chain actor keyed by `slug`,
and `--strategy sequential`. Proves the two things that can kill the design — the **actor-as-shared-
context contract** and **cross-workflow output handoff** — before touching a single prompt. Runs on
the CLI (blocks/polls). Exit criterion: a feature taken to a reviewed PR by one command, state flowing
through the chain actor.

**Phase 2 — Harden the template primitive; kill `--pr`.** Decompose `feature` into overlayable atoms
(`implement`, `create-pr`, `verify`); implement the **overlay** operator (merge templates → one
workflow definition; `{{step.output}}` handoff preserved). `feature --pr` becomes `-t implement -t
create-pr`. "Family" is fully retired here. Re-bless chart goldens.

**Phase 3 — Adopt the vocabulary in docs AND code; retire "family" as a word.** "Template" replaces
"family" everywhere — this phase makes the new language real, not just aspirational. (Can land
alongside Phase 2.) Two fronts:

- **Docs** — CLAUDE.md, README.md, WORKFLOWS.md, and cli/README.md adopt
  template/workflow-definition/workflow/overlay/chain/chain-actor/strategy, and every remaining
  prose use of "family" becomes "template" (or "parameterized template" where the params sense
  matters). The h primitives list in CLAUDE.md gains "template" alongside
  workflow/watcher/trigger/registry.
- **Code identifiers** — the `family` token is load-bearing in the chart layer: the `--set
  family=<name>` gate, the `{{- if eq .Values.family "<name>" }}` wrapper in every template,
  `render_workflow(family=…)` / `helm.py`, `values.yaml`/`values.schema.json` comments, and CLI
  help/arg names (`h workflow publish <family>`). Rename these to `template`. This is mechanical but
  wide (it re-blesses every chart golden and touches the gate in all templates), so stage it as its
  own commit with the goldens re-blessed deliberately — do NOT fold it into an unrelated change. The
  `-t` compose/chain flag is already spelled "template"; this aligns the rest.

Intent captured so the rename isn't lost: until it lands, new code should prefer "template" in prose
and comments even while the `family` gate identifier persists, so the drift shrinks rather than grows.

**Phase 4 — Chain-as-policy engine.** Lift sequencing off the CLI into a durable `chain:` registry +
engine that mirrors the watch engine **exactly**. Design (grounded in a read of the watcher impl):

- **Clock = the cron tick, NOT `workflow-events`.** Nothing in the repo subscribes to `workflow-events`
  today; the watch engine advances entirely on the `workflow-cron-tick` scan, reading each row's
  already-persisted status via `invoker.getStatus`. So `scanChainsEffect(traceparent)` rides the same
  `tickEffect` (`cron.router.ts`) beside `scanWatchesEffect`, same `catchAll` isolation. (Event-driven
  advance would be a *new* pattern, not a mirror — deferred.)
- **Registry (`chain:` prefix, workflow-svc single-writer):** `chain:sub:<chainId>` rows,
  `chain:index`, `chain:config` (kill switch), `chain:__tick__` heartbeat, `chain:ledger:<date>`.
  Replaces Phase 1's best-effort `chain:<slug>` blackboard mirror — the row now IS the durable
  blackboard (`data`) plus the sequencing state. Epoch-fenced exactly like `watch:sub:*`.
- **Pure engine (`chain-engine.ts` `decide(row, hopStatus, nowMs)`):** sibling of `watch-engine.ts`.
  Union `wait | advance | finalize | budget-terminate`. Current hop COMPLETED → advance (fire next) or
  finalize `completed` if last; FAILED/TERMINATED → finalize; UNKNOWN-streak → `orphaned`; live +
  budget breach → `budget-terminate`. "advance" is where "retry" sits in watch.
- **Scan (`chain-scan.ts`):** `registerChainForFire` (the fire choke point — writes the row + fires
  hop 0), `scanChainsEffect` (per active chain: read current-hop status, `decide`, act). On `advance`:
  capture the completed hop's output into `data`, build the next hop's params from `data`, fire it via
  `WorkflowInvoker.invoke` + `WorkflowStore.get`/`toRequest` (exactly what `executeEscalate` does),
  bump the ledger. Finalize publishes a terminal `chain-events` (or reuses `workflow-events`).
- **CLI cutover:** `h chain run` stops blocking/polling and instead REGISTERS a chain (mirrors how
  `--watch` registers a watch); `h chain list`/`GET /chain/list` inspect. The Phase-1 in-process
  sequencing loop is deleted in the same change set (atomic cutover).

**RESOLVED — the hop port contract is engine code, not a DSL, and there is no chain actor.** The
engine is machine code (not agentic), and it is what *strings workflows together*, so the threading
logic lives in the engine. It reads each completed hop's **output** (already returned by
`invoker.getStatus`) and parses it as engine code to build the next hop's params, threading state
through the chain row's `data` (engine = single writer). This mirrors the watcher's ruling W3
(behavior is engine code, never config-expressed logic). Decisive reason a *chain actor* is NOT used:
a workflow like `feature-pr` runs standalone (issue-sweep fires it directly, no chain), so making its
template read/write a `chain-<slug>` actor would couple a chain-agnostic workflow to chain machinery
and require an actor even for non-chained runs. Instead workflows stay chain-agnostic — params in,
`===MARKER===` out — and the engine ships a small set of **hop kinds** (porting Phase 1's live-validated
`CHAIN_TEMPLATES`, incl. the Dapr double-encoding unwrap): `feature-pr` (reads slug/spec/issueNumber →
params; `===PR===` → prUrl/prNumber via `/pull/(\d+)`), `pr-review` (prNumber → `pr`; `===REVIEW===` →
reviewFindings), `revise` (slug + preamble·reviewFindings → spec; `===PR===`). A novel chain adds a hop
kind in engine code, exactly like adding a watch behavior. (The actor was only ever proposed for
*parallel* turn-based writes in Phase 5; since the engine is the single writer that reads each hop's
output, it can aggregate parallel outputs too — the actor likely evaporates there as well.)

**Phase 5 — Strategies.** Add `parallel` (fan-out → actor aggregation → join) and `loop-until-clean`
(predicate + budget). The concurrency experiments live here.

---

## 8. Invariants & gotchas

- **Workflows never supervise** (unchanged). The chain engine sequences; workflows stay pure runs.
- **One writer per registry prefix.** A new `chain:` registry follows the flat-keyspace convention —
  only the chain engine writes `chain:*`.
- **The chain actor's `data` is a convention contract, not a schema.** Every template documents the
  `data` keys it reads/writes; a missing expected key fails loud, never silent (cf. the "MCP tool
  unavailable must be reported" gotcha).
- **Actor keying.** `actorId = chain-${slug}` shares the composite-key space with dapr-mcp's
  GenericActor and the workflow runtime's internal actors — composite keying (`appID||type||id||key`)
  keeps them from colliding, as today.
- **Overlay vs chain is also a performance decision.** Units that share an agent's context (worktree +
  continuation) must overlay; splitting them into a chain pays a context re-read per hop.
- **Chain-level flags apply to all members** (`--watch`, `--agent`, `--slug`); per-member override is a
  deliberate later addition, not v1.

---

## 9. Decisions

> Note: decisions 4–6 below were made pre-implementation around a **chain actor**; building Phase 4
> REVERSED that (see the 2026-07-08 progress entries). The shared context is the **chain row's
> `data`**, written only by the engine, which threads state by parsing each hop's OUTPUT — no actor.
> The originals are kept struck-through for the record.

1. **Adopt template/workflow/chain vocabulary, retire "family"?** (Locked: yes — landed, Phase 3.)
2. **Generic dynamic shared state (`{slug, data: Record<string, any>}`)** over a typed struct?
   (Locked: yes. Realized as the `chain:sub:<id>` row's `data` field, not actor state.)
3. **Overlay = authoring-time, chain = invocation-time (flat hops) for v1?** (Locked: yes; inline
   overlay-in-hop deferred to v2.)
4. ~~**Actors as the cross-workflow sharing mechanism?** (Locked: yes.)~~ **REVERSED (Phase 4):** no
   actor. The engine is machine code and strings the workflows together, so it reads each completed
   hop's OUTPUT (via `getStatus`) and threads the next hop's params — keeping the chained workflows
   chain-agnostic (they run standalone; a chain actor would couple them to chain machinery). Mirrors
   the watcher's ruling W3 (behavior is engine code, never config/actor state).
5. **Chain's durable home is a `chain:` policy engine mirroring watch?** (Locked; **landed, Phase 4** —
   `chain:` registry + pure `decide` + scan on the cron tick, sibling of the watch engine.)
6. ~~**Open — the chain actor's conventional key set.**~~ **Moot** (no actor). The blackboard keys
   (`slug, spec, issueNumber, prNumber, prUrl, reviewFindings`) live in the row's `data`, produced by
   the engine-coded hop contracts (`chain-hops.ts`).
7. **`loop-until-clean` predicate + budget wiring.** (Resolved, **Phase 5**: predicate =
   `reviewIsClean` off the `===REVIEW=== CLEAN` marker; budget = `maxIterations` on the chain row.)
8. **Reviewer independence.** (Satisfied by composition: `pr-review` runs on **claude-coder** — a
   distinct agent from the implement hop — so independence is structural, not an enforced flag.)

---

## Progress log

- **2026-07-07** — Design brainstormed and locked into this plan.
- **2026-07-07 — Phase 1 landed (CLI, hermetic).** Added `h chain run` (`cli/h/src/h_cli/commands/
  chain.py`): sequences the existing saved workflows via a `-t` list (default `feature → pr-review →
  revise`), threading state through an in-process blackboard `{slug, data}` mirrored best-effort to
  the statestore key `chain:<slug>`. Each hop's port contract is the built-in `CHAIN_TEMPLATES`
  registry — `feature`/`revise` share the `feature-<slug>` instance (same branch/PR; revise re-runs
  fresh), `pr-review` reads `data.prNumber` (parsed from the prior hop's `===PR===`), `revise` reads
  `data.reviewFindings` (from `===REVIEW===`). Chain-level flags (`--slug`, `--spec`, `--issue`,
  `--watch`) apply to all hops; non-`sequential` strategies error clearly (deferred to the policy
  engine). 9 respx-mocked tests prove the state threading + failure-stops-the-chain + parser units;
  full h-cli suite green (71). **Decision realized:** the "chain actor" is realized as a statestore
  key for Phase 1 (behaviorally identical for sequential); promotes to a hosted actor when the
  parallel strategy needs turn-based writes (Phase 5). Next: live validation, then Phase 2.
- **2026-07-07 — Phase 1 validated LIVE end to end.** Ran the default chain against a real issue
  (#21 → PR #22): `feature` on openhands/DeepSeek → `pr-review` on **claude-coder** (real Claude — an
  independent reviewer, exactly the reviewer-independence the plan wants) → `revise` on openhands.
  State threaded through the blackboard the whole way (`prNumber` from feature → pr-review's `pr`
  param; `reviewFindings` from pr-review → revise), and the mirror persisted to `chain:doc-h-chain`
  (inspectable). Review came back CLEAN (docs were accurate), so revise was a no-op — a valid
  outcome. The live run earned its keep by catching **two real bugs the mocks missed**: (1) the
  workflow status `output` is **double** JSON-encoded (Dapr re-serializes the workflow's own
  `JSON.stringify(results)`), so the marker parser now unwraps successive string layers — the mocked
  tests were single-encoded and hid it; fixed + a single-vs-double robustness test added. (2)
  `run-openhands-agent.sh` lacked `H_SKILLS_DIR`/`AGENT_APP_DIR` (a parity gap vs
  `run-claude-agent.sh`), so a workflow `setup` step would run `cp -r $H_SKILLS_DIR/.` against an
  empty var — fixed.
- **2026-07-08 — Phase 2 started: overlay operator landed; decomposition design settled.** Added the
  pure `overlay(*defs)` operator (`cli/h/src/h_cli/infrastructure/overlay.py`, 8 tests): merge
  workflow definitions by step id — new id appends, existing id extends the step (APPENDING
  `input.task` prose, later-winning other fields). This is the spatial-composition primitive that
  makes `create-pr` extend `implement` with no extra agent run.
  **Coupling discovered — "kill `--pr`" is a MIGRATION, not a template edit.** `feature`'s `createPr`
  param / epilogue is fired by: the Phase-1 chain (`chain.py`), `issue-sweep.yaml`, `h feature run
  --pr`, and `invoke-workflow-feature-helm.sh`. Removing the epilogue from `feature` would break all
  of them. **Revised plan for Phase 2:** stage it — (1) extract the PR epilogue into a shared helm
  partial so the prose has ONE home (DRY); (2) `feature` includes it (so `--pr`/`createPr` keep
  working — no breakage); (3) add `create-pr.yaml` as an overlay template using the same partial +
  the CLI overlay path (`h workflow compose -t feature -t create-pr`); (4) LATER, migrate the callers
  (chain/issue-sweep/scripts) to the overlay path and only then delete `--pr`. The epilogue has two
  near-identical variants (implement vs verify) sharing steps 1/2/4 (commit/push/#20-inline-resolve)
  verbatim, differing in step 3 + intro/end — a delicate extraction on the load-bearing template, so
  it is deferred to a focused pass rather than rushed. Next: the shared-partial extraction (step 1).
- **2026-07-08 — Phase 2 step 1 landed: PR epilogue extracted to a shared partial (DRY).** The
  ~40-line commit/push/open-PR/respond-to-review prose that was duplicated verbatim between
  `feature.yaml`'s `implement` and `verify` steps now has ONE home: the `h.prEpilogue` helm partial
  (`cli/charts/workflows/templates/_helpers.tpl`). It takes `{variant, slug, createPr, issueNumber,
  gitAuth}`; the only three per-step differences (decision preamble, step-3 PR-body phrase, closing
  marker line) switch on `.variant` ("implement" | "verify"). Each call site is now one line:
  `regexReplaceAll " +\n" (include "h.prEpilogue" (dict …) | nindent 8) "\n"` — the regex strips the
  trailing spaces `nindent` leaves on blank lines so the block scalar's separators stay truly empty.
  feature.yaml shrank 96 lines. Proven a **pure refactor**: rendered output byte-identical across all
  six variants (implement/verify × pr/ssh/publish/base) — wire JSON identical — save for one
  incidental cleanup (an empty `===ISSUE===` value line now renders truly-empty instead of with 8
  trailing spaces; that was the single re-blessed golden line). Full h-cli suite green (80). Next:
  step 3 — add `create-pr.yaml` as an overlay template reusing the same partial + the CLI overlay
  path (`overlay.py`), leaving `feature`'s epilogue in place until the callers migrate (step 4).
- **2026-07-08 — Phase 2 step 3 landed: the overlay path is real end-to-end.** Three pieces:
  (1) **`create-pr.yaml`** — a publish-native overlay atom: a lone `implement` step whose task is
  ONLY the PR epilogue (reusing the same `h.prEpilogue` partial, `variant: implement`, with
  `{{params.slug/createPr/issueNumber}}` tokens; `createPr.gitAuth` bakes from values). (2) A
  **`composable` top-level render mode** (`.Values.composable`, sibling of `publish`): feature
  renders as an overlay-able atom — implement ends neutrally at `{{plan.output}}` (no standalone
  commit-decision closer) and the verify step is **dropped** (verification is its own future overlay
  atom, `-t implement -t create-pr -t verify`; fusing it here would collide with create-pr's
  epilogue). (3) **`h workflow compose -t … -t …`** — renders each template in publish+composable
  mode and `overlay()`s them into one definition, printed or `--save`d as a family. So
  `compose -t feature -t create-pr` is the explicit form of `feature --pr`: create-pr's epilogue
  extends feature's `implement` in ONE workflow (verified: 4 steps `worktree/setup/plan/implement`,
  exactly one epilogue, appended after the plan). +6 tests (create-pr golden, composable-omits-and-
  drops-verify, overlay-extends-implement, 3 CLI wiring); full h-cli suite green (86), ruff clean.
  **Decisions realized:** composable is a top-level mode not a feature knob (any atom can honor it);
  create-pr is publish-native (the composed family fires with `-p createPr=true`, like feature).
  **Deferred to step 4:** feature's own `createPr` epilogue and `--pr` stay until the callers
  (chain, issue-sweep, scripts, `h feature run`) migrate onto the compose path — only then delete
  `--pr`. **Open (Decision 8 / verify coupling):** a `verify` overlay atom + create-pr-after-verify
  ordering, so `-t feature -t create-pr -t verify` composes verification back in.
- **2026-07-08 — Phase 5 (partial): `loop-until-clean` strategy landed; `parallel` deferred.** The
  chain engine now sequences a loop: `loop-until-clean` repeats the review→revise segment until the
  review hop reports `===REVIEW=== CLEAN` (predicate, `chain-hops.ts reviewIsClean`) or `maxIterations`
  trips (budget — no infinite implementer/reviewer disagreement). The pure engine stays strategy-
  agnostic (linear advance/finalize); the SCAN reinterprets its decision for loop chains (the predicate
  + loop-back need the output and hop kinds, which live in the scan): review COMPLETED+CLEAN →
  finalize; last hop (revise) COMPLETED → loop back to the review hop (fresh re-fire, `iterations`++);
  cap reached → finalize with a note. Model gains `ChainStrategy "loop-until-clean"` + `ChainLoop
  {startCursor, maxIterations, iterations}`; the CLI gains `--strategy loop-until-clean
  --max-iterations` (validates a pr-review + a following hop). +14 tests (reviewIsClean, the four loop
  transitions, CLI). Suites green: workflow-svc 137, h-cli 91. **`parallel` deliberately deferred:** it
  fans out N *review kinds* (review-security ∥ review-perf ∥ …) and we have only one `pr-review` kind,
  so building it now would be speculative (no exercisable chain) — revisit when a multi-reviewer chain
  exists. Next: the live end-to-end test (feature → PR → review → revise).
- **2026-07-08 — Phase 4 COMPLETE: the durable chain engine, and the CLI cut over to it.** Chains
  are now a durable primitive, sibling of the watcher — built in six workflow-svc slices then cut over
  atomically. **Engine (`apps/workflow-svc/src/domain/chain-*.ts`):** `chain.model.ts` (ChainRow =
  durable blackboard `data` + sequencing state, epoch-fenced); pure `chain-engine.ts` `decide` →
  wait/advance/finalize/budget-terminate (advance is where watch retries); `chain-hops.ts` the
  engine-coded hop contracts (feature-pr/pr-review/revise, porting Phase 1's live-validated parsing incl.
  the Dapr double-encoding unwrap); `IChainStore`/`dapr-chain-store.ts` the `chain:` registry;
  `chain-scan.ts` `registerChainForFire` + `scanChainsEffect` (reads each hop's OUTPUT — no actor —
  captures into the blackboard, fires the next hop, epoch-fenced mark-before-fire, cost tally, publish).
  Wired onto the same cron `tickEffect` as the watch scan (same catchAll isolation); `chain.router.ts`
  (`POST /chain/run`, `GET /chain/list`, `GET`/`DELETE /chain/:id`); `ChainStoreLive` in the app layer.
  **CLI cutover (atomic):** `h chain run` now REGISTERS via `POST /chain/run` and returns immediately
  (no blocking poll); `h chain list` inspects the registry; the Phase-1 in-process machinery (poll loop,
  `chain:<slug>` blackboard mirror, the Python `CHAIN_TEMPLATES` threading closures) is DELETED — the CLI
  is a thin client that only names the hops' fire identity, the engine owns threading. Suites green:
  workflow-svc 130, h-cli 89. Docs updated (WORKFLOWS.md, CLAUDE.md keyspace). Remaining: **Phase 5**
  (parallel + loop-until-clean strategies).
- **2026-07-08 — verify atom landed: verification is compose-only, and it gates the PR.** The last
  composition gap closed, parallel to how PR became compose-only. New `verify.yaml` overlay atom
  extends the implement step (merge-by-id) with an acceptance-check block: the one implement agent
  runs `verify.cmd` (baked config), fixes forward (≤3, no weakening), and **gates** — on failure it
  STOPS before any commit/PR and ends `===VERIFY=== FAIL`; on pass it continues. So
  `h workflow compose -t feature -t verify -t create-pr` yields ONE implement step ordered
  implement → check → PR-if-green (create-pr **last** — verify's gate must precede it), all in one
  agent/worktree/run. `feature.verifyCmd` and the separate verify step are **deleted** (feature is now
  a pure four-step atom: worktree/setup/plan/implement); `feature.models.verify` gone too (the atom is
  prose on implement, no own activity/model). Migrated `values.local.yaml` (`feature.verifyCmd` →
  `verify.cmd`), the chain/issue-sweep/runbook compose commands (`-t feature -t verify -t create-pr`),
  and WORKFLOWS.md. Goldens: `feature-with-verify` deleted, `verify` added, issue-sweep re-blessed.
  Full h-cli suite green (88), ruff clean. **Composition primitive now complete:** feature is pure;
  verify and create-pr are overlay atoms that extend it; a chain sequences the reviewed-PR loop.
- **2026-07-08 — Phase 2 step 4 landed: `--pr`/`createPr` deleted; a PR is only ever a composition.**
  The atomic cutover the primitive-simplification wanted: feature no longer has any PR machinery, and
  every caller moved to explicit composition in the same change set. **Templates:** feature drops
  `createPr`/`issueNumber` (values + schema + both epilogue branches) — a run always ends as
  uncommitted working-tree changes; the `composable` seam stays (neutral implement end + verify
  dropped). create-pr becomes **always-PR**: composing it IS the intent, so the `createPr` opt-in gate
  is gone — no `===CREATE PR===` decision block, just commit → push → open/update PR (issueNumber
  optional for `Closes #N`). The `h.prEpilogue` partial (single-use once feature dropped it) is
  **inlined** back into create-pr.yaml and deleted from _helpers.tpl — no indirection for one consumer.
  **Callers:** `chain.py` fires the composed `feature-pr` saved template (not `feature`+createPr);
  `issue-sweep` FIRE step dispatches `feature-pr`; `h feature run`/`feature render` lose `--pr`/`--issue`;
  `invoke-workflow-feature-helm.sh` loses `--pr`. **Docs:** WORKFLOWS.md, the h-builds-h runbook, and
  values comments now describe composing a PR in. Prerequisite: publish `feature-pr` once
  (`h workflow compose -t feature -t create-pr --save feature-pr`). Goldens re-blessed (feature-publish
  lost its epilogue; feature-with-pr golden deleted; create-pr rewritten). Full h-cli suite green (86),
  ruff clean. **Decision 8 (verify coupling) now the last open item:** a `verify` overlay atom so
  `-t feature -t create-pr -t verify` composes verification back in (composable currently drops verify).
- **2026-07-08 — Phase 3 landed: "family" retired, "template" adopted in code + docs.** The model,
  restated (per the ruling): a **template** is a parameterized workflow template; helm populates it
  into a **workflow definition**; workflow definitions **compose** (overlay); an executing workflow
  definition is a **workflow**. Two commits: (1) the chart-layer identifier rename — the `family`
  helm gate value → `template` (`--set template=<name>`, `.Values.template`, `render_workflow(
  template=…)`, the `template` schema property, `h workflow publish <template>`), behavior-preserving
  (the gate value is never emitted, so every golden is byte-identical, no re-bless). (2) the prose
  sweep — README.md, WORKFLOWS.md, cli/README.md, CLAUDE.md, and current TS/py comments + test-local
  identifiers (`storedFamily` → `storedTemplate`) all say "template" now. Deliberately preserved:
  `packages/js/core/src/errors.ts` "tagged-error family" (a different sense), and the historical plan
  docs under docs/plans/ (point-in-time records). Suites green: h-cli 86, workflow-svc 94, py
  agent-server 10.
- **2026-07-16 — overlay merges step `setup` lists additively.** `_merge_step` now CONCATENATES
  `input.setup` when both the base step and the layer step carry a list (base first, then layer) —
  the list sibling of the `input.task` prose append, so an overlay atom can contribute setup
  commands (e.g. a future plugins-install fragment) without clobbering the base template's setup.
  Everything else stays later-wins; a `setup` on one side only, or with a non-list value, behaves
  as before. Module docstring updated; 4 new tests (concat order, one-side-only, non-list
  later-wins, deep-copy). h-cli suite green (171), ruff clean.
