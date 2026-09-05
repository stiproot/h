# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [README.md](./README.md) for stack overview, dev setup, component reference, and tooling.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the primitives, the composition stack, and the principles.
See [docs/cookbook.md](./docs/cookbook.md) for h BY EXAMPLE — real, validated commands (each
stamped with date + artifact). When an e2e validates a new composition, lift its command there.
See [cli/README.md](./cli/README.md) for the local tooling — `cli/` is the h CLI and its
machinery: the `h` command itself (`cli/h/`, Typer + rich, a uv workspace member — `uv run h
--help`), the helm-templated workflow definitions (`cli/charts/`), and the run/invoke shell
scripts (`cli/scripts/`, the service bring-up + ops layer). The construction layers co-exist
deliberately; validated command examples live in [docs/cookbook.md](./docs/cookbook.md).
See [docs/DRIVER.md](./docs/DRIVER.md) if you are the DRIVER — the interactive supervisor session
that fires chains, reads verdicts, verifies at head, and merges. It is written so a FRESH session
can pick up that role from it plus durable state, with zero conversation history.
See [docs/gotchas.md](./docs/gotchas.md) for the KEY GOTCHAS in full — the traps this repo has
already paid for. The *Key gotchas* section at the end of this file indexes every one of them by
title; read the entry there before touching the thing it names.
See [docs/h-builds-h-runbook.md](./docs/h-builds-h-runbook.md) for standing up the self-improvement
loop, [docs/installing-h.md](./docs/installing-h.md) for installing h as tooling in a consumer repo,
and [docs/diagrams/README.md](./docs/diagrams/README.md) for the canonical diagram set.

**This file is loaded into EVERY agent session, so its size is a budget, not a detail.** It is
capped at 130,000 characters by `scripts/check-steering.mjs`; the harness itself refuses past
~150k. When it grows past the cap, the fix is never to delete knowledge — it is to move the DETAIL
to its one long-lived home (a doc, a skill, a guard's header comment) and leave a titled index line
here, the way *Key gotchas* and the `h` CLI command list already work.

## Ways of working

Four rules about HOW we build h, as opposed to what. They are here rather than only in a skill
because they govern every exchange, and a skill that waits to be triggered would miss most of
them. **The `ways-of-working` skill carries the detail** — the recipes, the reasoning, the worked
examples; this is the always-on summary.

1. **Explain in plain language; save the vocabulary for the artifact.** This repo's docs are
   deliberately dense and guard their own dictionary — correct for a file someone re-reads, wrong
   for a conversation someone reads once. While iterating, lead with what changes and why it
   matters, in words that need no glossary, and spend a clause defining an h term the first time
   it earns its place. The test is whether the reader could DISAGREE without first decoding you.
   Plain is not vague: numbers, paths and concrete behaviour are what make it convincing.
2. **Lead with a RENDERED diagram, and send it.** A mermaid fence is source code, not a diagram,
   and much of this work is read on a phone through a remote session. So: write the doc, render it
   (`uvx vizzle render …`), LOOK at the image, then put the file in front of the operator. See
   *Diagrams are the medium for design and architecture* below for where and when, and the
   `diagrams` skill for the rest.
3. **h is ours — improve it rather than work around it.** Friction that surfaces while doing
   something else is the most valuable thing that task produced; it has already been paid for.
   Fix it in the same change when it is small, file it with `h-issues` when it is one PR's worth,
   make it a plan when it needs a decision first, and delegate it to h itself when it is big
   enough (`h delegate`, `--local`, a chain). The failure mode is silent accommodation: adapting
   around a defect leaves no trace, so every later run pays it again.
4. **Missing tooling is priority work, not a detour.** About to do by hand what a tool should do,
   skip a check, or paste source where an image belongs? Build the tool first, then do the
   original work. A workaround is paid every time by everyone; the tool is paid once — and the
   workaround hides the gap, so it never gets fixed on purpose. Name the tooling a piece of work
   needs BEFORE starting and verify each piece actually runs here; a documented command is not
   evidence. Encode the fix where it fires again (a guard, a script, a make target, a skill).

## Plans

Non-trivial work is scoped and tracked in a plan doc — a living tracking log, not a
frozen spec. **Follow the `plan-management` skill** (provided by the `plan-management`
plugin — the generic lifecycle; this section is h's concrete policy). In short:
core/architecture plans are source-controlled (`docs/plans/<name>.md`
active → `docs/plans/impl/<name>.md` archived); domain-specific, local-only plans go
under the gitignored `docs/plans/domain/` (no archive lifecycle — delete or keep locally).
Never leave a plan in the harness scratch location (`~/.claude/plans/`). There is no
separate index file — the `docs/plans/` directory listing plus each plan's status line IS
the index (plans predating the convention, 2026-07-22, may lack status lines; retrofit
only when you touch one). A plan too large for one readable doc (several independent
areas/phases, or ~1000+ lines) becomes a directory: `docs/plans/<name>/README.md` (the
index — plan-level status + shared context) plus numbered parts (`01-<area>.md`, …), each
with its own status line; it archives as a UNIT (`docs/plans/<name>/` →
`docs/plans/impl/<name>/`), gated on every part being `Complete`. Before archiving a core
plan, **lift every piece of lasting context to its one long-lived home** (ARCHITECTURE.md,
a skill, a lint rule + CLAUDE.md, an auto-memory, or a code comment) — plans are
transient, so knowledge left inside one is lost when it's filed away. The same discipline
applies at WRITE time: **source code never references `docs/plans/*`** — state the
rationale in the comment itself or cite the durable home; `scripts/check-plans.mjs` fails
the build on a plan path in a source tree.

Every plan declares `Status:` (one of `Planning | Active | Blocked | Deferred | Complete`)
and `Established:`; a `Deferred` plan (parked, not abandoned) MUST carry a `Revisit when:`
line naming what brings it back; an archived one also declares `Lifted to:`.
**`scripts/check-plans.mjs` (in `bun run lint`) enforces all of that**, and additionally
the two REFERENCE rules that follow from plans being transient:

- **Nothing outside `docs/plans/` may reference a plan — not source, not steering docs, not
  READMEs, not skills.** A citation is a dependency, and a plan is by design written, archived,
  and forgotten; pointing contextual documentation at one guarantees it rots. State the fact
  where you are, or cite its durable home (ARCHITECTURE.md, this file, a skill, the cookbook,
  a lint rule). This is the lift-on-archive discipline applied at WRITE time, and it is why
  archiving a plan now touches only `docs/plans/`. (Tightened 2026-08-11 from the older
  "citations must resolve" rule, which merely coupled every archive move to a doc sweep.)
- **Inside `docs/plans/`, plans may cite each other** — they are transient together — **but a
  relative link whose target still exists elsewhere is rot, not staleness**, and fails the
  guard with the corrected path. An archive move gains a directory level and silently
  mis-levels every `../` link in the moved file; six such links had accumulated undetected.
  A link to something genuinely gone stays exempt: a plan is a point-in-time record.

Items an otherwise-finished plan parks go to the single carried-followups doc under
`docs/plans/`, not into a new near-empty follow-up doc.

**PLAN OR ISSUE — the selection test** (operator call 2026-08-21, optimized for the solo
operator + agent fleet; re-assess if human contributors arrive): *"Could an agent land this
as one PR from the text alone, with no decision left open?"* YES → a GitHub issue (the
`h-issues` shape — a unit of DELEGATION, loop fuel). NO → a plan (a `Deferred` stub with
`Revisit when:` if not now — the unit of THINKING). A finished plan's parked leftovers stay
carried-followups items. Two edges connect the routes, both legal, neither canonical:
an issue that turns out to need design either gets its decision made interactively or
GRADUATES to a plan — then the issue CLOSES with a "graduated" note (an open issue citing a
plan path is a reference that rots on archive; provenance flows the other way — the plan's
premise records the issue number). A hardened plan DECOMPOSES the other way: phases
reworded to pass the one-PR test become loop-implementable issues; the plan stays the
tracking log, the issues are its delegation surface. Design lives in repo files because the
guards, the `review-plan` machinery, and lift-on-archive are all file-based; issues stay
prompt-sized because their text is fed to an implementing agent.

**VALIDATE A PLAN BEFORE PICKING IT UP — it is a hypothesis with a date on it, not a work
order.** The `plan-management` skill's step 2 (*Pick up*) is the generic procedure and its
pick-up checklist is the gate; this is h's concrete policy. Picking up a plan, a plan stub, or
one item on one starts with a verification-and-grooming pass, never with its first step, and it
happens BEFORE anything is scoped from it (a spec, an issue, a branch) — nothing downstream
catches a bad premise, because a spec built on one reviews clean against itself. Two independent
questions, both required, neither implying the other:

- **Are its CLAIMS still TRUE?** (drift) Check the TREE, not the doc: do the files, activities,
  rows, flags and guards it names still exist and still look like that? Is what it proposes
  already landed? Seconds of grepping.
- **Is its GOAL still WANTED?** (premise) State what it was trying to achieve, whether its stated
  trigger has ACTUALLY fired, what real usage of the shape exists, and what has changed since it
  was written. Presence on a list is not a reason to build.

Deciding to drop or re-trigger is a normal, valuable outcome — record it in place with the
reasoning, exactly like a completion; correct drift in the doc BEFORE implementing from it. This
covers EVERY plan, not only parked ones: an `Active` plan resumed after a context reset is the
dangerous case, because it reads as live and current. (DRIVER.md carries the same two questions
as standing conventions for a driver session scoping a spec.)

Because the premise question needs something to interrogate, every open item carries a trigger
line (`Revisit when:` / `Revisit as part of` / `Not revisited unless`) and
**`scripts/check-plans.mjs` enforces that** — an item with no trigger cannot be interrogated at
all, only rediscovered and rebuilt on faith. That is as far as a machine reaches here: the guard
checks a plan is INTERROGABLE, never that anyone interrogated it — the same line it draws in
refusing to infer that a plan should be archived.

Both halves have bitten, separately. Claims: a 2026-07-27 batch scoped from two stale plan docs
produced a PR that redid finished work and was closed unmerged. Premise: carried-followups §2
(2026-08-12) passed every claim check while its stated benefit — six fewer CLI flags — was
something this repo actively does not want.

## Execution substrates

h composes work ONE way and executes it two. **[ARCHITECTURE.md](./ARCHITECTURE.md#execution-substrates)
compares the two substrates and says how to choose**; this section is the operational truth — the
prerequisites, the exact refusals, and the local substrate's own durability machinery.

**The runner is kept FRESH automatically** (2026-08-31): in a checkout, `runner_path` builds
`--filter=local-runtime` — the whole 7-package closure, since turbo's `build` declares
`dependsOn: ["^build"]` — before spawning it, so a `--local` run can never execute JS older than
the source you just edited. ~0.4s on an already-built tree. It goes through `bun run build` so
`check-tsc` runs first, and a 0-byte turbo (which exits nonzero printing NOTHING) is reported as
the hollow-toolchain failure it is rather than falling through to the stale artifact. The build is
a SEPARATE subprocess and the runner spawn is unchanged — wrapping it in `bun run` would put a
script runner between `run_job`'s SIGINT and node, and that signal is what makes agent-cli's
reaper group-kill the agent CLIs instead of orphaning ones that keep billing. Never fires for an
`H_LOCAL_BIN` override, an explicit `bin_path`, or a packaged install (no source, and its runner
ships beside the CLI so they cannot skew). `h doctor` reports `stale` from turbo's dry run, not
from mtimes, which lie across a branch switch.

Running locally needs a resident engine host for anything engine-shaped
(`h-local --engines`, brought up by `h events up`), and CLIs the operator has already
authenticated — credentials come from the shell with the repo's `.env` filling gaps (shell wins,
the opposite of `compose.sh`'s precedence, because a one-shot command must honour a key you just
exported).

What makes them symmetric is structural, not conventional, and it now covers BOTH halves of the
domain: what a DEFINITION means (`resolveRefs`/`resolveTokenString`, the output contract) lives once
in `packages/js/workflow-core`, and what an ENGINE decides (the registry rows, the ports, the five
pure `decide` functions, the per-tick scans, `planCron`, `goalResolved`) lives once in
`packages/js/engine-core`. `scripts/check-runtime-parity.mjs` fails the build if either grows a
private copy. **The engines are not workflow-svc's — workflow-svc is one HOST that supplies their
adapters**, and the local engine host is the other. A pure decision found sitting in an `apps/*`
domain folder that both hosts need is a parity bug that has not happened yet.

WHAT STILL DOES NOT TRANSFER, and why — the list is short and each entry names a real thing this
substrate lacks, not a gap waiting to be filled:

<!-- local-refusals:begin -->
- `--retry` and `--fallback-*` on a FOREGROUND local run: both RE-FIRE, which needs something
  that outlives the run, and nothing outlives a shell. (They work on relay-executed fires.)
- `--via` (routing through an agent service's babysitter) and `--fresh` (purge-and-rerun a durable
  Dapr instance): meaningless with no services and no Dapr instance registry.
<!-- local-refusals:end -->
- `run-itest` (needs an ephemeral k8s namespace), `gc-worktrees` (an agent SERVICE's shared
  workspace — `h worktrees sweep` is the local collector), and the service-only agents
  (`run-kimi`/`run-stub`/`run-dapr-agent`/…: no agent-cli strategy drives them).
- `write-wf-row` and `register-cron` AS STEPS — both are implemented here, but they are engine
  BRACKETS on either substrate, so a template naming one is a composition error rather than a
  capability gap.
- `h chain list --local`: local chains are DRIVER-sequenced and journaled today, so there is no
  `chain:sub` row to read. They work; they are just not engine-hosted.

`--watch`/`--budget` DO work on a foreground run, enforced by the driver between steps — it declines
to start more work past the deadline but cannot kill a running agent (the per-step timeout bounds
that), the same weaker-by-one-step rule the chain-wide budget applies between stages. Everything
else — `--cron`/`--max-fires`, `--at`/`--in`, discovery fan-out, the watcher's terminate/escalate —
now runs locally. The refusals are classified `pending` vs `permanent` in
`local-runtime/domain/activities.ts` and held to that shape by
`scripts/check-refusal-classification.mjs`, which also fails if a refusal outlives the engine it was
waiting for. Two more
local-substrate rules: `create-worktree` cuts from the checkout you point it at, and `setup` steps
are SKIPPED unless `--with-setup` — they provision the operator's own `~/.claude`, not a
container's. **WHICH checkout is a boundary, not a preference (symmetry with the other modes):
h works on ITS OWN clones under `H_WORKSPACE_DIR` (`h-workspace/<repo>` — the same shared
workspace root the service substrate's agents have always used), the worktrees it cuts from them
(`h-worktrees/`), and h's own repo. A work target anywhere else — most sharply, the operator's own
checkout of the same repo — is REFUSED by name** (`infrastructure/workspace.py`, wired into
`h delegate --cwd` and `h events serve --repo`; `--allow-external` is the deliberate override).
The reason is that a local agent runs as the operator with their credentials and no sandbox, so
the path someone typed is the only thing bounding the blast radius: clone the target under
`h-workspace/` and work there. (Bit us live 2026-08-10 — an agent reached a second clone of the
target repo and committed into the operator's in-flight work.) Local runs write the standard run ledger, so
`h runs`/obs-mcp/the viz read them beside service runs; there is no watcher, so that ledger plus
the RUN JOURNAL below are the whole accounting/durability story. The substrates COMPOSE: a
local-substrate agent inherits the repo's
`.mcp.json` (D5 leaves it alone) and can therefore save and fire durable workflows onto a running
service stack — triggers are data, so nothing cares who fired them. Surface: `h delegate` (the
atom), `h workflow run <template> --local`. Examples: [docs/cookbook.md](./docs/cookbook.md).

**The RUN JOURNAL (2026-08-14, operator call — the one deliberate NATS coupling):** `--local`
CHAIN and WORKFLOW runs journal to the fabric's third stream (`h-journal`, limits retention +
14d age cap, subject `h.journal.<group>`, `Nats-Msg-Id <group>:<seq>` dedup) so a dead driver's
paid work survives it — chains at STAGE granularity (the record snapshots the post-capture chain
data), workflows at STEP granularity (each parallel BRANCH its own record, serialized behind one
permit, so a dead panel re-pays only unfinished branches; the group map is reconstructed from
branches). `h chain run --local --resume GROUP` / `h workflow run --local --resume INSTANCE`
replay the journal, skip completed units with results reloaded, and continue — a definition hash
(chain: members+strategy+loop; workflow: steps; deliberately NOT budgets/params/seeds, which are
fire-time data) refuses a changed composition, and only `completed` writes a terminal record
(failed/exhausted/killed runs are exactly the resumable ones; resuming a completed one is a loud
no-op). The JS executor owns the records the way it owns the ledger (`local-runtime`
`nats-journal.ts`, publish-ack = the unit's completion barrier); the Python driver owns
preflight (`commands/_local_journal.py`) — auto-ensure the fabric (idempotent `h events up`
spawn) + the stream, REFUSING LOUD when the nats-server BINARY is missing (still
operator-provisioned; h manages only the process). `--no-journal` opts a run out;
`--resume`/`--no-journal` without `--local` are refused by name (the service substrate's
durability is the Dapr engine's). `h runs watch GROUP` replays a journal and follows it live
until the terminal record — run progress from any shell, ephemeral consumer, nothing durable
left behind. `h delegate` stays unjournaled (a single bounded run has nothing to resume).

**REGISTRY READS SELECT THEIR SUBSTRATE WITH `--local`** (2026-08-16), the same flag `h workflow
run` / `h chain run` already use: `h workflow list|get --local` reads the local saved-workflow store,
and `h agents list|deny|allow --local` reads and writes the local `exec:` row — the fence the local
executor and `h delegate` actually enforce. The flag is the selector rather than a config default or
auto-detection, because the source of an answer belongs in the command you typed, not in which
services happen to be up. `h cron list|discover add`, `h schedule list|rm` and `h watch list` all
answer locally too — their registries landed with the local engine host on 2026-08-17. What is
still PENDING refuses BY NAME and says which engine lifts it: today `h chain list --local` (the
chain engine and its `chain:` KV registry), plus `h agents budget --local`, which is a WATCHER
behaviour rather than a stored number. Answering with an empty table would assert "none
registered" when the truth is "no registry here". The pending set lives in ONE place —
`commands/_local_registry.py`'s `PENDING` map — and `scripts/check-refusal-classification.mjs`
cross-checks it against the runner's registry ops, so an entry that outlives its engine fails the
build instead of hiding a capability behind a message saying it does not exist. The CLI never speaks to JetStream directly: reads
and writes go through the runner as a `registry` job, because registry ids contain `:` (which NATS
forbids in a key) and a second copy of that codec in Python would drift, with an EMPTY listing as
its symptom rather than an error.

The local substrate also has an **event fabric** (`h events`, POC): one `nats-server -js` child (operator-provisioned binary,
refused loud by name; JetStream store beside the run ledger at `<workspace>/.nats`) carrying three
streams — `h-tasks` (work-queue retention on `h.task.>`), `h-results` (limits retention on
`h.result.>`), and `h-journal` (the run journal above — written by the local EXECUTOR, not the
relay). A task message is a FIRE DESCRIPTOR (`{template, params, agent, group, step,
maxSteps}` — the trigger payload made local); the RELAY (`h events serve`) is a durable pull
consumer that composes the template on fire and executes it through the local executor, exactly
like `--local`. The LOOP EDGE: an agent's structured block may carry `publish: {task, agent?}`
beside its contract fields (the subset validator allows undeclared keys) — the relay, not the
agent, publishes the next descriptor (mirroring chain-engine-fires-next-stage), burning one step
of the seed's MANDATORY `--max-steps` budget; no `publish` resolves the loop, a spent budget
exhausts it. Crash-safety: in-progress heartbeats extend the claim during long agent runs, ack is
the LAST effect, and `Nats-Msg-Id` = `<group>:<step>` dedups a redelivered step's re-publish so
the loop never forks. The relay is a trigger host, NOT an engine — it supervises/recurs/sequences
nothing. `serve` runs agents with the operator's env exactly like `h delegate` (e.g. codex needs
`CODEX_AUTH_MODE=chatgpt` exported in the serve shell). The relay PINS its workspace: `--repo`
names the clone (default the cwd's git root, refused loud if it is not a repo) and every group
runs in its own worktree cut from it (`h-worktrees/<group>`, branch `local/<group>`, reused
across the loop's steps); `--in-place` opts out for read-only loops. This is not tidiness — an
agent handed a workspace that contradicts its task GOES LOOKING for the right one, with the
operator's permissions and the whole filesystem to look through (bit us live 2026-08-10: a relay
started with the wrong cwd led an agent to find, branch and commit into a DIFFERENT clone of the
target repo). A true cwd is what removes the reason to wander.

The **BACK-EDGE** closes the fabric for a DRIVER (a session that fires work and must learn it
finished): every terminal lands on `h.result.<group>` carrying `status` (resolved | exhausted |
failed), `steps`, `agent`, the `answer`/`error`, and its accounting — `runId` + `costUsd`, folded
in from the local runtime's `WorkflowEnvelope.runs` so reacting to an event needs no second lookup
(absent cost stays ABSENT, never `$0`: a codex ChatGPT-plan run is unpriced, not free). Two
consumers read it, and the difference is the point: `h events await GROUP` is EPHEMERAL but
replays from the stream's start — a loop that finished before you asked still answers, and asking
leaves no durable behind; `h events results --durable NAME` is a DURABLE acked consumer that
resumes at its last ack, so terminals that landed while nothing watched are still delivered
(at-least-once — a watcher killed before its ack sees that terminal again). `tail` remains a plain
live subscription and misses whatever it was not present for; it is for watching, never for
waiting. This is what makes fan-out/join viable with no join primitive in the fabric: publish N
groups, then let the DRIVER be the joiner over one durable consumer.

## h primitives (vocabulary)

**[ARCHITECTURE.md](./ARCHITECTURE.md#primitives) defines what each primitive IS** — the
definitions, the authored-slot/target table, the composition stack, the principles. Read it there;
it is not repeated here. **This section is the RUNTIME INDEX for the same primitives: where each one
is implemented, which registry rows it owns, and what its CLI surface is** — the things you need to
change one, not to understand one.

- **Template** — the authored, parameterized, composable unit (a chart template is one way to
  author one). Templates overlay (⊕, merge by step id) into ONE workflow definition; publish-mode
  renders keep `{{params.*}}` slots open — including fire-time identity (runActivity/agentId/
  model…) with values-baked defaults. Surface: `h template compose|list|get`.
- **Workflow** — a durable step sequence that does work and leaves durable traces (Dapr instance
  status, run ledger + `run:<id>` mirrors, Zipkin spans, joined on `workflowInstanceId`). It never
  supervises anything, including itself.
- **Watcher** — a durable registration (`{subject, policy}`) plus a shared engine that, on a clock,
  reads a subject's already-persisted operational state, interprets it against the policy, and acts
  through a closed vocabulary (terminate own subject, record, publish, escalate). Judgment stays
  agent-side. IMPLEMENTED: the engine lives in workflow-svc (`domain/watch-*.ts`, scan on the
  workflow-cron-tick), rows are `watch:sub:<instanceId>` written by every fire path; the old
  in-process babysitter loops (JS + Python) are deleted — `POST /workflow` forwards a `watch`
  field. Inspect with `h watch list` or `GET /watch/list`.
- **Chain** — the sequencing sibling of the watcher: a durable registration `{workflows, strategy,
  data}` plus a shared engine that, on the same cron tick, reads the current STAGE's persisted state
  and acts through a closed vocabulary (advance/fire-next, join, finalize) — where a watcher RE-fires
  one instance, a chain FIRES THE NEXT stage. A chain is ordered STAGES, each stage a CONCURRENT set:
  members carry a `stage` (absent ⇒ member index =
  sequential), `cursor` is the current stage, and the engine joins on every member of a stage
  completing before advancing. State threads workflow-to-workflow through the row's two-level `data`
  (D5: a member's declared `captures` write under its own `id` namespace so concurrent members never
  clobber; a downstream `inputs` reads back a dotted `id.field` — flat when no id, the degenerate
  case), filled by the engine parsing each one's output (no actor) — STRUCTURED ONLY
  (marker parsing retired 2026-07-15): every chained
  template declares an `outputs:` schema and ends its agent step with a validated fenced json block
  (the `outputContract` step input → the run activities' rung-2 seam, `domain/structured-output.ts`;
  envelope gains `structured`), which the kind contracts read — chained workflows stay chain-agnostic.
  A member may be a saved `key`, an EMBEDDED `steps` blob (D1 inline storage, no publish), and/or a
  `cron` member that self-arms its OWN recurrence via the §10 arm-* pattern (armCron injected into its
  one fire); the chain never writes `cron:sub` and never re-fires it — it OBSERVES `wf:<member>.resolved`
  (D2/D4) and captures off that resolved run's `wf.output`. On a non-cron member's terminal-failure the
  chain fails as a UNIT (D6): it terminates the still-running siblings and PUBLISHES `cron-disarm` for
  every member-armed cron (a loose pub/sub edge — the disarm handler stays cron:sub's single writer)
  before finalizing. IMPLEMENTED: engine in workflow-svc (`domain/chain-*.ts`, scan on the
  workflow-cron-tick beside the watch scan), rows `chain:sub:<chainId>`; `h chain run` registers
  (fire-and-forget) via the chain EXPRESSION — ordered `-w KEY` / `-t ATOM…` members with
  position-scoped `--agent/--model/--fresh/--kind/--inline` flags, stage flags `--parallel` (infix) or
  `--stage N`, cron flags `--cron CADENCE`/`--max-fires N`, the namespace `--id NAME`, and
  **`--budget DUR`, whose meaning depends on its POSITION — the one flag in the expression that does**:
  a PREFIX budget is the whole-chain wall clock (`chain:sub`'s `budgetMs`, enforced by the CHAIN
  engine against the chain's `startedAt`), a SUFFIX budget bound to one member is that member's watch
  policy (`watch: {maxDurationMs}` on its entry → registered as an ordinary `watch:sub` row by the
  `fireWorkflow` → `invokeWithWatch` seam at its deferred fire, enforced by the WATCHER against the
  member's own `startedAt`). Two rows, two clocks, two engines, one 60s tick: they compose as
  whichever-trips-first, INDEPENDENTLY, and a budget-terminated member fails the chain as a unit via
  the D6 teardown. Because the positions mean different things, `budget` is deliberately EXCLUDED from
  `effective_config`'s chain-wide→member merge (`chain_expr.py`) — merging it would make a documented
  whole-chain budget silently arm a watch row on every member. `--budget` on a `--cron` member is
  refused (recurrence is the cron engine's business), as is a per-member budget on `--local` (no
  watcher exists there). A CHAIN-WIDE budget IS honoured on `--local`: the local driver mirrors
  the engine's wall-clock branch (it needs a deadline, not durability, and in-process the driver
  IS the supervisor), checking it BETWEEN STAGES — so it declines to start more work but cannot
  terminate a running agent, which the per-step timeout bounds instead, plus declarative
  threading mappings `--capture BB=FIELD / --input PARAM=SRC (SRC = flat key or dotted id.field) /
  --until PATH=VALUE` (validated at registration on BOTH sides: captures/until against the declared
  outputs schema, and every `{{params.X}}` a member's definition references against what its kind
  contract + declared inputs + seeds can supply — an unsatisfiable member is REFUSED before anything
  publishes, the template's `params:` block read as the optional-param contract; each declared half replaces its side of the kind
  contract) (suffix = that workflow, prefix = chain-wide default);
  a `-t` group overlays inline and publishes under `<slug>-w<N>` by default, or EMBEDS with `--inline`
  (compose-on-fire; at most ONE atom per composition declares `outputs`). `--agent` takes a ROSTER
  (greedy operands, the `-t` idiom): SEVERAL names PANELIZE the member (panel as cardinality, 2026-07-24): a pure CLI-side transform (`infrastructure/panelize.py`) replicates
  the member's contract-carrying step into a parallel step group (one branch per agent, contract stripped
  (model from `--model` applies to every branch, else stripped to each agent's own AGENT_MODEL),
  concurrency preamble injected) and appends a pinned-judge (claude) synthesis under the
  member's ORIGINAL id+contract — so every downstream seam (loop-until-clean, captures, watcher) is
  unchanged and the engine needs nothing new. Read/judge kinds only (write kinds share one worktree —
  compose N `--parallel` members instead); `--model` with a roster applies the model to every panelized
  branch; a roster forces compose-on-fire (a `-w` key renders its chart template — `panelSynthesis:`,
  the template's optional join-rule prose, flows from the render — else the stored def); the review-pr
  executor freeze relaxes to the named roster, the pin migrating to the judge. `h chain list` inspects.
  Strategies: `sequential`, `loop-until-clean`. Loop × stages is RECONCILED (2026-07-25): `loop.startCursor`
  is the review member's **STAGE**, not its member index — stages before the loop segment may be concurrent
  (the panels shape), stages inside the segment (`startCursor`..last) must be SINGLE-MEMBER, refused loud at
  registration. Fixed CLI-side in `chain.py`; the engine was unchanged.
- **Cron** — the recurrence sibling: a durable registration `{cadence, source, budget}` plus the same
  shared engine that, on the same cron tick, reads the target `wf:` row + the live instance and acts
  through a closed vocabulary (fire-again, deactivate) — where a watcher RE-fires one instance on a
  failure policy and a chain FIRES THE NEXT workflow, a cron RE-FIRES the SAME workflow on a clock
  until its GOAL resolves or a budget trips. The goal is the `wf:` row's `resolved` flag — a real
  state check (e.g. PR merged), DISTINCT from run-status `done` (the steps finished) — which the
  workflow reports via a `goal: RESOLVED` field in its validated structured output. A **discovery / fan-out** variant (rows
  `cron:discover:<repo>:<label>`, index `cron:discover-index`) does NOT re-fire one workflow: each tick
  it reads a SOURCE (open issues on a label, via git-core's `GitHubClient` behind an `ISourceReader`
  port) and fires ONE workflow per newly-seen item — serialized (one in flight), daily-capped, deduped
  against the `wf:*` keys (the h-builds-h issue loop; the retired `issue-sweep`'s discover half).
  IMPLEMENTED: engine in workflow-svc (`domain/cron-*.ts` recur, `domain/discover-*.ts` fan-out; scan
  on the workflow-cron-tick beside watch+chain), rows written ONLY by workflow-svc. **Registration is
  by ACTIVITY, not the fire handler** (the §10 `arm-*` pattern — see below): `--cron` on `h workflow
  run <key>` is armed by `generic.workflow`'s CLOSING bracket via the `register-cron` activity
  (idempotent ensure-exists, so a re-fire doesn't reset the budget); a discovery cron is armed by
  `h cron discover add <repo> --label --cadence [--workflow] [--max-per-day] [--run-budget-mins]`
  firing a one-step provision workflow whose `register-discover` activity writes the row (its own `wf:`
  row audits the registration). Inspect with `h cron list`; disarm with `h cron rm REPO SLUG WORKFLOW`
  (`POST /cron/disarm` — single-writer; sets inactive+disabled, keeps row for audit, epoch-fenced).
  Recur source modes: saved key + params, or
  an embedded definition (mode 3 dynamic-params deferred). A **scheduled-fire / one-shot** variant
  (rows `cron:sched:<id>`, index `cron:sched-index`; `domain/schedule-*.ts`) is the THIRD cron-siblings
  sibling: it fires one workflow exactly ONCE at an absolute `fireAt` (`decide` → wait | fire | expire;
  an optional `notAfter` expires a missed window), then deactivates — no cadence, no budget, no goal
  handshake, deliberately none of the recurring machinery. It is the shared spine for three consumers: **schedule-at-a-time** (`h workflow run <key> --at <iso> | --in
  <dur>` arms a row instead of firing now; `h schedule list|rm`), **pause/resume** (`h workflow pause
  <id> <key> --in <dur>` terminates the run and arms a continuation reusing its `workspaceId`;
  `h workflow resume <schedId>` fires it now — stop-and-continue, re-enters from step 1), and the
  **usage-limit fallback** (the watcher, on a `usage-limited` outcome, arms a deferred continuation
  under a different agent/model — `h workflow run … --fallback-agent openhands [--fallback-after 10m]
  [--fallback-max N]`). Fired continuations go through `invokeWithWatch` (supervised). Inspected via
  `h schedule list` (also surfaced in `h cron list`); disarmed with `h schedule rm <id>`
  (`POST /cron/sched/disarm`).
- **Trigger** — anything that fires a workflow: HTTP `/workflow/run*`, a `workflow-trigger` event
  `{key, params}`, or the cron tick over saved schedules. Triggers are data; one well-known topic.
  A trigger's PAYLOAD is the fire descriptor `{key|steps, params, instanceId (required-or-derived
  `<key>-<yymmdd>-<hhmmss>`, loud collision suffix — no Dapr-minted UUIDs, mark-before-fire holds
  on every path), workspaceId?, watch?}` — the `Trigger` type (workflow.model.ts), EMBEDDED by
  `WorkflowRequest` and `ChainMember` (which is how a member carries a per-member `watch?` policy)
  and PROJECTED per fire by the discover row (per issue) and the sched row's resubmit.
- **Registry** — durable rows under a claimed prefix in the flat Redis keyspace plus an index key
  (the `__workflow_index__` pattern): saved workflows, `run:*` mirrors, `watch:*`,
  `chain:*`, `cron:*` (recur rows `cron:sub:*` + the discovery/fan-out cron's `cron:discover:*` /
  `cron:discover-index` + the one-shot scheduled-fire cron's `cron:sched:*` / `cron:sched-index`),
  `wf:*` (per-RUN status rows, `wf:run:<instanceId>` — re-keyed 2026-08-17 from the artifact tuple, so a re-run never overwrites its predecessor and the subject (repo/slug/workflow) plus the PARENT stamp (chainId/cronId/schedId/discoverId) ride as fields; every reader DERIVES the id it wants, which is what the re-key turned on, each
  written by the workflow that names it — via its own `write-wf-row`/`register-*` activities, §10),
  and `exec:` (the executor policy — the single row `exec:config`, entries
  `{name, reason: operator|usage-limited|cost-budget, deniedAt, until?}` (bare shortname strings
  read as operator entries) plus a per-executor `budgets` table ({shortname: dailyBudgetUsd});
  written only by workflow-svc: `POST /exec/policy`, `POST /exec/budget`, and the watcher's two
  auto-fences — AUTO-DENY, an expiring usage-limited entry when a run finalizes usage-limited, and the DAILY-BUDGET fence,
  a cost-budget entry expiring at the next UTC midnight
  when the day ledger's per-agent tally crosses the executor's budget. Both never downgrade an
  operator entry and are idempotent across ticks; a SAME-agent fallback continuation is
  deliberately refused while a fence holds — fail-fast. The activity-registry gate wraps every
  `run-*` activity and REFUSES a denied executor loudly at fire time on every path — chains,
  crons, watcher re-fires, sched continuations, fallback switches, panel branches. Surface:
  `h agents list|deny|allow|budget` (all but `budget` take `--local` — see below; operator denies never expire; allow lifts any kind; list
  shows budget vs today's tallied spend + gap-run count), and **`quota:` (the OBSERVATION
  registry, 2026-09-03 — one row per executor, `quota:<shortname>`, holding the account's
  rate-limit windows exactly as the agent CLI last reported them: `{status:
  allowed|allowed_warning|rejected, windows: {five_hour|seven_day: {utilization, resetsAt}},
  observedAt, runId}`. Claude's CLI emits `rate_limit_event` on its stream; agent-cli parses it
  into `InvocationResult.quota`, the run ledger carries it, and the host that finalizes the run
  writes the row — workflow-svc's WATCHER on the service substrate, the local EXECUTOR on
  `--local`. It is an observation, never a decision: the QUOTA GATE (`decideQuota`,
  engine-core `quota.ts`) reads it BEFORE a `run-*` fire and REFUSES BY NAME (naming the window,
  the observation, the reset, and every way past it) when the last report was `rejected`, or when
  the window's utilization plus what one step of that executor tends to spend (the mean of the
  row's per-run `history`, else a default) would cross the ceiling — 100% under `fail`, 90% under
  `wait`, because a step that starts at 95% dies half-done. Stale-in-favour: a row whose
  `resetsAt` has passed lets the fire through and the provider adjudicates. `--on-quota
  fail|wait` (default `fail`) and `--ignore-quota` ride the FIRE DESCRIPTOR (`Trigger.quota`, so a
  saved key, an inline body, every chain member and a sched continuation all carry it, and the
  generic workflow stamps it onto each step's input); `wait` on `--local` sleeps between steps
  until the earliest reset (≤ 6h), and on the service path implies `--watch` with
  `onQuota: wait`, so a usage-limited finalize arms a same-identity `cron:sched` continuation at
  reset + slack (`maxQuotaWaits` counts down) instead of only auto-denying. The AUTO-DENY fence
  itself now expires at the observed reset + 60s rather than a fixed hour. Read surfaces:
  `h agents list [--local]` (one `quota:` line per executor under the table), `h doctor`, and
  `GET /exec/policy`'s `quota` field. The point is that a driver can PLAN around a window it can
  see — fire before it closes, schedule past it, or route the next run to another executor —
  instead of discovering it from a failed run)**.
  The convention: a registry prefix names the single component that owns writing it.

Watcher, chain and cron are one build-pattern instantiated three times — ARCHITECTURE.md states the
shape and the invariant it protects. The runtime consequence to hold onto here: watched/chained/
cron'd workflows never depend on their engines, and only judgment consumers read the rows. (It is
also why sequencing is its own Chain primitive rather than an overload of the watcher's `escalate`.)

**Registration follows the §10 `arm-*` pattern (registry state is created by ACTIVITIES).** A
workflow arms its OWN follow-on cron via a `register-cron`/`register-discover` activity (siblings of
`write-wf-row`): it is a CLIENT of the cron primitive, not the engine — recurrence still lives in the
engine on the tick. WHERE a registration happens is an ORDERING question, not edge-vs-activity: crons
are armed by the run (after its work; idempotent ensure-exists; LOUD, so a failed arm records
`wf:failed`), while the **watcher alone** is registered in the fire handler BEFORE the run
(`invokeWithWatch`, persist-then-invoke) — because supervision must precede what it supervises. The
edge FIRES workflows; it no longer writes cron rows (`POST /cron/discover` was deleted). See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full treatment.

## App layouts

```
apps/claude-agent/src/                    # claude-agent
├── index.ts                              # composition root – registers shared agent-server routes + /clone + /worktree + /workflow (babysitter), fatal crash handlers, starts Fastify
└── infrastructure/claude-runner.ts       # IAgentRunner impl; honours an optional cwd (e.g. a worktree); merges MCP config into cwd; routes (/run, /setup, /clone, /worktree, /dapr/subscribe) come from agent-server

apps/openhands-agent/src/                 # openhands-agent
├── index.ts                              # composition root – registers shared agent-server routes, starts Fastify
└── infrastructure/openhands-runner.ts    # IAgentRunner impl; /run, /setup, /dapr/subscribe come from agent-server

apps/pi-agent/src/                        # pi-agent — pi CLI coding agent
├── index.ts                              # composition root – registers shared agent-server routes, starts Fastify
└── infrastructure/pi-runner.ts           # IAgentRunner impl using PiInvokerLive; no MCP provisioning (pi has no MCP)

apps/codex-agent/src/                    # codex-agent — OpenAI Codex CLI coding agent (Fastify + Dapr sidecar)
├── index.ts                              # composition root – registers shared agent-server routes + /clone + /worktree + /workflow (babysitter), starts Fastify; uses makeTracingLive("codex-agent")
└── infrastructure/codex-runner.ts        # IAgentRunner impl using CodexInvokerLive (agent-cli); honours optional cwd/model; /run, /setup, /dapr/subscribe come from agent-server

apps/kimi-agent/src/                      # kimi-agent — Claude Code CLI × Moonshot Anthropic-compat endpoint (Fastify + Dapr sidecar)
├── index.ts                              # composition root – registers shared agent-server routes + /clone + /worktree + /workflow (babysitter), starts Fastify; uses makeTracingLive("kimi-agent")
└── infrastructure/kimi-runner.ts         # IAgentRunner impl using ClaudeInvokerLive (agent-cli); custom runner bypasses LiteLLM preflight; /run, /setup, /dapr/subscribe come from agent-server

apps/stub-agent/src/                      # stub-agent — deterministic itest-only agent (no LLM, no secrets); Fastify + Dapr sidecar
├── index.ts                              # composition root – registers shared agent-server routes + /workflow (babysitter), starts Fastify
└── infrastructure/stub-runner.ts         # IAgentRunner impl; returns a canned structured output satisfying the smoke outputContract; run-stub activity invokes this service via Dapr

apps/dapr-agent/src/                      # dapr-agent (thin wrapper over agent-core)
├── main.py                               # composition root – registers shared agent-server routes + /workflow (babysitter); opt-in workflow orchestration when WORKFLOWS_MCP_URL is set (merges the workflow toolset + appends the workflow-orchestrator skill)
├── infrastructure/dapr_agent_runner.py   # IAgentRunner impl – delegates to agent_core's ReAct loop (OpenAIChatAdapter); merges the workflow-mcp toolset when enabled
└── infrastructure/tools.py               # search_skills, install_skill, read_skill, write_file
                                          # /run, /setup, /dapr/subscribe come from agent_server (packages/py)

apps/dapr-claude-loop-agent/src/          # dapr-claude-loop-agent
├── main.py                               # FastAPI composition root – registers shared agent-server routes
├── infrastructure/claude_loop_runner.py  # Anthropic SDK agentic loop (tool-calling)
└── infrastructure/tools.py               # search_skills, install_skill, read_skill, write_file
                                          # /run, /setup, /dapr/subscribe come from agent_server (packages/py)

apps/claude-managed-agent/src/            # claude-managed-agent
└── main.py                               # Claude Managed Agents + Dapr Workflow integration

apps/langgraph-agent/src/                 # langgraph-agent (pure LangChain/LangGraph)
├── main.py                               # FastAPI composition root – bespoke routes + shared setup/subscribe
├── infrastructure/graph_builder.py       # build_react_agent – config → LangGraph create_react_agent
├── infrastructure/langgraph_runner.py    # IAgentRunner adapter – builds graph, ainvoke, extract output
├── infrastructure/tools.py               # tool registry (search_skills, install_skill, read_skill, write_file)
├── infrastructure/preset_store.py        # named graph configs as JSON under AGENT_BASE_DIR/presets/
├── domain/models.py                      # GraphConfig + AgentRequest (extends agent_server.AgentRequest)
└── presentation/http/run_router.py       # register_langgraph_routes – bespoke POST /run, POST /save
                                          # /setup, /dapr/subscribe come from agent_server (packages/py)

apps/workflow-agent/src/                  # workflow-agent (thin wrapper over agent-core; NOT the exclusive workflow entry point — every agent service has the standard /workflow endpoint)
├── main.py                               # FastAPI composition root + /workflow (babysitter); system prompt loaded from the workflow-orchestrator skill (agent_core.load_skill_instructions; AGENT_SYSTEM_PROMPT overrides)
├── infrastructure/workflow_agent_runner.py  # IAgentRunner impl – delegates to agent_core's ReAct loop over the workflow-mcp toolset
├── infrastructure/statestore.py          # task read-write via Dapr state API
└── presentation/http/cron_router.py      # POST /cron-tick (cron binding target), POST /run, GET /dapr/subscribe (empty — the plugin-feedback flow moved to workflow-svc's workflow-trigger topic + the improve-plugin chart template)

apps/workflow-svc/src/
├── index.ts                                          # registers workflow + activities + cron/watch/chain routes, wires the store/source-reader layers, starts Fastify
│   # NO domain/ — this service has none, and that is the point. Its whole domain (rows, ports,
│   # the five `decide` functions, and the per-tick SCANS that walk each registry) lives in
│   # packages/js/engine-core, because none of it is Dapr- or service-shaped. workflow-svc is a
│   # HOST: it supplies the adapter set, runs the scans on the Dapr cron tick, and serves HTTP.
├── presentation/http/
│   ├── workflow.router.ts                            # POST /workflow/run, /save, /run/:key (fire-time params + instanceId/workspaceId/fresh/watch/cron overrides → threads wf identity + armCron; --cron armed by the RUN, not here; `at`/`in` instead ARM a cron:sched one-shot and return {scheduled,fireAt}), /pause/:instanceId (terminate + arm a resume continuation reusing workspaceId) + /resume/:schedId (advance the sched fireAt to now), /terminate/:instanceId; GET /list, /get/:key, /status/:instanceId; /dapr/subscribe declares workflow-trigger + cron-disarm
│   ├── {watch,chain}.router.ts                       # GET /watch/list, /chain/list (+ GET/DELETE /watch/:instanceId) — registry read surfaces
│   ├── trigger.router.ts                             # POST /workflow-trigger (pub/sub target) – {key, params} events fire the named saved workflow; payload problems ack, infra failures 500 (redeliver)
│   └── cron.router.ts                                # POST /workflow-cron-tick – fires due saved workflows then runs the watch+chain+cron+discover+sched scans (each's failure never fails the tick); GET /cron/list (recur + discover + one-shot cron:sched rows); POST /cron/sched/disarm (disarm a scheduled fire by id); POST /cron-disarm (cloudevents pub/sub target — a finalizing chain's cron teardown, D6; single-writer disarmEventEffect reusing disarmCron). NO POST /cron/discover (§10 — registration is an activity)
├── infrastructure/
│   ├── dapr-workflow-invoker.ts                      # DaprWorkflowClient wrapper (+ raw-HTTP terminate/purge/status)
│   ├── dapr-workflow-store.ts                        # saved-workflow store (Redis): save/get/list/listScheduled/markRun
│   ├── dapr-{watch,chain,cron,wf,exec-policy}-store.ts # the registry stores (Redis) — watch:*, chain:*, cron:* (recur + cron:discover:* + cron:sched:*), wf:* (exact-key, no index), exec:config; only workflow-svc writes these
│   ├── dapr-event-publisher.ts                       # the pub/sub adapter — terminal workflow-events, the chain's cron-disarm teardown
│   #  (the ISourceReader adapter is NOT here: GitHubSourceReaderLive lives in git-core, so the local
│   #   substrate's engine host gets the discovery cron's GitHub read from the same place)
│   ├── activity-runtime.ts                           # the activity→Effect bridge (shared ManagedRuntime); ActivityEnv widened with CronStore/WorkflowInvoker/WorkflowStore for the arm-* activities
│   ├── activity-registry.ts                          # maps activity name → function
│   └── activities/
│       ├── setup / clone-repo / create-worktree / run-{claude,codex,openhands,pi,dapr-agent,dapr-claude-loop,claude-managed,langgraph,kimi,stub} / copy-session .activity.ts  # provisioning + agent-run + output-copy; every run-* agent activity honors an optional outputContract step input (validated fenced json → envelope `structured`, mismatch fails the step)
│       ├── run-itest.activity.ts                        # integration-test gate (D7 isolation: harness materialised from origin/main, never the worktree); input: {worktreePath, skip?, skipReason?, traceparent?} — no outputContract (throws on non-zero exit, classified infra/assertion/timeout)
│       ├── write-wf-row.activity.ts                  # the run writes its OWN wf: row (running→done/failed + structured goal: RESOLVED); BEST-EFFORT (§3/§10)
│       ├── register-cron.activity.ts                 # §10 arm-* : arm a recur cron from the run's closing bracket (planCron + guard: the structured block's `pr` for arm-revise-pr); LOUD, idempotent
│       ├── register-discover.activity.ts             # §10 arm-* : a provision workflow's step that registers a discovery cron (fired by `h cron discover add`); LOUD
│       └── gc-worktrees.activity.ts                  # collect the worktrees h finished with: invokes an agent's POST /worktree/gc. Targets an AGENT because the shared workspace is on the agent services' filesystem (workflow-svc mounts NONE of it), and is ordinary WORK fired as a workflow step — never an engine action: collecting at finalize would collect exactly the runs that finalized, while the ones that leak worst are the ones that DIED (plus standalone runs, which have no chain at all). Normalizes `-p` string params to the route's typed contract
└── infrastructure/workflows/
    └── generic.workflow.ts                           # step-sequencing workflow with $ref/{{token}} resolution; brackets a wf-identified run write-wf-row(running)→steps→arm-cron(if armCron)→write-wf-row(done|failed); resolves the activity NAME too (fire-time identity — unresolved token fails loud); a step may instead be a PARALLEL GROUP {id?, parallel:[steps]} fanned out through ONE whenAll (branches resolve against pre-group results only, land under branch ids + a {branchId: result} map under the group id; since 2026-07-24 groups are GENERATED by the CLI's panelize transform from an `--agent` roster, e.g. `-w answer --agent claude codex --parallel -w answer --agent claude pi` two panels in one stage — the hand-built agent-panel template/kind is retired)

apps/obs-mcp/src/                         # obs-mcp – read-only observability MCP (no Dapr sidecar; port 8013)
├── index.ts                              # composition root – Fastify/MCP; reads ZIPKIN_URL, LOKI_URL, AGENT_RUNS_DIR
├── domain/ports/IObservabilityService.ts # outbound port – traces, logs, run ledger
├── infrastructure/observability-service.ts # Zipkin (HTTP) + Loki (HTTP) + run-ledger (fs) reader
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: trace_search, trace_get, logs_query,
                                          #          runs_list, run_get, system_overview

apps/workflow-mcp/src/                   # workflow-mcp – MCP server for agents
├── index.ts                              # composition root
├── infrastructure/dapr-workflow-service.ts  # calls workflow service via Dapr invoke
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: save_workflow, run_workflow, run_saved_workflow
                                          #          (all params-aware; run tools take a watch policy — durable watcher registration;
                                          #          run_saved takes instanceId/workspaceId/fresh/watch overrides),
                                          #          list_workflows, get_workflow, get_workflow_status,
                                          #          await_workflow (block until terminal, else TIMEOUT),
                                          #          terminate_workflow (short-circuit a running instance)

apps/dapr-mcp/src/                        # dapr-mcp – MCP server for Dapr state stores + actors + pub/sub
├── index.ts                              # composition root – starts GenericActor host, then Fastify/MCP
├── domain/ports/
│   ├── IStateStore.ts                    # outbound port – state store
│   ├── IActorStore.ts                    # outbound port – actor management
│   └── IPubSub.ts                        # outbound port – publish to a topic
├── infrastructure/
│   ├── dapr-state-store.ts               # Dapr state HTTP API (get/getBulk/save/delete)
│   ├── dapr-actor-store.ts               # actor adapter – delegates to core-dapr GenericActorClient
│   └── dapr-pubsub.ts                    # pubsub adapter – delegates to core-dapr DaprPublisher
└── presentation/http/mcp.router.ts       # GET /sse, POST /messages, GET /dapr/subscribe
                                          # exposes: state_get, state_get_bulk, state_save, state_delete,
                                          #          pubsub_publish,
                                          #          actor_invoke, actor_state_{get,set,delete,keys},
                                          #          actor_{reminder,timer}_{register,unregister}, actor_list_active

packages/js/agent-cli/src/
├── index.ts       # exports all strategies
├── invoker.ts     # spawns CLI subprocess, pipes stdout/stderr, streams events
└── agents/
    ├── claude.ts      # ClaudeStrategy – claude CLI flags, JSONL stream parser
    ├── openhands.ts   # OpenhandsStrategy – openhands CLI flags, per-line stdout parser with onEvent callback
    ├── pi.ts          # PiStrategy – pi CLI --mode json JSONL parser; BYOK provider env routing
    ├── classify-stop.ts # classifyStop → StopReason (completed|usage-limited|timeout|failed): the usage-limit signal, positive-match-only over exit/signal/stderr/result-event (context-window excluded). Wired into parse-stream's buildInvocationResult → InvocationResult.stopReason (orthogonal to success); the usage-limit fallback reads it off the run: mirror
    ├── shared.ts      # shared env helpers
    └── types.ts       # AgentInvoker, AgentEnv/AGENT_ENV_KEYS, LlmConfig, ModelUsage, StopReason, strategy contracts

packages/js/agent-server/src/                # shared HTTP contract for agent services
├── index.ts          # re-exports
├── agent-routes.ts   # registerAgentRoutesEffect – POST /run, POST /setup, GET /dapr/subscribe (workspace dir via resolver, or an explicit cwd e.g. a worktree; /setup idempotent via spec-hash sentinel)
├── clone-route.ts    # registerCloneRouteEffect – opt-in POST /clone (shallow git clone into the workspace)
├── worktree-route.ts # registerWorktreeRouteEffect – opt-in POST /worktree (git worktree of a pre-cloned repo at a shared, agent-neutral path; idempotent; an optional `seed` list copies repo-relative gitignored files from the clone via git-core's seedWorktree; returns { worktreePath, seeded })
├── gc-route.ts       # registerGcRouteEffect – opt-in POST /worktree/gc, the collector for what /worktree creates, HERE because this is where the workspace is. Sweeps THIS service's own shared root (a caller cannot name a directory); params only ever make it collect LESS, and it always spares the caller's own workspace. Returns the full report — what it removed AND what it refused, with reasons
├── workflow-babysitter.ts # WorkflowBabysitter – submit-and-FORWARD (post-watcher-cutover): translates policy.maxDurationMs into a watch field on the run body (an explicit watch field wins); supervision is workflow-svc's durable watcher engine, no in-process loop; plain fetch, injectable for tests
├── workflow-route.ts # registerWorkflowRoute – the standard agent-service workflow endpoint: POST /workflow {key|steps, params?, instanceId?, workspaceId?, policy?|watch?, watchMeta?} → 202 {instanceId, watching}; GET /workflow/watches proxies workflow-svc's /watch/list (durable global truth)
├── git-auth.ts       # resolveGitAuth – the wire's auth NAME ('pat' | 'ssh') → a git-core GitAuth strategy; secrets stay in the service's env (GH_TOKEN / GIT_SSH_KEY_PATH), never on the wire
├── run-handler.ts    # the Fastify↔Effect bridge — the ONLY place runtime.runPromise touches an inbound request; a ParseError becomes a real 400, tagged domain errors and defects become 500
│                  #  (the run ledger is NOT here: it lives in packages/js/run-ledger so a non-HTTP
│                  #   agent host gets it without fastify — agent-server re-exports it unchanged)
└── runner.ts         # IAgentRunner port (run request → response)

packages/js/core/src/
├── index.ts               # re-exports (mergeMcpConfig, provisionMcpConfig, AgentRequest, AgentResponse, AgentRunError, …)
├── mcp-config.ts          # mergeMcpConfig – deterministic merge of h's mcp servers into a project's .mcp.json; provisionMcpConfig – Effect that provisions the run cwd's .mcp.json from src per mode
└── types/agent.ts         # AgentRequest (+ workspaceId), AgentResponse (+ costUsd, toolCalls, runId)

packages/js/core-dapr/src/
├── index.ts               # re-exports
├── invoker.ts             # DaprInvoker – typed wrapper over the Dapr sidecar invoke HTTP API
├── publisher.ts           # DaprPublisher – pub/sub publish over the sidecar HTTP API (traced)
└── actors/                # reusable Dapr actor SDK machinery (consumed by dapr-mcp)
    ├── generic-actor.ts   # GenericActor extends AbstractActor – KV state, invoke commands, reminders/timers
    ├── actor-host.ts      # createActorHost – DaprServer registration + start ordering
    ├── actor-client.ts    # GenericActorClient / createGenericActorClient – client proxy + reminder/timer
    └── wait-for-sidecar.ts # /v1.0/healthz/outbound poller

packages/js/core-vercel/src/
├── index.ts               # re-exports
├── llm-client.ts          # ILlmClient interface
└── vercel-ai.ts           # VercelAiClient – Vercel AI SDK generateText via LiteLLM proxy

packages/js/workflow-core/src/             # substrate-INDEPENDENT workflow execution semantics: what a definition MEANS, owned once and imported by both executors (guarded by scripts/check-runtime-parity.mjs)
├── index.ts               # re-exports
├── models.ts              # the DEFINITION shapes — WorkflowParams, StepDefinition, ParallelGroup, WorkflowStep, AgentResult. Re-exported by engine-core's workflow.model.ts and by workflow-mcp's wire shapes
├── resolve-refs.ts        # resolveRefs ({{stepId.field}} + {"$ref": …}, recursing into nested values) and resolveTokenString (the activity-name case — an unresolved token throws, never a silent "")
└── structured-output.ts   # the output-contract seam: fail-closed JSON-Schema SUBSET validator + last-fenced-```json extraction; applyOutputContract attaches the validated block as `structured` or fails the step

packages/js/engine-core/src/               # substrate-INDEPENDENT ENGINE semantics — workflow-core's sibling: that one owns what a DEFINITION means, this one owns what an ENGINE acts on. Extracted from workflow-svc because the five engines are pure `decide` functions over these rows, and a second substrate could not reach them while they lived in one app (guarded by scripts/check-runtime-parity.mjs)
├── index.ts               # re-exports
├── models/watch.model.ts     # the watcher primitive's shapes: WatchPolicy (maxDurationMs, retry, escalate), WatchRow (epoch-fenced), WatchConfig, WatchLedger
├── models/chain.model.ts     # the chain primitive: ChainRow {workflows, cursor=STAGE index, data (two-level, D5), strategy}, ChainMember {kind, key? XOR steps? (inline), stage?, id? (namespace), cron?, captures/inputs/until}; validateChain (contiguous stages, key/steps XOR, cron⟹inline); ChainStrategy (sequential | loop-until-clean); re-exports workflow-core's stage helpers (stageOf/membersInStage/lastStage); CRON_DISARM_TOPIC lives in cron.model
├── models/cron.model.ts      # the recur cron: CronRow, CronSource (saved | embedded), CronBudget, cronId; config/heartbeat/ledger (shared with discovery)
├── models/discover.model.ts  # the discovery/fan-out cron: DiscoverRow {repo,label,workflow,gates,source:github-issues,watch?}, discoverId, issueSlug/issueInstanceId
├── models/schedule.model.ts  # the one-shot scheduled fire: SchedRow, SchedTrigger, schedId
├── models/wf.model.ts        # per-RUN status registry (`wf:run:<instanceId>`): WfRow (status + resolved goal flag + subject + output + parent stamp), WfParentage(Fields), WfIdentity, wfRunKey, wfIdentityFrom. Re-keyed 2026-08-17 — the header explains why the artifact key had no reader that needed it
├── models/exec.model.ts      # the executor policy: DeniedEntry, ExecPolicy, EXEC_POLICY_KEY
├── models/workflow.model.ts  # the fire descriptor (Trigger/TriggerFields), WorkflowRequest (+ watch/watchMeta, wf identity, armCron closing-bracket cron), SaveWorkflowRequest, StoredWorkflow (+ outputs) / WorkflowSchedule, toRequest, deriveInstanceId. Here rather than beside an HTTP router because an engine's whole action vocabulary is "fire this" — a chain advance, a cron re-fire and a sched fire all produce a Trigger. Re-exports workflow-core's definition shapes
├── ports/I{Watch,Chain,Cron,Wf,ExecPolicy}Store.ts, ISourceReader.ts, IWorkflowStore.ts, IWorkflowInvoker.ts  # what an engine needs FROM its host; each host supplies one adapter set and the engines never learn which substrate they are on. (invoker: invoke/getStatus/terminate; cron store also serves discover rows cron:discover:* and one-shot sched rows cron:sched:*; ISourceReader is the discovery cron's enumeration seam — listOpenIssues, oldest-first — keeping the core free of any GitHub type)
├── {watch,chain,cron}-engine.ts  # pure decide per primitive — supervise | sequence | recur; unit-tested policy surfaces
├── discover-engine.ts        # pure decide(row, runtimeStatus, todayFires, now) → wait | discover (in-flight serialize → cadence → daily-cap)
├── schedule-engine.ts        # pure decide(row, now) → wait | fire | expire
├── scheduling.ts             # the recurrence clock — isDue / assertValidCron / parseDurationMs / resolveFireAt (pure, unit-tested)
│                             # NOTE: every engine names its function `decide`, so the barrel qualifies them —
│                             # decideWatch / decideChain / decideCron / decideDiscover / decideSchedule
├── watch-scan.ts             # registerWatchForFire + invokeWithWatch (the WATCH fire choke point) + scanWatchesEffect (terminate/retry/escalate/cost-tally/publish)
├── chain-scan.ts             # chain registration + per-tick STAGE progression (observe every current-stage member → join → capture all → fire next stage); inline(steps)/saved(key) fire + armCron for cron members; observeMember cron branch reads wf:resolved; atomic-failure teardown (terminate siblings + publish cron-disarm); STRUCTURED-ONLY threading (stepStructured/contractFor from workflow-core; declared captures namespace under member id (D5), inputs resolve dotted paths; no marker parsing — retired 2026-07-15) (no actor). Kinds (`MEMBER_KINDS` / `ChainMemberKind`, closed literal — a novel kind is added on BOTH sides, engine + CLI): `implement-pr`, `review-pr`, `revise-pr`, and `answer` (the bare "answer this task" member — coded contract reads a `task`, captures the structured `answer`; identity is ordinary fire-time params, and an `--agent` roster panelizes it at fire time. Successor of the retired hand-built `agent-panel` kind — subsumed 2026-07-24 by panels-as-a-modifier)
├── cron-scan.ts              # registerCronForFire (IDEMPOTENT ensure-exists — §10) + scanCronsEffect (recur fire/deactivate, epoch-fenced)
├── discover-scan.ts          # registerDiscover + scanDiscoverEffect (read source after gates=budget → dedup by exact-key wf: read → fire OLDEST eligible, supervised if watch set)
├── schedule-scan.ts          # the one-shot cron:sched variant: arm/disarm/advance + per-tick fire-once-then-deactivate (fires via invokeWithWatch). Spine for --at/--in, pause/resume, usage-limit fallback
├── exec-policy.ts            # the executor policy's pure half — normalize/merge denies, the two auto-fences' merges (usage-limited, daily budget), executorFrom{Activity,AgentId}
├── internal.ts               # the primitives barrel the scans import. SEPARATE from index.ts because index.ts exports the scans: importing the public barrel from inside would make the package cyclic
└── ../.dependency-cruiser.cjs # (at the PACKAGE root, not src/) engine-core-is-pure — this package is imported by EVERY host, so one I/O dependency would pin all of them to a substrate. Extends the root config; patterns shared via scripts/dep-io-patterns.cjs

packages/js/run-ledger/src/                # the run ledger, extracted from agent-server so a non-HTTP agent host (the local runtime) gets it without fastify
├── index.ts               # re-exports (agent-server re-exports these too, so agent services import unchanged)
└── run-ledger.ts          # RunLedger port + RunLedgerLive adapter, startRunLedgerEffect / recordActivityEffect; per-run summary.json/events.jsonl/output.txt + the optional `run:<id>` statestore mirror. Best-effort per sub-effect — observability never breaks a run

packages/js/local-runtime/src/            # the LOCAL execution substrate — agent CLIs as local child processes, no Dapr/services/registries
├── bin.ts                 # composition root of the `h-local` binary: job JSON on stdin → result envelope on stdout, progress on stderr; SIGINT interrupts the fiber so agent-cli's reaper group-kills every CLI
├── index.ts               # library re-exports
├── domain/models.ts       # the two job kinds (Schema + derived type — the wire contract with the CLI): DelegateJob (one task, a roster) and WorkflowJob (a rendered DEFINITION), plus AgentRunRequest/Report and the envelopes
├── domain/agents.ts       # `--agent` name → agent, the closed vocabulary mirroring the CLI's AGENT_IDENTITY (guarded by cli/h/tests/test_local_agents_sync.py); unknown names fail loud
├── domain/activities.ts   # what an activity NAME means here — the counterpart of workflow-svc's activity registry: agent | builtin (setup, create-worktree) | REFUSED (write-wf-row, register-cron/-discover, run-itest, service-only agents), each refusal naming the engine/registry/cluster it needs
├── domain/ports.ts        # AgentPort (run one CLI — no error channel: a failure is a REPORT, so one dead agent never costs a roster its other answers), WorkspacePort (worktree + setup provisioning), ProgressPort
├── domain/delegate.ts     # the atom's orchestration: resolve the roster, cut a worktree PER AGENT sequentially, run the agents concurrently, assemble the envelope
├── domain/execute.ts      # the definition executor — a deliberate mirror of generic.workflow.ts reading its semantics from workflow-core (params under the reserved `params` id, {{token}}/$ref, resolvable activity NAME, parallel groups against pre-group results); applies the outputContract where the engine's run-* activity would
├── infrastructure/agent-cli-agent.ts   # AgentPort over agent-cli's invoker layers + the run ledger; passes NO llmConfig, so a run uses the operator's own authenticated CLIs
├── infrastructure/git-workspace.ts     # WorkspacePort over git-core's addWorktree (idempotent, mirroring /worktree) + the setup command loop
└── infrastructure/stderr-progress.ts   # ProgressPort → stderr, keeping stdout a parseable envelope

packages/js/git-core/src/
├── index.ts               # re-exports
├── git-client.ts          # clone – shallow, branch-aware git clone (injects GH token into github URLs in-process); addWorktree – git worktree add off an existing clone; gcWorktrees – the collector (never fails: an unclassifiable worktree is REPORTED as kept, since a collector that aborts halfway leaves the leak it was sent to fix)
├── git-exec.ts            # internal: the one place a git subprocess is spawned, and the one path from a raw failure to a caller-visible (token-scrubbed) error
├── worktree-seed.ts       # seedWorktree – copy repo-relative paths from the clone into a fresh worktree (the gitignored `.env`s a gate needs, which `git worktree add` leaves behind). Structurally confined to untracked files: an existing destination is KEPT (a tracked file always exists there), a missing source is REPORTED, and every path is validated against escaping the clone BEFORE anything copies. Both substrates' create-worktree call it; the list comes from the chart's `worktree.seed`
├── worktree-gc.ts         # the sweep rules in TS: parseDirt (`??` = scratch, everything else = tracked work), gcDecision (pure; NO --force counterpart — an unattended collector may never discard committed work), age as the liveness proxy, and the husk pass that reconciles the DIRECTORY listing against git's (a directory git has no record of is invisible to every git-based tool and keeps its full size). Held to the operator command's behaviour by scripts/fixtures/worktree-classification.json + check-sweep-parity.mjs
└── github-client.ts       # GitHubClient – read-only GitHub REST over fetch: listOpenIssues (PRs filtered, one page, GH_TOKEN, token-scrubbed errors). The discovery cron's issue read; consumed by workflow-svc's ISourceReader

packages/js/logger/src/
├── index.ts    # Logger interface, re-exports
├── service.ts  # initLogger (Pino), flushLogger
└── simple.ts   # singleCallbackLogger – lightweight stub for tests

packages/js/telemetry/src/
├── index.ts      # re-exports (makeTracingLive, TracingLive, getTracer, contextFromTraceparent, activeTraceparent)
├── tracing.ts    # makeTracingLive(serviceName?) → Effect Layer; acquires a NodeTracerProvider (ZipkinExporter → ZIPKIN_ENDPOINT), registers the W3C propagator, installs @effect/opentelemetry — the OTel SDK spine every JS service uses (see initTracing prose in Observability above)
├── context.ts    # contextFromTraceparent / activeTraceparent — re-attach or capture a W3C traceparent header so cron/activity spans share one trace tree
├── spans.ts      # withSpan helper — thin Effect.withSpan wrapper
└── bridge.ts     # plain-function helpers (getTracer) for code outside the Effect runtime

packages/py/agent-server/src/agent_server/   # Python sibling of js/agent-server (uv workspace member)
├── __init__.py    # re-exports
├── models.py      # AgentRequest, AgentResponse (dataclasses)
├── routes.py      # register_agent_routes + granular register_{run,setup,subscribe}_route (FastAPI); /run records the run ledger
├── run_ledger.py  # record_run – Python sibling of js run-ledger (summary.json/events.jsonl + statestore mirror)
├── workflow_route.py  # WorkflowBabysitter (submit-and-forward, watcher-engine cutover) + register_workflow_route – Python sibling of js workflow-babysitter/workflow-route (stdlib urllib via asyncio.to_thread; POST /workflow, GET /workflow/watches proxies workflow-svc /watch/list)
└── runner.py      # IAgentRunner Protocol – run(request, workspace) → AgentResponse

packages/py/agent-core/src/agent_core/       # shared agent machinery (uv workspace member; tests via `uv run --package agent-core pytest`)
├── react_loop.py  # provider-agnostic ReAct loop + LLMClient protocol (dependency-free base)
├── skills.py      # load_skill_instructions – system prompt from an h skill dir
├── llm/openai.py  # OpenAIChatAdapter over dapr_agents OpenAIChatClient (extra: dapr)
└── workflows/mcp_tools.py  # connect_workflows_mcp + WorkflowTools + open_workflow_tools (workflow-mcp toolset via MCPClient/SSE; extra: dapr)

cli/                                          # the h CLI + charts + run scripts (see cli/README.md; examples: docs/cookbook.md)
├── scripts/       # strategy 1 – run-*.sh / invoke-workflow-*.sh + payloads (envsubst/jq); _render.sh bridges to strategy 2
├── charts/workflows/  # strategy 2 – helm as a client-side templating engine; templates/<template>.tmpl.yaml → run_workflow body (YAML canonical, JSON only at the wire)
└── h/             # the `h` command – Python (Typer + rich), uv workspace member, package h-cli
    ├── src/h_cli/{main,config}.py            # Typer composition root; env-derived settings mirroring the scripts' defaults
    ├── src/h_cli/commands/{feature,template,workflow,chain,watch,cron,schedule,status,workspaces,worktrees,delegate,doctor,events,runs,agents}.py
    │   # ONE line per command below. The ANNOTATED reference — every flag, what it means, and
    │   # what it refuses — is cli/README.md's `h` CLI section; validated examples are
    │   # docs/cookbook.md. `--local` semantics and the local refusal set: Execution substrates.
    │   #   h feature      render|run [--agent]  – the legacy spec → render → fire path
    │   #   h template     compose|list|get|drift [KEYS…] [--json]  – the overlay atoms; `drift`
    │   #       re-renders each saved key's template in publish mode and diffs steps/params/outputs
    │   #       against the stored definition (operational fields excluded; no template ⇒ unchecked;
    │   #       exits 1 on drift, so it gates)
    │   #   h workflow     list|get|status|publish|run|pause|resume|terminate [--local]  – run takes
    │   #       KEY or TEMPLATE… with -p k=v content values, machinery as flags: --agent (repeat =
    │   #       panel roster)/--model/--instance-id/--fresh/--via/--watch/--budget/--inline (operands
    │   #       are chart TEMPLATES, fired without publishing — --save is for OUTLIVING the fire, and
    │   #       --cron refuses an ad-hoc overlay, which has no key for the cron:/wf: rows)/--cron
    │   #       --max-fires/--at|--in/--fallback-agent|-model|-after|-max/--on-quota fail|wait
    │   #       [--ignore-quota] (the quota gate — see the `quota:` registry above)/--local [--with-setup]
    │   #       [--timeout SECONDS, the per-agent-STEP wall clock, default 1800 — distinct from
    │   #       --budget's whole-run clock, and refused without --local] [--json, the result envelope
    │   #       on stdout; without it every contract-carrying step's validated block prints as a
    │   #       `<step> ▸ {json}` line, so a driver reads verify's gate and create-pr's base without
    │   #       opening the ledger]. `publish --local` saves into
    │   #       the LOCAL store so a local cron/trigger has a key to fire; --schedule/--workspace-id/
    │   #       --disabled are workflow-svc row machinery and refuse there.
    │   #   h chain        run|list  – run takes the EXPRESSION (-w KEY | -t ATOM…) hand-parsed by
    │   #       infrastructure/chain_expr.py. PER-MEMBER (suffix) flags: --agent (several names = a
    │   #       panel roster → infrastructure/panelize.py)/--model/--fresh/--inline/--kind/--stage/
    │   #       --cron/--max-fires/--id/--capture/--input/--until, with --parallel as the infix
    │   #       stage connector. COMMAND flags, which MUST PRECEDE the expression (click would
    │   #       otherwise consume them out of position, asserted by cli/h/tests/test_chain_expr.py):
    │   #       --slug/--param|-p/--strategy/--max-iterations/--after (the ACTIVATION GATE: hold this
    │   #       chain until another finalizes)/--at|--in/--local/--with-setup/--resume/--no-journal/
    │   #       --timeout/--on-quota/--ignore-quota (chain-wide: stamped onto every member's
    │   #       trigger). --budget is the one flag whose POSITION changes its meaning (prefix =
    │   #       whole-chain clock, suffix = that member's watch policy) — see the Chain primitive.
    │   #   h watch        list [--local]|get|delete       – the watcher registry
    │   #   h cron         list [--local]|rm REPO SLUG WORKFLOW|discover add <repo> --label --cadence
    │   #       [--workflow] [--max-per-day] [--run-budget-mins] [--run-retries] [-p k=v] [--local]
    │   #       – recur + discovery rows; `rm` disarms (POST /cron/disarm, single-writer) and
    │   #       `discover add` fires a provision workflow whose register-discover activity writes the
    │   #       row (§10 — there is no POST /cron/discover)
    │   #   h schedule     list|rm <id> [--local]          – the one-shot cron:sched rows
    │   #   h agents       list|deny|allow|budget [--local] – the executor policy fence; `list` also
    │   #       prints each executor's last-observed rate-limit windows (the `quota:` registry)
    │   #   h status       [--json]                        – one-screen driver check-in
    │   #   h runs         watch GROUP [--json]            – replay a run's journal, then follow live
    │   #   h delegate     TASK --agent A [--agent B …] [--model] [--cwd] [--worktree [--base]]
    │   #       [--plan] [--timeout] [--id] [--on-quota fail|wait] [--ignore-quota] [--json]  – the
    │   #       LOCAL substrate's atom: agent CLIs as
    │   #       child processes, a roster in parallel, no synthesis (use the answer template for a
    │   #       judged panel)
    │   #   h workspaces   link [PATH] [--profile] [--skill N]… [--rule N]… [--rules-target] [--dry-run]
    │   #       | plugins [PATH] [--dry-run] | trust [PATH]  – `link` provisions this repo's agent primitives into the locations
    │   #       agents READ (.h/skills/* → symlinks under .claude/skills/, .h/rules/* → one
    │   #       marker-delimited block in a steering file), SELECTING them per run — `--skill`/
    │   #       `--rule` win, else the named profile in `.h/context.toml`, else everything on offer —
    │   #       so one definition can run A with one skill and B with another, and PRUNING what is no
    │   #       longer selected (or run B silently inherits run A's context). Writes files, never
    │   #       commits them: the `npm install` model.
    │   #       `plugins` installs h's CONSUMER plugin into a repo that PINS h (`.h/h.lock` names
    │   #       which h, so a fork installs the fork's plugin and h's own checkout is refused —
    │   #       enabling its published plugin would shadow the live source tree): DECLARE the
    │   #       marketplace + `h@h-marketplace` in `.claude/settings.json` additively, INSTALL at
    │   #       PROJECT scope (installs pin per scope; a user entry says nothing about the clone an
    │   #       agent runs in), then VERIFY by reading `installed_plugins.json` back for this exact
    │   #       projectPath. DECLARED IS NOT INSTALLED — trxy carried the settings entries from
    │   #       2026-08-13 under a commit titled "install the h plugin" and it never loaded once, so
    │   #       the read-back is the gate and the install command's success line is not.
    │   #       `trust` stamps Claude Code's per-project trust for an h-MANAGED checkout only
    │   #   h worktrees    list|rm BRANCH|sweep [--json] [--repo PATH] [--force] [--prune-untracked]
    │   #       [--dry-run]  – both substrates' leftovers. The two removal flags accept DIFFERENT
    │   #       classes of loss: --force discards tracked edits and unpushed commits, --prune-untracked
    │   #       only files git never tracked (named before removal). Unpushed always blocks.
    │   #   h events       up [--with-relay]|down|status|publish|serve|await|results|tail  – the local
    │   #       fabric's three processes (nats-server, the ENGINE HOST, optionally the relay) plus the
    │   #       seed/relay/back-edge surface
    │   #   h doctor       – the consumer surface's one-screen toolchain report: required binaries,
    │   #       agent CLIs, the built runner, both chart roots, and which consumer config is in
    │   #       effect. An agent CLI is reported by READINESS, not presence — `ok` / `no auth`
    │   #       (naming the variables) / `missing` / `on PATH` when unknown — because a binary on
    │   #       PATH is not an agent that can run: doctor said `codex ok` on 2026-09-01 and a panel
    │   #       lost half its roster at run time for want of CODEX_AUTH_MODE. The answer comes from
    │   #       each strategy's own `validateEnvironment` via the runner's `probe` job, over the
    │   #       same shell+.env layering a `--local` run uses, so it is the answer the RUN will
    │   #       give; an unreachable probe reports UNKNOWN rather than reviving the guess.
    │   #       A report, never a gate: every surface still refuses loud by name at its own
    │   #       point of use. THE CONSUMER SURFACE ITSELF: a repo consuming h declares its paths
    │   #       ONCE in `<repo>/.h/config.toml` (found by walking up from cwd, git-style; precedence
    │   #       env var > config file > h-checkout default; keys charts_dir/local_bin/workspace_dir/
    │   #       worktrees_dir/runs_dir/dotenv/events_store, unknown keys fail loud), and charts
    │   #       resolve via a SEARCH PATH — the configured chart primary, h's stock chart the
    │   #       fallback — so a consumer's domain chart ADDS to the stock templates rather than
    │   #       replacing them. See cli/README.md + docs/installing-h.md.
    ├── src/h_cli/infrastructure/             # helm subprocess adapter, statestore/agent/svc/agent-service httpx clients, git worktree adapter (git.py), and local_runtime.py — the LOCAL substrate's client (spawns the h-local runner, layers .env under the shell env, forwards SIGINT)
    └── tests/     # pytest + syrupy goldens (chart contract tests) + respx-mocked wire
```

## Kubernetes layout

```
k8s/
├── apps/
│   ├── workflow-svc.yaml   # Deployment + Service — Dapr sidecar injected via annotation
│   └── claude-agent.yaml   # Deployment + Service + ConfigMap (MCP config)
├── dapr/
│   ├── statestore.yaml     # Component (state.redis, actorStateStore=true)
│   ├── pubsub.yaml         # Component (pubsub.redis)
│   ├── secretstore.yaml    # Component (secretstores.kubernetes)
│   ├── conversationstore.yaml
│   ├── claude.yaml         # Component (conversation.openai, scoped to claude-agent)
│   ├── resiliency.yaml     # Resiliency (1h outbound timeout)
│   └── appconfig.yaml      # Configuration (tracing — referenced by dapr.io/config annotation)
├── infra/
│   └── redis.yaml          # Deployment + Service
└── secrets/
    └── app-secrets.yaml    # k8s Secret (gitignored — generate with cli/scripts/gen-k8s-secrets.sh)
```

Tilt manages this stack. `make tilt-up` applies all manifests; `make tilt-down` removes them. Dapr control plane (`dapr-system` namespace) is Helm-managed — use `make dapr-install` / `make dapr-uninstall`.

**k8s mode is the HEAVY path — the three modes are not interchangeable in cost.** Host (`dapr
run` on the host) and container (compose) mode run the same stack without a cluster; k8s mode adds the k3s
server + loadbalancer + registry AND an image set that only grows: Tilt stamps an immutable
`tilt-<hash>` tag per rebuild and has **no image GC**, so every rebuild leaves a full ~2-3GB agent
image behind forever. Sweep with **`make tilt-gc`** (`TILT_GC_DAYS`, default 7) — note `make
itest-gc` does NOT cover these: it sweeps `<registry>/h/*` (the gate's images) while Tilt retags
`h/claude-agent` to `<registry>/h_claude-agent`, `/`→`_`, a different prefix. On a
resource-constrained box, default to host or container mode and treat k8s mode as opt-in; k8s mode
stays fully documented and `make k3d-up` recreates the cluster from nothing whenever it is wanted.
(Bit us live 2026-08-03: 45 orphaned Tilt tags, ~74GB, inside a Docker footprint that had reached
168GB.)

**Exactly ONE capability is k8s-only: `make itest`**, the integration gate — it deploys an ephemeral
`h-itest-<id>` namespace, so it needs k3d + `make dapr-install`. Everything else is mode-agnostic:
`make lint` (both stacks), `make test` (all unit suites, JS + Python), and every run/chain/cron
surface work identically in host and container mode. The consequence to remember when composing:
the h-builds-h `implement-pr` template embeds `run-itest`, so THAT LOOP requires k8s mode. Never
silently drop the step to fit a cluster-less host — the activity has a `skip`/`skipReason`
break-glass that records `class="skipped"` in the evidence and surfaces the reason in the PR body,
so a waiver stays auditable instead of becoming a missing gate.

## MCP configuration

`claude-agent` connects to MCP servers (`workflow-mcp` for workflows, `dapr-mcp` for state-store
inspection and pub/sub, `obs-mcp` for traces/logs/run-ledger — docker/host only, no k8s deployment,
so it is absent from the ConfigMap, `notion` for reading/searching Notion pages — authenticated with
`Bearer ${NOTION_API_KEY}` (a PAT, expires 1 year; no per-page sharing needed unlike integration
tokens), and the hosted GitHub MCP at `https://api.githubcopilot.com/mcp/` for repo/PR interaction —
authenticated with `Bearer ${GH_TOKEN}`). There is deliberately **no Linear MCP**: the hosted one
needs interactive OAuth and can't authenticate in an unattended agent — Linear is read/written via the
`linear` h skill instead (see below). Three configs select the URLs per environment:

| File / resource | Used when | URL |
| --- | --- | --- |
| `apps/claude-agent/.mcp.json` | Docker (service discovery via hostname) | `http://workflow-mcp:8000/sse` |
| `apps/claude-agent/.mcp.host.json` | Host mode (copied into workspace by test scripts) | `http://localhost:8005/sse` |
| `claude-agent-mcp-config` ConfigMap in `k8s/apps/claude-agent.yaml` | Kubernetes | `http://workflow-mcp:8000/sse` |

`ClaudeRunner` auto-provisions the MCP config into the run's cwd: before invoking the `claude` CLI
(which auto-discovers `.mcp.json` in its cwd) it merges `MCP_CONFIG_SRC` — defaulting to
`{AGENT_BASE_DIR}/.mcp.json` (the file Docker/k8s mount there), set to `{AGENT_APP_DIR}/.mcp.host.json`
in host mode — into whatever `.mcp.json` the cwd already has, creating it when absent. The provisioning
mode is `MCP_CONFIG_MODE` (validated at startup — any value other than `merge`/`replace` fails the
service, fail-closed): the default `merge` (`mergeMcpConfig`) preserves the cwd's own servers and
other top-level keys and lets h's servers win on a name conflict, so an agent running in a worktree
of a repo that ships its own `.mcp.json` (e.g. a target repo's `tessl` server) still gains h's
`dapr`/`obs`/`workflows` servers; `replace` discards the cwd's config entirely so an agent
executing untrusted specs never inherits any target-repo servers (whatever the repo), and a missing
`MCP_CONFIG_SRC` aborts the run instead of silently skipping the rewrite. `replace` is currently set
nowhere — it's the general knob a minimal-surface per-run trust profile would use if untrusted
third-party repos return; under today's trust model every
run is `merge`. Docker deployments mount
`.mcp.json` directly; in Kubernetes the ConfigMap is mounted at `/workspace/claude-agent/.mcp.json`.

### h skills (harness skill source)

**The OPERATOR's `~/.claude/skills/` is NOT a home for h's skills** (operator call 2026-08-31).
h's skills are self-contained in this repo: a session working on h loads them from
`.claude/skills/`, and an h worktree carries the same links, so a local-substrate agent gets them
as PROJECT skills with nothing installed in anyone's home. A CONTAINERISED agent still receives a
copy in its own (container) home via `h.setupSteps` — that home is not the operator's. The one
path that would re-pollute yours is `--with-setup` on the local substrate, which is an explicit
operator choice. Because a skill must now work from whichever home serves it, a SKILL.md names its
scripts as `<skill-dir>/<rest>` — the base directory the harness announces on load — and
`scripts/check-steering.mjs` REJECTS a `~/.claude/...` path outright: it resolves in exactly one
home, which is what kept the skills from being self-contained.

**The skills have TWO homes and ONE source.** `.h/skills/` is the distribution source (copied into
an agent's own `~/.claude/skills/` by a setup step); `.claude/skills/` is what a session working ON
this repo loads. Every skill in `.h/skills/` is therefore SYMLINKED into `.claude/skills/` with a
relative link (`../../.h/skills/<name>`, so clones, worktrees and containers all resolve it) rather
than copied — a skill edit is live in both homes at once, and there is no copy to drift.
`scripts/check-skills.mjs` enforces it and `node scripts/link-skills.mjs` repairs it; run that
after adding a skill. A REAL directory in `.claude/skills/` is legal and means a repo-only skill
agents are not given (`diagrams`, `integrate-agent`, `observe-h`, `night-campaign` — the
overnight campaign loop, which only the DRIVER session runs). This is a guard because the gap
is SILENT: `ways-of-working` and `delegate-locally` sat in the source dir for ten days reachable from
neither home — a local-substrate run skips the setup step that would have copied them, and a
missing skill never announces itself, it just never triggers.

h provides its own agent skills, kept at `.h/skills/` — the SAME path a consumer repo uses, so the
CLI links them into agent pickup locations with one code path and no branch on repo kind (moved
from the repo-root `skills/` on 2026-08-31 for exactly that parity). Not inside any agent app, so
they stay reusable across agents and the agent services stay thin. A workflow setup step copies them
into a CLI agent's user-global `~/.claude/skills/` (`cp -rn $H_SKILLS_DIR/. ~/.claude/skills/`).
`H_RULES_DIR` is its sibling for `.h/rules/` — the runtime steering a container-mode setup step installs, kept OUT of local runs by the `local` profile because it describes Dapr and MCP servers that are not there (it moved from `apps/claude-agent/steering/` on 2026-08-31 so one source feeds both the CLI's link command and the container setup step). `H_SKILLS_DIR` is the repo `.h/skills/` in host mode (set by the agent run scripts) and a read-only mount
(`./skills:/h-skills`) in compose. Current skills: `linear` (read a Linear issue headlessly via
`LINEAR_API_KEY` with `get-issue.sh`, post comments back with `add-comment.sh` — the hosted Linear
MCP can't authenticate unattended), `analyze-workflow-run` (correlate every observability source for
a run), `workflow-orchestrator` (turn a task into a saved/run/monitored workflow via the
workflows MCP), `h-issues` (file a well-formed improvement issue on the h repo — h only; other
repos carry their own conventions — with `create-issue.sh`, which refuses to self-apply the
`agent-approved` trust label), and `author-workflow-template` (the authoring recipe for chart
templates: the template gate, render modes, the output contract in its three places, the
one-declarer composition rule, goldens, publish — for any agent creating or modifying a template,
incl. h-builds-h feature runs), `ways-of-working` (the collaboration layer from the section above — plain-language explanation, rendered diagrams, h-improves-h, tooling-first; h only),
and `delegate-locally` (when and how to hand work to another agent
CLI on the LOCAL substrate — `h delegate` / `--local` — including what it refuses, the cost
accounting, and the safety rules that follow from a delegate running as the operator), and
`write-spec` (the procedure and six rules for writing a spec an implementing agent can execute
unsupervised — sections, trap, read-back; consumer-facing). A **Python** agent consumes a skill's body directly as its system prompt via
`agent_core.load_skill_instructions` — workflow-agent loads `workflow-orchestrator` this way (the
same source a CLI agent gets), so the orchestration procedure has a single home. This is a skill
source alongside the tessl registry (org-published plugins) and a repo's own `.claude/` skills.
Skills install on every setup, but WITHOUT CLOBBERING (`cp -rn`): a same-named skill already in
the target home wins, because that home is the operator's own on the local substrate. Claude Code
marketplace plugins are provisioned per-run via `h.pluginSetupSteps` in the setup step — only when
the `plugins` fire-time param is non-empty (distinct from skills, which copy on every run
regardless). See the additive-setup gotcha below for the rule both steps follow.

h is also a plugin marketplace ITSELF, in the other direction — skills h ships TO its consumers,
not skills its agents consume: the repo-root `.claude-plugin/marketplace.json` (+ the Codex
sibling `.agents/plugins/marketplace.json`) publishes the **`h` plugin** (`plugins/h/`), the
CONSUMER steering surface for repos that use h as installed tooling. Its skills are `use-h` (run
domain workflows from a consumer repo — the consumer contract, the local substrate, refusals,
ledger/cost), `author-h-template` (author a domain chart under `.h/charts/` — vendored
helpers, gate, params-as-contract, output contract, verify-without-goldens; its starter-chart
reference is the canonical vendoring source), `delegate-locally` (hand bounded work to another
agent CLI), `analyze-workflow-run` (what a run did, and why it failed), and `write-spec` (write a
spec an implementing agent can execute unsupervised — sections, six rules, read-back). The last two moved
here from h's own set on 2026-08-31: the local substrate and the run ledger are exactly what a
consumer uses, so keeping them h-only was the gap, not a boundary. h still reaches them —
`.h/skills/<name>` is a symlink into `plugins/h/skills/`, so there is ONE copy, published by the
plugin and linked for h's own sessions. h does not enable its own plugin: the marketplace source
is GitHub, so enabling it would run a PUBLISHED copy against a live source tree — the same
stale-artifact trap `.h/venv` would be. A consumer installs it like the other ecosystem
plugins: `extraKnownMarketplaces` → `{"source": "github", "repo": "stiproot/h"}` +
`"h@h-marketplace"` in `enabledPlugins`. Consumer-facing prose in these skills must stay
env-agnostic (no h-checkout paths, no operator-machine specifics). Metadata invariants are
guarded by `scripts/check-plugins.mjs` in `bun run lint` (manifest/name/version parity across
both agents' manifests, skill frontmatter = exactly name+description, executable bundled
scripts — mirroring the ecosystem's validate.sh).

## Observability

`workflowInstanceId` is the join key across every surface — it is the Dapr workflow instance id, the
default agent workspace key, a Zipkin span attribute, and the group key of the run ledger.

- **Traces → Zipkin.** Every service calls `initTracing` (JS) / `init_tracing` (Python) → OTLP/Zipkin
  at `localhost:9411` (docker: `zipkin:9411`), W3C-propagated. Activities thread the originating
  `traceparent` as workflow-input data and re-attach via `contextFromTraceparent` so a run is one trace
  end-to-end — including the cron path (the tick captures `activeTraceparent`). k8s tracing is off
  (`samplingRate: "0"`).
- **Run ledger → "what the agent did".** Every agent run writes, best-effort,
  `{AGENT_RUNS_DIR}/<instanceId|workspaceId>/<agentId>-<ts>/{summary.json,events.jsonl,output.txt}` on the
  shared volume (`AGENT_RUNS_DIR` defaults to `<AGENT_BASE_DIR>/../.runs`), and mirrors a compact
  `run:<runId>` record + `runs:index` into the statestore — so runs are queryable via `dapr-mcp` too.
  The JS capture lives in `agent-server`'s `startRunLedger` (events arrive via the runner's `onEvent`);
  the Python sibling is `record_run`, called from the shared `/run` route. The run ledger is also the
  read path for a completed run's output — including the validated structured block at the end of
  `output.txt` (obs MCP `runs_list`/`run_get`, or the `run:<id>` mirrors via dapr-mcp);
  `GET /workflow/status/:instanceId` does not surface `serializedOutput`, so don't poll it for results.
- **Logs → Loki.** Alloy scrapes **dockerized** containers only; host-run `dapr run` apps (the usual
  `make dev-tab` mode) do not reach Loki — use traces + the run ledger for app/agent activity.
- **Viz (web/).** **Status: EXPERIMENTAL — research phase, not a shipped product.** `web/` is a
  deliberate sandbox for exploring how to *visualize* h's runtime (workflows, chains, and the
  watcher/cron engines) with D3 v7 as the drawing library. Multiple layout variants coexist behind a
  switcher precisely because the right visual language is still an open question — expect churn, dead
  ends, and byte-frozen "we liked this one" baselines (e.g. `orbits`) sitting beside their in-progress
  successors (e.g. `engines`). Treat the plan doc as the running research
  log, not a spec. It is intentionally OUTSIDE the `apps/*` bun-workspace glob (own package.json,
  `bun install` inside it) so this experimentation never taxes the production build/lockfile machinery;
  don't wire it into turbo, Dockerfiles, or CI as if it were a service. It renders the runtime as a
  live force-directed graph: instance circles colored by status (pulsing while RUNNING) and sized by
  cost, chain diamonds with ordered member edges, amber watch rings, cron clock-squares, per-agent
  satellite run dots, a details panel with lazy run output. `bun run dev` (port 5173) proxies
  `/svc/*`→workflow-svc:8003 and `/obs/*`→obs-mcp:8013, which serves the run ledger as plain JSON at
  `GET /api/runs` / `GET /api/run/:id` beside its MCP surface. Read-only by design: the viz never
  mutates runtime state — the CLI and MCP surfaces stay the only write paths.
- **Query surface.** The repo's own Claude Code session wires three MCP servers via root `.mcp.json`:
  `dapr` (state/actors, `localhost:8011`), `workflows` (workflow state, `localhost:8005`), and `obs`
  (traces/logs/run-ledger, `localhost:8013`). `obs-mcp` is read-only with no Dapr sidecar. Slash
  commands (`.claude/commands/`: `/observe`, `/runs`, `/run`, `/trace`, `/logs`, `/workflow`) and the
  `observe-h` skill (`.claude/skills/`) drive them.
## Diagrams are the medium for design and architecture

**When you are explaining design or architecture — a new component, a changed interaction, a
proposal, an answer to "how does X work" — LEAD WITH A DIAGRAM, not prose.** Follow the `diagrams`
skill (h's where-and-when policy, composed with the `generated-diagrams` plugin skill for the
mechanics). This is a ways-of-working rule, not an observability one: prose summaries of changes
pile up faster than they can be read, and a picture is the artifact that survives.

Two genres. **Transient** diagrams express an IDEA — a proposed change in a plan doc, a design
alternative in conversation, a before/after in a PR body; they live in their host document and die
with it. **Canonical** diagrams model the architecture AS IT IS: one file under `docs/diagrams/`,
registered in [its index](./docs/diagrams/README.md), named `<scope>-<kind>.md`. A transient
diagram graduates when it keeps being how something gets explained.

Three obligations, in order of how often they are missed:

1. **Explain with one.** The trigger is *communication*, not maintenance. If you are about to
   write three paragraphs describing a flow or a structure, draw it instead and let the prose
   annotate the picture.
2. **Update-with-the-change.** A change that alters an interaction a canonical diagram models —
   new step, new participant, moved responsibility, a new BRANCH through an existing flow —
   updates that diagram in the same change set. A stale diagram is worse than none.
3. **Render before committing.** The render IS the syntax check, and for C4 you must LOOK at the
   image: mermaid will happily emit a valid-but-unreadable 5000px column. `uvx vizzle render
   docs/diagrams docs/diagrams/rendered` (`docs/diagrams/rendered/` is gitignored — render on
   demand, share the PNG).
   **`UpdateLayoutConfig($c4ShapeInRow=…)` is INERT in mermaid 11.16.0** — C4 lays out two shapes
   per row whatever you write, so a wide diagram is not available and that 5000px column is not
   something you can widen your way out of. Verified 2026-08-12 by rendering the same diagram at
   2 vs 6 and a minimal one at 2 vs 4: byte-identical SVGs, and a `{"c4":{"c4ShapeInRow":N}}`
   mermaid config changes nothing either (the unquoted directive form is a parse error, so the
   quoted syntax in our files is correct and simply ignored). The levers that DO work are
   `UpdateRelStyle($offsetX/$offsetY)` for label collisions, and splitting an over-full diagram
   into a second, narrower one — which is what `execution-substrates-c4-container` is.

**Use the tooling; never re-implement it.** [vizzle](https://github.com/stiproot/vizzle)
generates and drift-checks the managed `-class` docs (`uvx vizzle doc --dir docs/diagrams`,
`--check` in lint) and renders fences to images (`uvx vizzle render`). Nothing is installed: `uvx`
fetches it on demand, so vizzle is in no lockfile and is not a dependency of this repo —
`git` is its only other requirement. lint pins the exact version, because a drift gate that
a third party's release can turn red is not a gate; bumping it regenerates the diagrams in
the same change. The `code-comprehension` plugin
keeps the judgment — which diagram at which level, when a picture beats prose — and the split
is the one the skills draw: **the tool says HOW, h says WHERE AND WHEN**.

vizzle publishes no JS library, so `check-diagrams.mjs` recognises a managed doc by its
`gen:c4-code` MARKER rather than importing a parser. That is the narrow exception, and the
reason is written at the import site: the marker is the format's public contract, while
re-deriving its JSON parser here would still be the duplication that guard exists to catch.

Enforcement is deliberately partial, so know exactly where the machine stops. `vizzle doc
--check` fails on drift for GENERATED `-class` docs — but only for docs it can SEE, i.e. ones
carrying a manifest. `scripts/check-diagrams.mjs` covers the rest of the set's hygiene (registered
in the index both ways, kind-suffixed name, exactly one mermaid fence, a `## Reading notes`
section) plus that blind spot: a `-class` doc with no manifest, which the generator skips silently.
**No guard can tell you a hand-authored sequence or C4 diagram has quietly gone wrong — obligation
2 is yours alone**, and it is the one that gets missed. Class diagrams are GENERATED from source,
never hand-drawn: `uvx vizzle doc --dir docs/diagrams`.

## Dev commands

Install dependencies (run from repo root):

```sh
bun install --frozen-lockfile
```

Build all workspace packages in dependency order (Turborepo resolves the graph):

```sh
bun run build
```

Per-package (run from the package directory):

```sh
bun run build    # tsc --project tsconfig.build.json
bun run lint     # tsc --noEmit + oxlint + oxfmt --check (+ dependency-cruiser on the hex services)
bun run format   # oxfmt src
bun run test     # vitest run
```

Architecture is linted, not just conventional: `make lint` (`lint-js` + `lint-py`) enforces the
hexagonal boundaries — a pure `domain/`, adapters that never import each other, no cycles — via
`dependency-cruiser` (`.dependency-cruiser.cjs`, wired into the hex TS services' `lint` scripts) and
`import-linter` (`[tool.importlinter]` in each hex agent's `pyproject.toml` — `workflow-agent`,
`langgraph-agent`, and the standalone `claude-managed-agent` — run over the flat namespace packages
with `src` on the path). See [ARCHITECTURE.md](./ARCHITECTURE.md#boundaries-enforced).

For Python, sync dependencies from the lockfile.

Workspace members (the shared `agent-server` / `agent-core` libs, the agent apps
`dapr-agent`, `dapr-claude-loop-agent`, `langgraph-agent`, `workflow-agent`, and the
`h` CLI at `cli/h`) share one root `uv.lock` — sync from the repo root, optionally
scoping to one member with `--package`:

```sh
uv sync --frozen                                  # whole workspace
uv sync --frozen --package langgraph-agent        # one member + its deps
```

The one standalone agent keeps its own `uv.lock` and syncs from its own directory:

```sh
cd apps/claude-managed-agent && uv sync --frozen --no-dev
```

The `h` CLI (installed editable as a workspace member):

```sh
uv run h --help                          # run the CLI from the repo root
uv run --package h-cli pytest cli/h/tests   # its test suite (incl. golden snapshots of cli/charts)
```

**The `cli/h/tests` path is load-bearing — a bare `uv run --package h-cli pytest` is a HOLLOW
GREEN.** The root `pyproject.toml` sets `testpaths = ["packages/py"]` and deliberately EXCLUDES
`cli/h` (its `addopts = "--disable-socket"` fail-closed network guard does not compose into one
root config), so the bare form runs `packages/py`'s ~52 tests under an h-cli-scoped env and
reports green while the CLI's ~390 never ran — indistinguishable from a real pass. Same class as
the `tsc` no-op above. `make test-py` uses the correct path-scoped form; `scripts/check-steering.mjs`
fails the build if a steering doc cites the bare one. (Found 2026-08-06 during the nats work,
recorded only in that plan; it then bit a local-substrate run on 2026-08-10 because the steering
docs still carried the broken form — a plan finding that was never lifted.)

## Effect code follows the effect-claude-primitives plugin

**Changing TypeScript that uses Effect means loading the `effect-claude-primitives` skills
first** — `effect-error-handling`, `effect-core-concepts`, `effect-service-pattern` and the rest
(installed for this repo; each skill's `references/` holds the full pattern
corpus, opened on demand). They are the house rules for this codebase's Effect usage, not background
reading.

The catch that makes this a steering line rather than a preference: **agent skills are
trigger-loaded on a description match.** An installed skill that nothing in the task text matches
never loads — so a spec or a prompt that describes the work without naming Effect gets an agent
that writes Effect code having never seen the rules. That is not hypothetical: on 2026-09-04 a
spec asked for a retry around a contract validator and never used the word "Effect" (its only
matches were the English "side effects"); the run shipped a raw `try/catch` inside an
`Effect.gen`, REPLACING an idiomatic `Effect.try`, in a repo where the plugin was installed in
that very worktree. `write-spec` Rule 7 is the spec-side half of this rule.

The two idioms that cost us real defects, both now guarded or fixed:

- **Errors belong in the typed `E` channel.** Lift a throwing call with `Effect.try` and recover
  with `catchAll`/`catchTag` — never a raw `try/catch` inside an `Effect.gen`.
- **`Effect.promise` is for promises that CANNOT reject.** A rejection becomes a DEFECT, and
  `Effect.ignore` does not catch defects — so `Effect.promise(...).pipe(Effect.ignore)` says
  "swallow this" and dies instead. Use `Effect.tryPromise`. `scripts/check-effect-idioms.mjs`
  fails the build on that pairing; it found nine of them (eight Dapr `stop()` finalizers).

Known divergence, deliberately not yet converted: `local-runtime/domain` and `workflow-core`
define errors as plain `extends Error` rather than `Data.TaggedError`, so recovery there is
`instanceof` rather than `catchTag`, while 39 call sites elsewhere in the repo use the tagged
form. `StructuredOutputError` is shared with workflow-svc's `run-*` activities, so converting it
is a cross-package change to a shared type — an operator decision, not a drive-by.

## The guards (`bun run lint`)

*Harden by encoding* means the guards ARE the steering: each one is an invariant somebody decided
was worth a machine checking every time rather than a human remembering. Reading this list is the
fastest way to learn what this repo refuses to let you do. Each script's header comment carries the
live incident that motivated it — read that before working around one.

| Guard | Invariant it holds |
| --- | --- |
| `check-tsc` | the toolchain is real — `tsc`/turbo/oxlint/oxfmt actually run (the hollow-green guard) |
| `check-workspace-built` | a consumed workspace package has a `dist/`, so a missing build fails legibly |
| `check-no-home-paths` | nothing the repo SHIPS resolves through `~/.claude` — a home path works on one machine and fails silently on every other; prose may discuss it, a tagged code fence may not |
| `check-steering` | components, `run-*` activities, skill script paths, chain-expression flags and `h` commands are all documented; the CLI test suite is never cited without its `cli/h/tests` scope; **CLAUDE.md stays under its 130k-char budget** and its gotcha INDEX matches `docs/gotchas.md` in both directions |
| `check-plans` | plan-doc headers/triggers; **nothing outside `docs/plans/` cites a plan** (`docs/plans/…` *or* bare `plans/…`); intra-plan links survive archiving |
| `check-vocabulary` | retired terms stay retired in long-lived prose (the ARCHITECTURE.md glossary is canonical; `docs/plans/` is exempt as a historical record) |
| `check-templates` | no chart template drives a bare `git push --force` — `--force-with-lease` only |
| `check-plugins` | the `h` plugin's manifests agree across the Claude and Codex marketplaces; skill frontmatter is exactly name+description |
| `check-skills` | every skill in `.h/skills/` is symlinked into `.claude/skills/`, so both homes see one source |
| `check-diagrams` | canonical diagrams are indexed both ways, kind-suffixed, one fence, `## Reading notes`; a `-class` doc with no manifest (which the generator skips silently) is caught |
| `check-hex-lint` | every TS package with a `domain/` or `presentation/` runs dependency-cruiser in its `lint` |
| `check-lint-parity` | every TS package's `lint` script runs the SAME checks — the repo had drifted into two halves each missing what the other had |
| `check-effect-idioms` | `Effect.promise` never pairs with `Effect.ignore` — a rejection is a DEFECT that `ignore` cannot catch, so the pairing lies about what it does |
| `check-runtime-parity` | neither substrate grows a private copy of `workflow-core` / `engine-core` semantics |
| `check-sweep-parity` | the TS worktree-sweep rules match the operator command's behaviour |
| `check-refusal-classification` | local refusals are `pending` vs `permanent`, and **no refusal outlives the engine it was waiting for** |
| `check-local-refusals` | docs that ENUMERATE the local refusal set match the code that refuses — the set shrinks as engines land, and a doc claiming a working capability is refused is worse than one omitting it |
| `check-registry-writers` | one writer per registry prefix in the flat shared keyspace |
| `check-state-keys` | every Dapr `state.get`/`state.delete` wraps its key in `pathStateKey` (a `/` in a key 404s on read but saves fine) |
| `check-kv-keys` | the JetStream sibling — registry ids contain `:`, which NATS forbids in a KV key; the symptom is an EMPTY registry, not an error |
| `check-git-credentials` | no credential rests in a persisted remote URL — injection is per-operation |
| `check-services` | the per-mode service list matches the `.zellij/*.kdl` pane sets |
| `check-ports` | run-script cleanup, Dapr flags and the README port map stay in lockstep |
| `check-env-parity` | Compose and the k8s secret generator read nothing `.env.example` fails to declare |
| `check-dockerfiles` | every workspace `package.json` is COPY'd where `bun install --frozen-lockfile` needs it |
| `check-mcp-parity` | agent runtimes expose the same MCP server set across host/Docker/k8s |
| `vizzle doc --check` | generated `-class` diagrams have not drifted from the source they model |

`check-env-local` is a helper (`bun run check-env-local`), not part of the lint chain.

**When you add a boundary, add or extend its guard in the same change.** A new guard goes in
`scripts/`, into `package.json`'s `lint` chain, and into this table — and its header comment records
why it exists, because a guard whose motivation is lost is one the next person routes around.

## Vocabulary

When writing about h — docs, comments, PR bodies, workflow prose — use the canonical dictionary in
[ARCHITECTURE.md's Glossary](./ARCHITECTURE.md#glossary): a workflow definition is ordered STEPS
invoking ACTIVITIES; a chain is ordered MEMBERS (grouped into STAGES) firing WORKFLOWS, threading
state through the CHAIN DATA. Retired terms fail `scripts/check-vocabulary.mjs`, whose banlist sits
beside its glossary pointers. (`.h/rules/h-runtime.md` states the same rule for
agents running INSIDE h, whose home memory h installs; this is the repo-side copy, so the rule holds
for anyone working in h through any harness.)

## CI (self-hosted runner)

CI (`.github/workflows/guards.yml`) can run on a **self-hosted runner** (`tools/ci-runner/`
— Dockerfile + compose + runbook README) whenever the `RUNNER_LABEL` repo variable is set
(=`h-dev`); without it, GitHub-hosted (`runs-on: ${{ vars.RUNNER_LABEL ||
'ubuntu-latest' }}` — no YAML change either way). **The switch is
`tools/ci-runner/toggle.sh on|off|status`** (uses the exported `GH_TOKEN`; nothing
committed). Self-hosted execution is free of Actions minutes, so CI survives a billing
lapse; if the dev box is off, jobs queue ~24h then cancel. Live-verified 2026-07-29. **A self-hosted runner must never be attached
while the repo is public** (fork PRs run untrusted code on the host) — the rule is encoded:
`toggle.sh on` refuses on a non-private repo. Detached + swept for the 2026-07-31 public
flip (history gitleaks-clean; Actions restricted to github-owned + the three pinned
setup actions; post-flip steps in the runner README's "Going public" checklist).

## Docker build context

All app Dockerfiles use `context: .` (workspace root) so Bun can resolve workspace packages during `bun install --frozen-lockfile`. Dockerfiles copy workspace manifests first for layer caching, then source, then run `bunx turbo build --filter=<app>...` to build workspace package dependencies in topological order. When adding a new workspace package, add its `package.json` COPY line to all relevant app Dockerfiles — `bun install --frozen-lockfile` will fail otherwise; parity is guarded by `scripts/check-dockerfiles.mjs`.

BuildKit cache mounts are used for both `bun install` (`id=bun-store`) and the turbo build (`id=turbo-store`), shared across all TypeScript app images. Python images share a `uv-store` cache mount. A `.dockerignore` at the repo root excludes `node_modules/`, `dist/`, `.venv/`, and other build artefacts from the build context.

## Key gotchas

**The detail lives in [docs/gotchas.md](./docs/gotchas.md) — this is the INDEX.** Every trap this
repo has already paid for is named here with a one-line hook so you know it EXISTS; go read the
entry before touching the thing it names. The two lists are held in lockstep by
`scripts/check-steering.mjs` (titles byte-identical, both directions), so a new gotcha is written
there and indexed here in the same change. Sub-points (e.g. the toolchain guard's poisoned-cache
root cause, the `detached` checkout trap) live only in the doc.

- **Polyglot package layout** — `packages/js/*` (npm) and `packages/py/*` (uv) never resolve each other; `agent-server` exists in both.
- **`bun install` required after adding packages** — workspace deps hoist to the root `node_modules`; skip it and the package is missing at runtime.
- **`uv lock` required after adding to a Python workspace member** — one root `uv.lock`; also add the member's `pyproject.toml` COPY to its Dockerfile.
- **Turborepo build pipeline** — `build` declares `dependsOn: ["^build"]`, so packages always compile in dependency order.
- **Toolchain guard — `tsc` can silently no-op (hollow green)** — a 0-byte native binary makes `tsc`/turbo/oxlint exit 0 doing NOTHING; `check-tsc.mjs` catches it, a poisoned cross-uid bun cache causes it.
- **Architecture is linted (hex boundaries)** — dependency-cruiser (TS) + import-linter (Python) enforce the layering; a new hex service MUST wire its own.
- **`GH_TOKEN` for private-repo clones** — git-core injects it into github URLs in-process, so it never lands in a definition or a log.
- **SQLite name resolver** — host mode shares `/tmp/dapr-h-nr.db`; `busyTimeout: "10s"` + supervised panes are the mitigation for the mass-registration-loss failure.
- **SQLite name resolver in COMPOSE too** — a shared `/nr` volume, sidecars as `user: "0:0"`, and ALL sidecars must agree on the resolver.
- **`actorStateStore: "true"`** — load-bearing for Dapr Workflows in both statestore YAMLs; missing it fails the actor runtime cryptically at startup.
- **`dapr-mcp` dual listeners** — actor host (express) on `ACTOR_APP_PORT` (8012 host, NOT 8021), MCP-SSE on `APP_PORT`; `--app-port` points at the actor port.
- **`cron-tick` binding → `workflow-agent`** — `bindings.cron`, route name must equal the binding name.
- **`workflow-cron-tick` binding → `workflow-svc`** — the 60s engine tick; Dapr probes with `OPTIONS` and an empty JSON body, so the route needs its own Fastify scope.
- **Reusable workspaces (`workspaceId`)** — agents key their dir on `workspaceId ?? instanceId`; `/setup` short-circuits on an unchanged spec hash.
- **Host ⇄ compose workspace interchangeability** — mode-agnostic paths + the shared `AGENT_GID` (10001) ownership, with `_lib.sh` self-healing the membership-in-effect gap.
- **Grooming workflow shared-context pattern** — instanceId, handoff file and actor id all keyed `groom-${ISSUE_ID}`.
- **Chart-rendered workflows (`cli/charts`)** — `helm template` client-side only; YAML canonical, JSON at the wire; the syrupy goldens are the chart's contract tests.
- **Chart template gate and role (`--set template=<name>`)** — helm evaluates EVERY template, so each body needs its `if eq` gate and a `role:`.
- **Publish mode / templates** — content goes in `-p key=value`, machinery in flags; `--inline` overlays without publishing, and `--cron` refuses an unnamed composition.
- **Fire-time identity (identity-as-params)** — values.yaml supplies DEFAULTS; `--agent`/`--model` override per fire, and a pre-identity saved workflow has no slots.
- **`workflow-trigger` topic (triggers as data)** — one well-known topic, not one per template; payload problems ack, infra failures 500.
- **Re-firing an existing instanceId ATTACHES by default (`fresh` opt-in)** — a terminal instance comes back as-is; re-executing a FAILED id needs `fresh: true`.
- **Standard `POST /workflow` (submit-and-forward) + the watcher engine** — supervision is durable and engine-owned; never build orchestration on an agent looping `await_workflow`.
- **MCP servers are agent-runtime dependencies** — an MCP server down silently strips tools from agent runs, not just from your observability.
- **Checkout is a NAMED STRATEGY, not flags (`GitCheckout`)** — `branch` writes, `detached` reads; a PR head is NOT a branch you can name (use `refs/pull/<n>/head`).
- **Agent setup is ADDITIVE — never clobber a repo's or an operator's own context** — marker-delimited steering, `cp -rn` skills; on the local substrate that HOME is the operator's own.
- **Run ledger is best-effort** — observability must never break a run; the on-disk files are the source of truth.
- **Statestore shared keyspace** — `keyPrefix: none`, so one writer per registry prefix, and every path-position key needs `pathStateKey`.
- **`docker-compose.host.yml`** — required for host mode's `--profile infra`; never use it with full-Docker profiles.
- **Recreate app + sidecar TOGETHER (compose)** — recreating an app alone strands its netns-sharing sidecar and can degrade the actor runtime an hour later.
- **`docker compose down -v`** — always pass `-v`, or the scheduler's etcd volume replays a prior workflow on startup.
- **Compose env precedence (shell exports shadow `.env`)** — always go through `cli/scripts/compose.sh`; raw `docker compose` fails loud on the `x-h-compose-guard` key.
- **Host-mode port allocation** — every run script pins a unique app/http/grpc/internal-grpc set; the full map is in README.md.
- **Run scripts are idempotent** — `stop_stale` frees the ports first, so re-running a script replaces a prior instance.
- **Headless host-mode bring-up (agent-friendly, no zellij/TTY)** — `make up-host-wait` is the unattended sibling of the zellij layouts; membership lives once in `_services.sh`.
- **Codex on a ChatGPT subscription (not only an API key)** — `CODEX_AUTH_MODE=chatgpt`, no `--model`, a container-private `CODEX_HOME`, and no SSE MCP servers.
- **`:edge` images** — track the latest Dapr release and move without notice; pin beyond local hacking.
- **`packages/agent-cli` and `packages/logger` dist** — imported from `./dist/index.js`, so source changes need a rebuild.
- **Alloy log scraping** — `discovery.relabel`, not `loki.relabel`; the wrong one yields unlabelled streams Loki rejects with a 400.
- **Python agents base image** — `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`, two-phase `uv sync` against the root lock.
- **Dapr Conversation API tool calling** — `DaprChatClient` (alpha2) has none; the Python agents use `OpenAIChatClient` at LiteLLM.
- **MCP server per-connection isolation** — a new `Server` per SSE connection, or reconnect throws "Already connected to a transport".
- **Kimi agent gaps** — `ENABLE_TOOL_SEARCH=false` and no WebFetch are documented Moonshot limitations, not bugs.
- **Resiliency policy** — a 1-hour outbound timeout, without which the scheduler kills long agent activities.
- **Dapr CRDs survive `helm uninstall`** — use `make dapr-uninstall`, or a reinstall hits a field-manager conflict.
- **Dapr mTLS cert rotation (Kubernetes)** — expired SA tokens break renewal; symptom is looping `DaprBuiltInActorNotFoundRetries`.
- **WorkflowRuntime startup race (Kubernetes)** — the SDK retries an ECONNREFUSED against a not-yet-ready sidecar; persistent means the cert issue above.
- **k8s secrets file is gitignored** — regenerate `k8s/secrets/app-secrets.yaml` from `.env` before `make tilt-up`.
