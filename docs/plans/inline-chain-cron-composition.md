**Status:** BUILT — all six phases landed 2026-07-19 (D1–D6 + CLI); green in workflow-svc (304 tests)
and the `h` CLI (205 tests). NOT yet live-validated end-to-end (the issue-#51 run needs the agent
fleet up — stack currently down). The only deferred item is loop-until-clean × stages (an open
sub-question below). **Living doc** — see the Progress log.

# Inline chain composition + independent workflow crons + concurrent stages

## Context

Two capabilities the runtime lacks today, discovered while wiring the h-builds-h loop:

1. **You cannot register an inline (unpublished) workflow to run on a cron.** The embedded cron source
   (`CronSourceEmbedded = {mode:"embedded", steps, params, workspaceId}`, `domain/models/cron.model.ts`)
   is modeled AND fired (`cron-scan.ts:fireCron` branches saved-vs-embedded; test
   `cron-scan.test.ts:291` "fires an embedded-source cron with its own steps") — but **nothing
   constructs it.** `planCron` (`register-cron.activity.ts:89`) hardcodes `{mode:"saved", key}`; the
   run edge builds `armCron`→saved; the only `mode:"embedded"` producer in the tree is
   `watch-scan.ts:547`, which is the ONE-SHOT `cron:sched` fallback, not the recur `cron:sub`.
2. **A chain member cannot run on a cron, and a chain cannot run stages concurrently.** `ChainWorkflow`
   (`domain/models/chain.model.ts`) is always `{kind, key, …}` — a saved key, no embedded/recurring
   variant; `cursor` is a linear member index; the `"parallel"` strategy is deferred (CLI `--parallel`
   grammar parses, engine unimplemented).

The motivating scenario: a user composes workflows **inline** from chart templates at the CLI (`-t`
atoms — building a new workflow definition on the fly, no publish), wants some members to **recur on a
cron until a goal is met**, and wants members to run **concurrently** with a join before the next stage.

### Two meanings of "inline" (both in scope)

- **Inline composition** — building a workflow definition at the CLI from `-t` template atoms
  (compose-on-fire), without publishing a template ahead of time.
- **Inline storage** — persisting that composed definition IN the registry row (embedded steps) rather
  than in the saved-workflow registry.

**Default is publish; `--inline` opts into inline storage.** Publishing is already the de-facto default
(a `-t` group publishes under `<slug>-w<N>` today, because a chain member must reference a *key*).
`--inline` is the new escape hatch: store the composed steps as an **embedded** source, nothing landed
in the saved-workflow registry. An inline member that is ALSO a cron has no key to reference, so its
self-armed cron MUST use an embedded source — inline-compose forces embedded storage, and
cron-independence is what lets the member self-arm one. The two "inline"s are one coherent feature.

## Locked decisions

### D1 — Storage: publish by default, `--inline` = embedded, per registry

- Composed (`-t`) definitions publish under `<slug>-w<N>` by default (status quo) → source `{mode:"saved"}`.
- `--inline` stores the composed steps embedded in the owning registry row:
  - standalone inline cron → `CronSourceEmbedded` in the `cron:sub` row (build the missing producer);
  - inline chain member → a new `steps?` alternative to `key` on `ChainWorkflow`, in the `chain:sub` row.
- Each registry owns its own embedded blob (a prefix names its single writer).

### D2 — Workflow cron is an INDEPENDENT primitive; the chain only observes it

The chain engine **never fires a recurrence**. "Member B is a cron" is a property B carries, armed via
the §10 `arm-*` pattern:

1. The chain fires every member of a stage **once**, uniformly. A cron member's fire request carries
   `armCron` (injected from the member's `--cron`).
2. The member's own `generic.workflow` closing bracket runs `register-cron` → writes `cron:sub:B`.
   **The chain engine never writes `cron:sub`.** Single-writer holds exactly as for a standalone
   `--cron` run.
3. The **cron engine** re-fires B on cadence until its goal resolves, then deactivates. The chain
   engine is asleep on B.
4. Chain progression **reads** `wf:B.resolved` (a read, not a write) to know B is done.

| Concern | Owner |
|---|---|
| Fire B, re-fire B until goal, write `cron:sub:B` | **cron primitive** (B self-arms via §10; cron engine recurs) |
| Know B is finished, then fire the next stage; write `chain:sub` | **chain engine** (reads `wf:B.resolved`) |

The residual chain-side awareness is a **completion predicate** (below), not firing logic — the same
slot the chain already fills with `until` on loop members. This keeps workflow-cron (and future
workflow concurrency primitives) self-sufficient and composable inside OR outside a chain.

### D3 — Concurrency: a chain is ordered STAGES, each stage a concurrent set

Unify sequential + parallel under one model instead of bolting parallel on:

- Keep `workflows: ChainWorkflow[]` flat (so `captures`/`inputs`/`until` keep indexing it); **add
  `stage: number` per member.** `cursor` is reinterpreted from *member index* → *current stage index*.
  Sequential = members in stages `0,1,2,…` (existing chains unchanged: member `i` → stage `i`).
  Parallel = members sharing a stage. `{A ∥ B} → C` = `[A:0, B:0, C:1]`.
- `currentInstanceId` (singular) generalizes to per-member: a stage tracks N concurrent instances (the
  engine derives a member's instance from chain+index and checks each member of the current stage).

**Progression (uniform for both strategies):**
1. Register → fire every member of stage 0.
2. Each tick, for the current stage, evaluate `done(member)` per member.
3. All stage members done → capture their outputs into the blackboard, advance `cursor`, fire the next
   stage. Any not done → wait.
4. Finalize when the last stage completes.

### D4 — Completion predicate (per member, read-only)

`done(member)` =
- **cron member** → `wf:<member>.resolved === true` (its cron deactivated resolved);
- **`until` member** → the `until` predicate holds on structured output (today);
- **plain member** → its instance reached terminal-success.

The chain interrogates the workflow registry (`wf:` state) — a read, never a write. Plain members
default to `resolved := terminal-success`.

### D5 — Namespaced extraction (parallel join)

The blackboard becomes two-level so concurrent members can't clobber each other. **Captures are
namespace-implicit** (a member always writes under its own id); **inputs are namespace-explicit**
(a reader names whose output it wants) — namespaces appear only on the read side, where you disambiguate.

```jsonc
// stage 0 — concurrent
{ id: "research",       stage: 0, captures: { findings: "summary" } }   // writes research.findings
{ id: "gather-metrics", stage: 0, cron: { cadence: "*/30 * * * *", maxFires: 20 },
                                  captures: { metrics: "latest" } }      // captured from the RESOLVED run
// stage 1 — fires when stage 0 is all-done
{ id: "report", stage: 1, inputs: { spec: "research.findings", telemetry: "gather-metrics.metrics" } }

// blackboard after stage 0:
data = { research: { findings: "…" }, "gather-metrics": { metrics: "…" } }
// report fires with: { spec: data.research.findings, telemetry: data["gather-metrics"].metrics }
```

- capture `findings=summary` on `research` → `research.findings` (namespace = the member it's attached to);
- input `spec=research.findings` on `report` → dotted `member.field` path (consistent with `until`'s `path`);
- a cron member's `captures` fire off the **resolved** run, not intermediate loops;
- back-compat: today's flat threading is the degenerate one-member-per-stage case; coded kind-contracts
  (feature-pr/pr-review/revise) thread in engine code and are untouched — only the *declared* DSL adopts
  `member.field`.

CLI (position-scoped suffix flags, member id defaults to the `-t`/`-w` name):

```bash
h chain run --slug demo --inline \
  -t research        --capture findings=summary \
  -t gather-metrics  --stage 0 --cron '*/30 * * * *' --max-fires 20 --capture metrics=latest \
  -t report          --stage 1 --input spec=research.findings --input telemetry=gather-metrics.metrics
```

### D6 — Atomicity: a chain fails as a unit

A chain is atomic. **Any non-cron member reaching terminal-failure → the whole chain finalizes
`failed`, and before it does:**
1. **terminate** every still-running member instance of the live stage (graceful: `invoker.terminate`
   → the run's scope finalizer kills the subprocess);
2. **publish disarm** for every active member-armed cron (loose pub/sub edge — the disarm handler stays
   the single writer of `cron:sub`; the chain never writes it, per D2);
3. mark the chain `failed`.

A cron member's *transient* run failures do NOT fail the stage (that is why it is a cron — it retries on
its clock). On **success** there is nothing to reap (every member is `done`, crons already
resolved→deactivated, no member running). So active teardown is a failure-path-only concern.

This subsumes the earlier "GC-on-disarm" point: cleaning up what a composition minted is one seam — a
finalizing chain publishes disarm for its crons and, under publish-default, deletes its minted
`<slug>-w<N>` defs.

## Surface changes (summary)

- **Domain:** `ChainWorkflow` gains `stage: number`, optional `steps` (embedded member) as an alternative
  to `key`, and an optional `cron` policy; `ChainRow.data` becomes two-level (namespaced by member id);
  `cursor` semantics → stage index; per-member `currentInstanceId` tracking. `planCron` /
  `register-cron` gain an **embedded** source producer.
- **Chain engine (`chain-engine.ts` / `chain-scan.ts`):** stage-based progression (fire a set, join on a
  per-member completion predicate), read `wf:resolved` for cron members, namespaced capture/input
  resolution, atomic-failure teardown (terminate running + publish cron disarms).
- **Cron:** the embedded-source registration producer (the missing half); `armCron` carries embedded
  steps for an inline member.
- **CLI (`h chain run`):** `--cron`/`--max-fires` as position-scoped member flags; `--stage N` (or the
  existing `--parallel` grammar) to group a concurrent stage; `--inline` to store embedded; namespaced
  `--input member.field`; default publish under `<slug>-w<N>`.
- **Teardown seam:** a `cron` disarm topic the chain publishes to on finalize; the disarm handler is the
  single writer.

## Open sub-questions (for the build, not blockers)

- **loop-until-clean × stages:** `startCursor`/`maxIterations` reinterpret against stage indices; a loop
  body is a stage range. Reconcile in the engine change.
- ~~**Cron member captured value:** confirm the engine captures off the specific run that flipped
  `wf:resolved` (the resolved instance), not the last-fired instance, when they differ.~~ RESOLVED
  (Phase 4): the chain captures off `wf.output`, which write-wf-row stamps on the SAME terminal write
  that records `resolved` from the run's structured `goal: RESOLVED` — so the captured output and the
  resolved flag are guaranteed to come from one run. The chain reads the wf row, never the instance.
- ~~**Disarm-event contract:** topic name + payload (chainId → member cron ids) for D6 step 2.~~
  RESOLVED (Phase 5): topic **`cron-disarm`** (constant in cron.model), payload the recur cron's
  identity tuple `{repo, slug, workflow}` (the same coords `cronId` builds / POST /cron/disarm takes).
  The chain publishes one per active cron member of the finalizing stage; workflow-svc subscribes
  (cron.router cloudevents route → `disarmEventEffect` → the single-writer `disarmCron`). Idempotent:
  a missing / already-deactivated cron acks `{skipped}`.

## Test plan

Drive **issue #51** through it (the agreed end-to-end target): compose an inline chain that pulls #51 and
runs it (a feature-pr-kind member), with a member on a cron, `--inline`, and observe register → tick →
fire → recur → resolve → advance → PR. Requires the agent fleet up. This exercises the embedded-cron
path with real work; note it is a PARALLEL demonstration of the mechanism, distinct from the production
h-builds-h loop (discovery-cron → saved `feature-pr`).

Plus, ahead of the live run: unit tests for the embedded registration producer, stage progression, the
namespaced capture/input resolver, the cron-member completion predicate, and atomic-failure teardown;
a CLI golden for the new `h chain run` grammar.

## Progress log

- 2026-07-19 — **Phase 6 landed** (the `h chain run` CLI surface — everything built so far is now
  reachable from the command line). `chain_expr.py` gained the per-member flags `--stage N`,
  `--cron CADENCE`, `--max-fires N`, `--id NAME`, and `--inline` (bool, also a chain-wide default like
  `--fresh`); `--max-fires`/`--stage` validate as integers; `_set_flag` maps `--max-fires`→`max_fires`.
  `chain.py` now: computes each member's FINAL stage (explicit `--stage` wins, else the `--parallel`
  positional group) and marks a member parallel when its final stage is SHARED (so `-t a --stage 0 -t
  b --stage 0` and `-w a --parallel -w b` are equivalent); emits `stage` on every member once the chain
  uses stages (else omits it — sequential goldens unchanged); embeds `steps` (no publish) for an
  `--inline`/`--cron` member (D1) and emits `cron:{cadence,maxFires?}`; emits a member `id` (its
  namespace) for parallel members or an explicit `--id`, so a lone sequential member still threads flat
  (and its `--input` stays a flat key — while a dotted `--input PARAM=id.field` flows through verbatim
  for the engine's D5 path-resolver); drops the shared-branch instanceId for inline/parallel members
  (engine derives a unique `<chainId>-w<i>`); requires `-p repo=…` when any member is a cron;
  **removed the Phase-5 parallel rejection** (stages are live). Fail-loud guards: `--cron` on a saved
  `-w` key, `--max-fires` without `--cron`. Green: h CLI 205 tests (parser + command + goldens, incl.
  new parallel/stage/inline/cron/dotted-input cases) + ruff. Steering refreshed (CLAUDE.md primitives +
  app-layout + cli tree; ARCHITECTURE.md).
- 2026-07-19 — **Phase 5 landed** (D6 atomic-failure teardown — a chain fails as a unit). The
  disarm-event contract is settled: topic **`cron-disarm`** (`CRON_DISARM_TOPIC` in cron.model),
  payload the recur cron identity `{repo, slug, workflow}`. `chain-scan` gained two teardown helpers —
  `terminateRunningMembers` (kill the live siblings of the failing stage; the failed member is already
  terminal, a `done` member has nothing to reap; best-effort so teardown never itself fails the
  finalize) and `disarmStageCrons` (publish a `cron-disarm` per cron member of the stage — a LOOSE
  pub/sub edge, so the chain NEVER writes cron:sub per D2). Wired into every non-completed finalize:
  `finalize failed|terminated` terminates siblings + disarms; `orphaned` disarms only (member status
  unreadable); `budget-terminate` disarms after its existing terminate-all; registration's
  `finalizeFailed` disarms a cron armed before a dispatch failure. A completed chain reaps nothing
  (every member done, crons already resolved→deactivated). The single-writer side: `cron-scan`'s
  **`disarmEventEffect`** (the pub/sub sibling of POST /cron/disarm) reuses `disarmCron`; cron.router
  serves it on a cloudevents `POST /cron-disarm` route; workflow.router's `/dapr/subscribe` declares
  the topic. Green: workflow-svc 304 tests (+6: 2 chain-teardown scan tests — terminate-siblings+publish-disarm-on-failure,
  no-reap-on-completed — + 4 disarmEventEffect unit tests) + tsc + oxfmt + depcruise. NOT yet
  live-validated (stack down).
- 2026-07-19 — **Phase 4 landed** (D1-chain + D2 + D4-cron — inline chain members + independent
  workflow-cron members the chain only OBSERVES). `ChainWorkflow`: `key` is now optional with an
  embedded `steps` alternative (D1 inline storage — the composed def lives IN the `chain:sub` row),
  plus an optional `cron` policy `{cadence, maxFires?}`. `validateStages` → **`validateChain`** now
  also enforces member shape: exactly one of `key`/`steps` (XOR), and a cron member MUST be inline
  (`steps`) — its self-armed recurrence has no key to reference (D1). `chain-scan.fireWorkflow`
  branches inline (fire the embedded steps verbatim) vs saved (resolve the key), and injects
  **`armCron`** for a cron member so it self-arms its recurrence via the §10 arm-* pattern (its own
  generic.workflow closing bracket runs register-cron over the embedded source built from Phase 1) —
  **the chain engine never writes `cron:sub` and never re-fires** (D2). A cron member's fire REQUIRES a
  wf identity (fail-loud without a repo) — both the cron engine's goal check and the chain's
  completion predicate read `wf:<repo>:<slug>:<kind>.resolved`. The completion predicate (`observeMember`)
  gains its cron branch: `done ⟺ wf:<member>.resolved` (read via `WfStore`, added to `ChainScanEnv`;
  production already provisions it), a cron member's transient run failures NEVER fail the chain, and
  its capture threads off the resolved run's `wf.output`. Green: workflow-svc 298 tests (+12: 8
  validateChain unit cases + 4 cron-member scan integration tests — self-arm fire, wait-while-unresolved,
  advance-on-resolved-with-namespaced-capture, no-repo-fails) + tsc + oxfmt + depcruise. NOT yet
  live-validated (stack down).
- 2026-07-19 — **Phase 3 landed** (D5 namespaced two-level blackboard — concurrent members can't
  clobber). `ChainWorkflow` gained optional `id` (the member's blackboard namespace). In
  `chain-workflows.ts`: a declared `captures` mapping now writes under `data[id]` when the member has
  an `id` (**namespace-implicit** — a member writes under its OWN id), and threads FLAT when it
  doesn't (the degenerate one-member-per-stage case, so all pre-D5 chains and the coded kind-contracts
  are untouched); a declared `inputs` mapping resolves each value as a **dot-PATH** into the two-level
  blackboard (**namespace-explicit** — `id.field` reads a member's namespaced capture, a no-dot key is
  a one-hop flat read of a chain seed / coded write), reusing `structuredField`'s walk so reads match
  writes exactly. `chain.router` decodes `id` (wire ready). Green: workflow-svc 286 tests (+6: 5
  namespaced-threading unit cases + 1 scan integration test proving `{a ∥ b} → c` joins, namespaces
  both captures without clobber, and feeds `c`'s spec from the dotted `a.val`) + tsc + oxfmt +
  depcruise. Deferred to Phase 4: a cron member's capture off the RESOLVED run; no CLI `--capture`/
  `--input member.field` grammar yet (a later CLI phase). NOT yet live-validated (stack down).
- 2026-07-19 — **Phase 2 landed** (D3 stage-based concurrency + D4-plain completion predicate — the
  chain-engine backbone the rest of the chain side builds on). `ChainWorkflow` gained optional `stage`;
  `cursor` reinterpreted from member index → **current stage index** (numerically identical for the
  one-member-per-stage back-compat case, so existing sequential + loop-until-clean chains are
  unchanged). New pure stage helpers in `chain.model.ts` (`stageOf`/`stagesOf`/`membersInStage`/
  `lastStage`/`validateStages` — absent stage ⇒ member index; all-or-none + 0-based-contiguous
  validated at registration, fail-loud). The pure engine `decide` now takes a **stage of
  `MemberObservation`s** (index/runtimeStatus/`done`/`failed`) and decides at the stage level: any
  member `failed` → finalize; all `done` → advance to `nextStage` (or finalize completed on the last
  stage); any UNKNOWN → conservative streak. The scan observes every current-stage member
  (`observeMember`, per-member instance via `instanceIdAt` — dropped the `currentInstanceId` read
  preference), fires a stage as a set (`fireStage`), captures every completed member on advance,
  terminates the whole stage on budget breach; `tallyChainCost` sums members with `stage ≤ cursor`.
  D4 completion predicate is plain-member-only (terminal-success) this phase — the cron (`wf:resolved`)
  and `until` predicates have their seam in `observeMember` for Phase 3/4. `chain.router` decodes the
  new `stage` field (wire ready); no CLI `--stage` grammar yet (a later CLI phase). Green:
  workflow-svc 280 tests (+5 parallel-stage engine cases) + tsc + oxfmt + depcruise. NOT yet
  live-validated (stack down).
- 2026-07-19 — **Phase 1 landed** (embedded cron-source producer + `h workflow run --inline --cron`).
  `CronSourceEmbedded.steps` widened to the `WorkflowStep` union (parallel-group-ready); `armCron`
  gained `inline`; `planCron`/`register-cron` build a `{mode:"embedded"}` source from the run's own
  steps (fail-closed when inline has no steps); `generic.workflow` forwards `input.steps`/`workspaceId`
  when arming inline; `POST /workflow/run` rejects an `armCron` without `wf` (symmetric with the saved
  route); CLI `run_steps` + the `--inline --cron` wiring (requires repo/slug). Green: workflow-svc 275
  tests + lint + depcruise; CLI 194 tests + ruff. NOT yet live-validated (stack down).
- 2026-07-19 — Design workshopped and locked (D1–D6). Settled: publish-default + `--inline` embedded
  storage; workflow cron independent (self-arm via §10, chain observes `wf:resolved`); stage-based
  concurrency subsuming sequential; namespace-implicit captures + namespace-explicit dotted inputs;
  atomic-failure teardown (terminate running + pub/sub cron disarm) as the single "clean up what a
  composition minted" seam. Not yet started.
