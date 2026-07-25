# Vocabulary standardization — one dictionary across the repo

Status: Designed — decisions locked 2026-07-24; phased for h to carry out
Established: 2026-07-24

## Why

Terminology has drifted across the docs, code, and CLI. Three flavors, all live today:

- **Overloads** (one word, many things): *workflow* carries five senses — the primitive, a
  definition (steps blob), a saved definition (a key), a running instance, and a chain's slot
  (`ChainWorkflow`, the `-w` operand). *run* is the verb, an AGENT run (run ledger, `run:` rows),
  and colloquially a workflow execution. *family* was retired for "template" (2026-07-08) yet
  recycled to mean the cron sibling set (`schedule.py:3`, `cron.router.ts:152`).
- **Synonym clusters** (many words, one thing): the chain slot is `ChainWorkflow` (model),
  "member" (~85 uses in engine prose — the de-facto winner), "hop" (6 fossils in
  `test_chain_expr.py`/`test_chain.py` that survived the last migration), and "workflow" (CLI
  help). The chain's shared state is "blackboard" (design prose) vs `data` (the field).
- **Layer bleed**: helm "chart" (an authoring technology) vs "template" (the primitive) — mostly
  clean, not yet codified.

The hop fossils and the recycled "family" prove the standing lesson: **a vocabulary migration
without a guard always leaves survivors.**

## The organizing insight — one pattern, two levels

h has the SAME authored/positioned/invoked triple at two levels; the dictionary names the triple
once and everything else hangs off it:

| level            | container           | slot (authored, positioned)              | target (invoked)                 |
|------------------|---------------------|------------------------------------------|----------------------------------|
| inside a workflow| workflow definition | **step** `{id, activity, input}`         | **activity** (registered function)|
| inside a chain   | chain               | **member** `{kind, key\|steps, captures…}`| **workflow**                     |

A slot NAMES its target (a step's `activity:` field; a member's `key`) — which is why `-w KEY`
stays correct as-is: the flag names the target workflow, not the slot.

## Locked decisions (2026-07-24, with the user)

1. **step and activity both survive, sharpened** — a step is the authored slot; an activity is
   the registered function it invokes. Two steps routinely invoke one activity (feature's plan +
   implement both call `run-codex`; every panel branch calls a `run-*`), and Dapr itself keeps
   the split. The fix is consistent USE (prose saying "activity" for a step gets corrected), not
   a merge.
2. **The chain slot is `member`** — prose's de-facto winner becomes universal:
   `ChainWorkflow` → `ChainMember`, and the wire field `ChainRow.workflows` → `members`.
3. **All three migration tiers, atomic cutover** ([[atomic-cutovers]]): prose + internal
   identifiers + wire/durable shapes in one change set. Chain rows are short-lived, so the flag
   day is cheap now and gets cheaper never.

Sub-decisions taken by the plan (overturn at review if wrong):

- **"cron family" → "cron siblings"** — frees the retired word entirely (the docs already lean
  on "sibling"), so the vocab guard can ban `family` outright in long-lived docs.
- **"blackboard" is RETIRED; the term is "chain data"** (user decision 2026-07-24 — blackboard
  is unexplained AI-architecture jargon). Prose converges on the existing wire field `data`, so
  the synonym cluster dissolves instead of being renamed: "captures write the chain's data;
  inputs read it (dotted `id.field` data paths)". No field change. Only `workflows` → `members`
  changes on the wire, because there the word is WRONG, not merely terse. `blackboard` joins the
  guard's banlist.
- **`-w` stays** (names the target, see above); `-t` stays (template operands).
- **stage vs parallel group** — deliberately different words for the two levels' concurrency:
  a *stage* is a chain's concurrent member set; a *parallel group* is a workflow's concurrent
  step set. Never borrow across levels.
- **fire / run / invoke** — *fire* starts a workflow (fire-and-forget registration included);
  *run* is reserved for agent runs (the run ledger sense) plus the literal CLI verb
  `h workflow run`; *invoke* is Dapr transport only.

## The glossary (draft — canonical home will be ARCHITECTURE.md)

Primitives (already canonical, unchanged): **Template, Workflow, Watcher, Chain, Cron, Trigger,
Registry**. New sharp entries:

- **template** — the authored, parameterized, composable unit. A helm *chart* is the current
  authoring technology for templates, never a concept term.
- **workflow definition** — the steps blob a template renders to. **saved workflow** — a
  definition stored under a key. **instance** — one durable execution (`instanceId`).
- **step** — a definition's authored slot `{id, activity, input}`. **activity** — a registered
  function (`run-claude`, `setup`, `write-wf-row`) a step invokes.
- **parallel group** — a step whose `parallel:` fans branch steps through one whenAll.
  **branch** — one step inside it.
- **member** — a chain's authored slot `{kind, key|steps, stage?, id?, captures/inputs/until}`.
  **stage** — the set of members that run concurrently (cursor advances stage-by-stage).
  **kind** — a member's coded threading-contract selector.
- **chain data** — the chain's threaded state (the row's `data` field), two-level per D5;
  captures write it, inputs read it via dotted data paths. ("blackboard" is retired jargon.)
- **panel** — a roster-generated parallel group. **roster** — the plural `--agent` value.
  **panelist/branch** — one roster agent's step. **judge** — the pinned synthesis executor.
  **synthesis** — the judge step emitting the workflow's own contract.
- **fire / run / invoke** — as decided above. **agent run** — one activity's agent invocation
  (run ledger, `run:` mirrors, cost tally).
- **workspace** — an agent service's provisioned dir (`workspaceId ?? instanceId`).
  **worktree** — a git worktree inside the shared repo checkout.
- **cron siblings** — recur, discovery/fan-out, one-shot (`cron:sub`/`cron:discover`/`cron:sched`).

## Phases

1. [x] **Glossary lands in ARCHITECTURE.md** — a `## Glossary` section from the draft above
   (adjusted to survive review); CLAUDE.md's primitives index points to it.
2. [x] **Tier 1 — prose sweep**: CLAUDE.md, README.md, ARCHITECTURE.md, cli/README.md,
   docs/cookbook.md, skills (author-workflow-template, workflow-orchestrator, observe-h),
   apps/claude-agent/steering/h-runtime.md, CLI help/docstrings, comments. Kill the hop fossils
   (test names included), re-word "cron family" → siblings, correct step/activity misuse,
   member everywhere for the chain slot, blackboard → chain data everywhere (CLI help,
   chain_expr/chain.py docstrings, CLAUDE.md chain bullet, engine comments). docs/plans/ (historical logs) are EXEMPT — plans are
   records, not living docs.
3. [x] **Tier 2 — internal identifiers**: `ChainWorkflow` → `ChainMember` (+ `MemberMappings`
   audit — already right), `WORKFLOW_KINDS` → `MEMBER_KINDS`, chain_expr's `WorkflowRef` →
   `MemberRef` (+ its `workflows` property → `members`), engine locals/params named `workflow`
   that hold a member. File renames where the old word is the filename (`chain-workflows.ts` →
   `chain-members.ts`) included.
4. [ ] **Tier 3 — wire + durable**: `ChainRow.workflows` → `members` (schema + router + CLI
   body + viz consumer `web/` if it reads chain rows). Flag day: drain/terminate active chains
   before deploy (finalized rows with the old field remain as unreadable-by-new-schema audit —
   acceptable; note it in the cutover commit). Rebuild + recreate workflow-svc container.
5. [x] **The guard — `scripts/check-vocabulary.mjs`** (harden-by-encoding): bans retired/wrong
   terms in LONG-LIVED prose surfaces (CLAUDE.md, README.md, ARCHITECTURE.md, cli/README.md,
   docs/cookbook.md, skills/, steering; NOT docs/plans/). Initial banlist: `\bhop\b`,
   `\bfamily\b`, `\bblackboard\b`, `chain workflow` (the slot sense), plus a HINT list (warn-only) if useful.
   Banlist lives in the guard beside a pointer to the glossary; wired into root `lint`.
6. [x] **Sync-guard ripple**: test_kind_sync + any guard that greps renamed identifiers
   (`check-registry-writers`, `check-state-keys` are content-based — verify unaffected);
   goldens re-blessed only where rendered text legitimately changed.

## Acceptance

- `rg -w hop cli apps docs/cookbook.md CLAUDE.md README.md ARCHITECTURE.md` → nothing.
- `rg -w family` and `rg -w blackboard` over the guard's surfaces → nothing; `check-vocabulary.mjs` proves it fires on
  a fixture before landing.
- One triple table in ARCHITECTURE.md; CLAUDE.md/README use its words exactly.
- Engine + CLI test suites green; e2e smoke (a chain registers and advances) after the Tier 3
  flag day.

## Cross-links

- [[panels-as-a-modifier]] — introduced roster/panelist/judge/synthesis (already
  glossary-consistent).
- docs/plans/inline-chain-cron-composition.md — D3/D5 established stage/namespace vocabulary.
- The 2026-07-08 family→template migration — precedent, and the cautionary tale (its fossils
  motivated the guard).

## Log

- 2026-07-24 — Ideated with the user (survey: hop fossils, recycled "family", the five senses of
  "workflow"); three forks locked (keep step+activity sharpened; member; all-tiers atomic).
  Plan written, phased for h to execute.
- 2026-07-24 — "blackboard" retired by user decision; the term is **chain data** (prose
  converges on the wire field — the cluster dissolves rather than renames). Banlist updated.
- 2026-07-24 — Phases 1, 2, 3, 5, and 6 landed: the canonical glossary and prose sweep,
  member-oriented internal identifiers and filenames, vocabulary guard, and sync updates. Phase 4
  remains open; durable rows and HTTP bodies intentionally retain their `workflows` wire field.
