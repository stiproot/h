**Status:** IMPLEMENTED + FULL MARKER CUTOVER (2026-07-15) — machinery, the template
conversion, two live chain validations, and then the complete retirement of output markers, all in
one day; see the Progress log. STRUCTURED-ONLY: every machine consumer (chain contracts,
goalResolved, register-cron) reads the validated block exclusively; marker parsing is deleted.
Output markers no longer exist in any template — `===X===` survives solely as prompt-section
headings (input delimiters), which no code parses. D4 (rung-3 extract) closed 2026-07-16:
deferred with a tripwire — nothing open.
Extends [workflow-composition.md](./workflow-composition.md) (the chain's original marker-threading
contracts) and [chain-composition-surface.md](./chain-composition-surface.md) (the chain
expression). Grew out of re-evaluating the `===MARKER===` decision; the body below is the design
as first written (coexistence framing) — the Decisions and Progress log carry the same-day
supersession to structured-only.
**Living doc** — update Decisions as they resolve and append to the Progress log.

# Structured workflow outputs: typed I/O signatures (né "beside the markers")

## Framing

A workflow's output today is structured exactly as deep as code produces it: the generic workflow
returns `{stepId → activity result}`, each activity returns a typed envelope (`{sessionId, output}`),
and then structure ends — the `output` field of an agent step is an LLM's prose. The
`===MARKER===` vocabulary is a micro-schema imposed on that prose so the chain engine can thread
scalars (a PR number, a CLEAN verdict) workflow-to-workflow. It works because each hop threads at
most a couple of scalars, and the parsers are shallow by design (`afterMarker` is a string split).

Two pressures argue for a structured sibling:

1. **Richer payloads.** A `pr-review` that outputs a summary *plus an array of comment ids* strains
   the marker grammar — markers thread scalars, not shapes.
2. **Composability without deploys.** `WORKFLOW_KINDS` is a closed literal; a novel chain shape
   requires editing `chain-workflows.ts` and deploying. A declared output schema plus a declarative
   mapping lets a chain be composed at registration time (ruling W3 revisited — see §6).

The decision this plan encodes: **both strategies coexist, per-template opt-in, and the chain
engine prefers structured output when a member's workflow declares it.** Markers remain fully
supported — they are the right tool for scalar handoffs and for humans reading the run ledger — and
no existing template is forced to convert.

### Where determinism actually comes from

Swapping marker syntax for JSON syntax buys nothing by itself: the nondeterminism is whether the
LLM honors the output contract at all, and that risk is identical for "end with `===PR===`" and
"end with valid JSON" (slightly worse for JSON — more ways to malform). Determinism goes up only at
a **validation boundary**: code that checks the emitted structure against a schema and fails the
step loud on mismatch, so the watcher's retry policy re-runs it. Structure must be *enforced where
it is produced*, not hoped for and parsed later. Every design element below serves that principle.

---

## 1. The output contract: one schema, three consumers

A template that opts in declares an `outputs:` schema — a JSON Schema for the structured summary
the workflow promises. The declaration is the single source of truth, consumed three ways:

1. **Steering** — the per-step contract instruction rendered into the agent step's task prose is
   *generated from the schema*, so instruction and contract cannot drift.
2. **Validation** — the activity (or a dedicated extract step, §3) validates the emitted block
   against the same schema and fails the step loud on mismatch.
3. **Registration** — `h chain run` validates a member's capture/input mappings against its
   neighbors' declared schemas, so a broken thread fails at registration, not mid-chain.

The schema lives **with the template** (a `values.yaml`-adjacent `outputs:` block rendered onto the
published workflow definition), giving saved workflows typed I/O signatures for the first time:
params in (already declared), outputs out (new).

```yaml
# pr-review's declaration (illustrative)
outputs:
  type: object
  required: [verdict]
  properties:
    verdict: { enum: [CLEAN, FINDINGS] }
    summary: { type: string }
    commentIds: { type: array, items: { type: string } }
```

## 2. Steering: protocol as a rule, instance in the prompt

The contract splits into two halves with different scopes and different reliability mechanics:

- **Protocol → shared steering (`h-runtime.md`), installed by setup.** Unconditional,
  workspace-stable, install-once — a perfect setup citizen:

  > When a task contains an `===OUTPUT CONTRACT===` block holding a JSON schema, your final message
  > MUST end with a fenced ```json block matching that schema. The output is machine-validated; a
  > mismatch fails the step.

- **Instance → the step epilogue.** The schema itself, rendered from the template's `outputs:`
  declaration into the agent step's task prose (a chart conditional, the same pattern as the
  `createPr` gate), adjacent to the task it governs.

Why the split (settled 2026-07-15): rules beat skills because they are always in context and
*unconditionally* applicable — but output contracts are **step-scoped** (within one `feature` run,
the verify step promises `===VERIFY===` and the create-pr step promises `===PR===`), while
setup-installed rules are **workspace-scoped** (every step, and every chain member sharing the
worktree). A global rule would have to go conditional ("when your task is X…"), which is exactly
where rule reliability leaks; the setup sentinel's spec-hash short-circuit also signals that setup
content is meant to be slowly-varying, not per-fire. So: shared protocol via setup, per-step schema
in the prompt. Setup remains what it is — a script runner (`agent-routes.ts`) — no new machinery.

## 3. Enforcement ladder (opt-in levels)

Ascending determinism; a template picks its rung:

1. **Markers (status quo).** Prose contract, shallow greps, no enforcement. Right for scalar
   handoffs and templates that never chain.
2. **Structured block + activity-side validation.** The agent ends with a fenced JSON block; the
   run activity parses it against the declared schema and **fails the step** on absence/mismatch
   (watcher retries). This is the default rung for `outputs:`-declaring templates.
3. **Dedicated `extract` activity.** A final deterministic step that takes the prior agent step's
   raw output plus the schema and calls a cheap model with *forced* structured output
   (schema-validated generation with retry — `generateObject` via the existing `core-vercel`
   LiteLLM client). Its return value is a code-guaranteed envelope entering the results map, the
   same trust level as `create-worktree` returning `{worktreePath}`. For templates whose primary
   agent step is long/expensive enough that a re-run on a malformed tail is unacceptable.

Rung 3 keeps chain-agnosticism intact: the extract step is part of the workflow's own definition —
"params in, structured summary out" — runnable standalone.

## 4. The chain engine: declarative mappings on the registry row

With schema-guaranteed outputs, the coded contracts' hard parts (URL regexes, string-sniffing
predicates) evaporate, and `ChainWorkflow` grows three declarative, Schema-validated fields:

```ts
// chain.model.ts — per-member, all optional (absent → marker kind contract applies)
captures: { prNumber: "pr" },                    // output field → blackboard key
inputs:   { pr: "prNumber", slug: "slug" },      // blackboard key → next fire param
until:    { path: "verdict", equals: "CLEAN" },  // loop predicate (replaces reviewIsClean)
```

- The engine's generic `capture`/`buildParams` walk these maps; `WORKFLOW_KINDS` shrinks to
  **presets** (shorthand for common mappings) rather than the only vocabulary.
- The DSL is deliberately tiny: **rename, require, equals**. The moment a mapping wants a transform
  or a conditional, that is the signal it should be a coded kind — or pushed into the producing
  template's extract schema (emit `pr: 42`, not a URL to parse). That line is what keeps this from
  becoming a JSONPath swamp; W3's "threading is engine code" survives for everything nontrivial.
- Registry invariants unchanged: `chain:*` rows written only by workflow-svc, epoch-fenced,
  validated at registration. `requireStr`-style human hints move to registration-time errors.

**Default resolution order (the headline decision):** when the chain scan advances past a member
whose fired workflow declares `outputs:`, the engine reads the validated structured block from the
results map and applies `captures`/`inputs`. Marker parsing is the fallback for members whose
workflows declare nothing. A member can force markers explicitly (`strategy: markers` on the row /
a CLI flag) — coexistence is per-member, not global.

## 5. CLI surface

- `h chain run` — members whose saved workflows declare `outputs:` get structured threading by
  default; `--capture k=v` / `--input k=v` position-scoped flags (the §1.9 suffix grammar) compose
  novel mappings without a deploy. Registration validates mappings against the declared schemas.
- `h workflow publish` — renders the `outputs:` declaration onto the saved definition; publish-mode
  goldens capture the contract epilogue.
- Machinery/content split preserved: mappings are machinery (flags), never `-p` params.

## 6. What this revisits, honestly

- **Ruling W3** ("threading is engine code, not a config DSL") — *narrowed, not reversed*. The
  judgment-bearing parts (what to thread, transforms, multi-way predicates) stay in code or in the
  producing schema; only rename/require/equals become data. The earlier objections to a rules DSL
  were mostly compensations for unstructured output; schema-enforced outputs dissolve them.
- **"The markers ARE the contract"** — still true where markers remain. The structured block is the
  same idea one rung up: a machine channel embedded in prose, now with a declared shape and a
  validation boundary.
- **Chain-agnostic workflows** — strengthened: a workflow's contract becomes its declared,
  validated output schema instead of prose conventions scattered across template epilogues.

## Decisions

- (D1, settled — then superseded 2026-07-15) Originally: coexistence, structured default with
  marker fallback. Superseded by the full cutover: STRUCTURED ONLY for every machine consumer;
  marker parsing deleted; `===X===` survives only as prompt-section headings no code parses.
- (D2, settled) Steering split: protocol rule in `h-runtime.md` via setup; schema instance in the
  step epilogue, generated from the declaration. Setup carries only shared, workspace-stable
  steering.
- (D3, settled) Validation is code-side at the producing boundary (rung 2 minimum for declaring
  templates); a mismatch fails the step loud.
- (D4, closed 2026-07-16: DEFERRED with a tripwire) Rung 3 (the extract step) is not built —
  speculative machinery for a failure never observed: across every contracted live run (~8 agent
  steps: two e2e features, three reviews, the cron-rm implement, the rebase), zero rung-2
  validation failures; the protocol rule + adjacent epilogue proved highly reliable. The one
  adjacent wobble (the rebase run's hedged `notes`) was a CONTENT problem a formatter-extractor
  cannot fix. **Tripwire:** the first time a rung-2 failure burns a re-run of a step costing more
  than ~5 minutes, build the COMPOSITION shape — an `extract` chart atom = a run-claude step on a
  cheap model whose input is the expensive step's `{{output}}` plus the outputContract (the
  contract MOVES to the extract step, so the expensive step can no longer fail on its tail).
  Never the alternative shape (a workflow-svc activity calling a model directly): only agent
  services hold LLM credentials — that invariant is worth more than provider-forced schemas.
- (D5, open) Where `outputs:` lives on the wire: a top-level field on `StoredWorkflow` (visible to
  `get_workflow`/registration validation) vs baked only into step prose. Leaning top-level —
  registration validation (§1 consumer 3) needs it addressable.
- (D6, open) `until` predicate shape: single `{path, equals}` now; resist growing it until a real
  chain needs more (then it earns a coded kind instead).

## Migration

Incremental, then atomic per the house style: land the machinery (schema field, chart conditional,
validation seam, engine mappings) with no template converted — everything renders/behaves
identically. Then convert `feature-pr` / `pr-review` / `revise` **in one change set**, re-bless the
goldens, republish the saved workflows, and delete the marker parsers those kinds no longer need
(`capturePr`/`captureReview`/`reviewIsClean` stay only while a registered chain row still uses a
marker kind). Templates outside the chain (verify's `===VERIFY===`, the two-report
`===ISSUE REPORT===`/`===PLUGIN FEEDBACK===` convention) keep markers indefinitely — they are
agent- and human-consumed, not engine-consumed.

## Touches

- `cli/charts/workflows/` — `outputs:` declaration + contract-epilogue conditional per template;
  goldens.
- `apps/claude-agent/steering/h-runtime.md` — the protocol rule.
- `packages/js/agent-server` (or the run activities) — rung-2 validation seam.
- `apps/workflow-svc` — `StoredWorkflow.outputs`, `ChainWorkflow.{captures,inputs,until}`, generic
  capture/buildParams, optional `extract` activity (`core-vercel` client).
- `cli/h` — `--capture`/`--input` flags, registration-time schema validation, tests.

## Progress log

- 2026-07-15 — Plan written. Context: grew out of a first-principles review of the marker syntax
  (why it exists, what it compensates for). Same day: `h-lab-runtime.md` renamed `h-runtime.md`
  (5f557ab) and the three saved workflows republished with the new path.
- 2026-07-15 — **Implemented end-to-end.** (1) Protocol rule in `h-runtime.md`. (2) Rung-2 seam:
  `workflow-svc domain/structured-output.ts` — fail-closed JSON-Schema SUBSET validator
  (type/properties/required/items/enum/const; dependency-free, an unsupported keyword rejects the
  whole contract), last-fenced-```json extraction, `applyOutputContract` wired into all 7 run-*
  activities (envelope gains `structured`); `StoredWorkflow.outputs` (D5: top-level). (3) Chain
  engine: `ChainWorkflow.{captures,inputs,until}` + `contractFor` (a declared mapping replaces its
  HALF of the kind contract) + `loopIsClean`; **D1 lands as structured-first kind contracts** —
  `capturePr`/`captureReview`/`reviewIsClean` read `stepStructured()` before grepping markers, so
  declaring workflows thread structured with ZERO chain-side config and marker-era saved workflows
  keep working (no CLI preset table, no extra registration GETs). (4) Chart: `h.outputContractEpilogue`
  helper; one-declarer-per-composition guard in `overlay()`; `outputs` through compose/publish/save.
  (5) CLI: `--capture/--input/--until` position-scoped expression flags + registration validation
  against the declared schema. (6) Conversion: create-pr / pr-review / revise declare contracts
  (dual emission — markers kept for register-cron's `===PR===` guard, `goalResolved`'s `===GOAL===`,
  and humans); goldens re-blessed; saved workflows republished. Deferred: rung-3 extract activity
  (D4), `===GOAL===`/register-cron structured cutover, deleting marker parsers (blocked on those
  two consumers + marker-era saved workflows aging out).
- 2026-07-15 — **Validated LIVE** (compose stack): chain `e2e-structured` = feature-pr → pr-review
  on stiproot/h, toy spec. Evidence per seam: the implement envelope carried the code-validated
  `structured: {pr: 46, url}` (rung 2 accepted the agent's fenced block — the agent emitted it
  correctly after its markers, so protocol + epilogue steering held); the chain blackboard's
  `prNumber=46` came from the structured-first `capturePr` branch; pr-review fired with `pr=46`
  and its own envelope validated `{verdict: FINDINGS, summary: …}` — a legitimately non-CLEAN
  verdict (the toy doc referenced a plan file not yet pushed to origin), so the findings path was
  exercised too; chain finalized `completed`. Bonus: the run flushed out a PRE-EXISTING state-key
  bug — Dapr's state HTTP API carries keys in the URL path on get/delete, so slashed keys
  (`cron:sub:owner/name:…`, `wf:owner/name:…`) saved fine but 404'd (ERR_DIRECT_INVOKE) on every
  read; NO recur cron had ever been armed for a slashed repo. Fixed via core-dapr `pathStateKey`
  (percent-encode every path-position key) — after which arm-revise armed the FIRST `cron:sub:*`
  row ever (then disarmed by hand: e2e artifact). PR #46 is the test artifact (closed unmerged).
- 2026-07-15 — **Round 2 validated LIVE: loop-until-clean on the declared until.** Chain
  `e2e-structured-2` = feature-pr → pr-review (`--until verdict=CLEAN`) → revise, strategy
  loop-until-clean, fresh slug. Exercised what round 1 didn't: `--until` through the full stack
  (expression parse → registration validation against pr-review's declared schema → durable row
  `until: {path: verdict, equals: CLEAN}` → engine); PR #47 opened from a fresh worktree,
  `prNumber=47` captured structured-first; the review's validated block was `{verdict: "CLEAN"}`
  (summary legitimately omitted — only verdict is required) and the chain finalized
  `clean after 0 revise iteration(s)` — the loop-stop decision made by `loopIsClean`'s
  DECLARED-UNTIL branch on the structured verdict, no marker sniff, no revise fire. Artifacts
  cleaned: cron disarmed, PR #47 closed unmerged, both e2e branches deleted.
- 2026-07-15 — **Full marker cutover (structured-only).** Ruling: consistency beats coexistence —
  all OUTPUT markers retired in one change set (the atomic-cutover principle), same day the seams
  proved out live. Engine: `goalResolved` reads the structured `goal`; `register-cron`'s arm guard
  reads the block's `pr` (via `lastFencedJson`); chain contracts (`capturePr`/`captureReview`/
  `reviewIsClean`) are structured-only — `afterMarker`/`stepOutputs` DELETED, absence of structured
  output is a loud `ChainThreadError`, and an absent review verdict is NOT-clean (inverted from the
  marker era: a loop must never stop as if the review passed). Templates: `===PR===`/`===GOAL===`/
  `===REVIEW===` emission removed (skip reasons ride `skipped`); `===VERIFY===` folded into the
  contract as a declared `verify: PASS|FAIL` (the gate behavior stays prose; the outcome is now a
  validated field on create-pr's composed contract); plugin-improvement's verify step gained its own
  per-step contract. The orchestrator skill's two-report convention (`===ISSUE REPORT===`/
  `===PLUGIN FEEDBACK===`) became a two-property outputContract. The boundary that stays: prompt-
  section HEADINGS (`===FEATURE SPEC===`, `===IMPLEMENTATION PLAN===`, `===ISSUE===`,
  `===OUTPUT CONTRACT===` itself) are input structure no code parses — renamed only where the old
  name implied an output channel (verify's heading → `===ACCEPTANCE CHECK===`).
- 2026-07-16 — **D4 closed: deferred with a tripwire.** Zero rung-2 validation failures across
  every contracted live run — build-what's-needed says no speculative extract machinery. The
  decision block records the tripwire (first expensive re-run burned by a tail failure) and pins
  the shape to build when it trips (composition: a cheap-agent extract atom; never LLM creds on
  workflow-svc). Plan complete.
