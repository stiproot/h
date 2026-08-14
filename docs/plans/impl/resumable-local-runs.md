# resumable local runs — journal a run's state so a dead driver's spend survives it

Status: Complete — both increments built + validated live 2026-08-14 (chain stage-level resume; workflow step-level resume incl. partial parallel groups; `h runs watch`)
Established: 2026-08-14
Lifted to: CLAUDE.md (execution substrates — the RUN JOURNAL paragraph + fabric streams), cli/README.md (local substrate commands + doctor prose), skills/delegate-locally + plugins/h use-h (consumer steering, plugin 0.1.2), docs/cookbook.md (two validated resume entries), carried-followups (the two rejected non-goals with triggers)

## The idea

On the local substrate the driver IS the supervisor, and that stays true — but today its
MEMORY dies with it. A `--local` workflow or chain that fails or is killed at stage N has
already paid for stages 1..N-1, whose results sit fully-formed in the run ledger, yet any
re-fire re-pays them. The fix is journaling, not an engine: h definitions are DATA (a step
list with known results), so resume needs no replay machinery — *skip the completed steps,
reload their results, continue at the cursor*.

Live trigger (2026-08-14): the first tooling-scout chain spent $1.93 on its scout + selector
stages, then failed loud at implement on an empty spec — correct behavior, but re-firing
with a real spec re-pays both earlier stages. The general form is the long-run death class
(usage limits, machine sleep, operator Ctrl-C) the checkpoint-first convention only
partially covers: that convention checkpoints the AGENT'S work (commits on a branch); the
journal checkpoints the RUN'S state (which steps completed, with what structured results).

## Store decision — REVISED 2026-08-14: NATS JetStream journal-as-stream

The first scoping locked plain JSONL beside the run ledger, on the posture argument: the
fabric is optional, and journaling through it would make plain `--local` runs depend on a
daemon. **The operator reversed this deliberately the same day**: h's users are its
operators, nats-server is already provisioned wherever h runs (h's machine and the first
consumer repo both install it), and the fabric benefits are worth the coupling. Recorded so
the posture change is legible:

- **What is accepted**: journaled `--local` runs depend on the nats-server BINARY being
  provisioned. The operator-provisioned rule survives intact — h never installs it, and a
  missing binary refuses loud by name — but h now MANAGES THE PROCESS: a journaled run
  auto-ensures the fabric (the same idempotent spawn `h events up` uses) instead of asking
  the operator to start it. "Nothing running" becomes "nothing the operator must start".
- **What it buys over JSONL**: publish-with-ack atomicity (no torn-line rule); live
  watchability (`h runs watch GROUP` falls out of a subscription); ONE persistence plane for
  the whole local substrate (tasks, results, journals — all streams in the store beside the
  run ledger); and the redelivery+resume composition with fabric loops (JetStream redelivers
  a died step's descriptor, the journal makes the redelivered run RESUME rather than
  restart).
- **No dual backend**: journal-as-stream is the one mechanism (atomic-cutovers rule — no
  JSONL fallback mode to rot). The prior JSONL rationale stays above in history only.
- **Un-revisit trigger**: if h ever gains operators who cannot provision nats-server (a
  consumer class beyond h-packaged's own posture), the JSONL shape in this plan's history
  is the fallback design to resurrect.

## Design

### The stream

A third stream beside the fabric's two, created idempotently by the same ensure path:

- **`h-journal`** — subjects `h.journal.>`, **limits retention** (like `h-results`, because
  resume AND watch both replay; work-queue would consume-once). `max_age` ~14d: a journal
  is small (structured fields, never transcripts) and a run older than that has no live
  resume claim; the run ledger stays the permanent record.
- One subject per run group: `h.journal.<group>`. Every record publishes with
  `Nats-Msg-Id: <group>:<seq>` — the fabric's existing dedup idiom — so a crashed writer's
  retry can never fork a journal.
- Records (`seq` monotonic per group):
  - `{"seq":0,"type":"meta","kind":"workflow"|"chain","definitionHash":"…","group":"…","ts"}`
    — hash over the composed definition/member set; resuming under a silently-changed
    composition refuses loud (no `--force` in increment 1: a changed composition is a NEW
    run).
  - `{"type":"step","stepId":"…","result":{…},"structured":{…},"ts"}` — workflow step done
    (parallel groups: one record per branch + one for the group).
  - `{"type":"stage","cursor":k,"data":{…},"ts"}` — chain stage done and captured; `data`
    is the full post-capture chain data, so stage-level resume reads ONE record.

### Ownership split (who speaks NATS)

Today the NATS client lives ONLY in Python (`nats-py` in h-cli; the fabric + relay). The
journal is EXECUTION state, and the executor owns execution — so **the JS local-runtime
gains a NATS client** (nats.js) and writes/reads the journal itself, exactly as it already
owns the run ledger:

- **Python driver (preflight)**: ensure the fabric (idempotent spawn; refuse loud on
  missing binary), ensure the stream, resolve the `--resume` group, pass
  `{journal: {url, group, resume}}` on the stdin job.
- **JS executor**: on resume, replay `h.journal.<group>` from the start (ephemeral ordered
  consumer — the `h events await` pattern), rebuild cursor/results/data, skip completed
  units; during execution, publish a record after each completed unit and treat the ACK as
  the completion barrier.

The split keeps each side doing what it already does: Python owns server lifecycle and CLI
surface, JS owns run state at the moment it exists.

### Surface

- `h chain run --local --resume GROUP …` — same expression required (validated against the
  journaled definitionHash). Continues at the journaled cursor with the journaled data.
- `h workflow run <t> --local --resume INSTANCE` — step granularity.
- `--resume` without `--local` refused by name (the service substrate's durability is the
  Dapr engine's).
- `--no-journal` opts a run out (tests, throwaway runs, a machine without the binary);
  journaling is otherwise DEFAULT-ON for `--local` workflow/chain runs. `h delegate` stays
  unjournaled — the atom is a single bounded run with nothing to resume.
- `h runs watch GROUP` — live subscription + replay over `h.journal.<group>` (increment 2).

### Steering updates owed at build time

Coupling changes documented posture, so the SAME change set updates: CLAUDE.md's execution
substrates section + `h events` prose (nats-server: from "event fabric only" to "fabric +
journal; auto-ensured"), cli/README's consumer surface (consumer prerequisite list gains
nats-server for journaled runs), `h doctor` (nats-server moves from optional to
required-for-journaling wording), and the delegate-locally + use-h skills where they state
"no watcher, ledger is the only accounting" (now: ledger + journal; resume exists).
`scripts/check-steering.mjs` will hold the CLI surface additions to their doc pairings.

## Increments

1. **Chain-level resume** (stage granularity) — journal writes in the executor's stage
   loop (`chain.ts`), replay-on-resume, the CLI preflight + `--resume`/`--no-journal`
   flags, fabric auto-ensure, refusals. Validation: kill the tooling-scout chain after
   stage 2, resume, watch it skip straight to implement.
2. **Workflow step-level resume + `h runs watch`** — `execute.ts` consults the journal
   before each step; parallel-group partial completion semantics; the live watch surface.

## Non-goals

- **A local engine daemon / workflow-svc-without-Dapr** — full operational parity stays the
  wrong target: engines exist outside workflows by design, host mode IS the local durable
  option, and a laptop daemon inherits the who-supervises-the-supervisor problem. Revisit
  when: a consumer repo genuinely needs recurrence/supervision and demonstrably cannot run
  the service stack — and then the first question is a slimmer stack bring-up, not a
  parallel engine. (NATS-as-state-plane for such a daemon is the same non-goal wearing a
  different store.)
- **Journal-driven observability** — the run ledger + obs surfaces stay the read path; the
  journal is resume state (+ live watch), not a second ledger. Revisit when: the journal
  proves to duplicate ledger content byte-for-byte and merging them would delete code.

## Log

- **2026-08-14** — scoped from the substrate-parity discussion (operator + assessment
  agreed): no local engine service (parked, trigger above); JSONL-on-filesystem initially
  locked over NATS KV and SQLite; chain-level resume named increment 1 with the scout
  chain as the live trigger. Clarified for the record: NATS was never part of the plain
  `--local` path — the fabric rides ON the local executor.
- **2026-08-14 (later)** — store decision REVISED by operator call: journal-as-stream on
  JetStream, accepting the binary dependency for journaled local runs ("we are the only
  users of h; the benefits are worth the coupling"). Design reshaped: `h-journal` stream +
  `Nats-Msg-Id` dedup, JS executor gains the NATS client (owns journal like it owns the
  ledger), Python driver auto-ensures the fabric, `--no-journal` escape hatch,
  publish-ack replaces the torn-line rule, `h runs watch` becomes increment 2's surface.
  Steering-update checklist recorded for the build change set.
- **2026-08-14 (increment 1 built + validated)** — chain-level resume landed end-to-end:
  `h-journal` third stream (limits, 14d age, 600s duplicate window) in `ensure_streams` +
  `h events status`; JS executor gains nats.js and owns the journal (`nats-journal.ts`
  JournalPort adapter, connection-per-call; `chain.ts` writes meta/stage/terminal with
  publish-ack as the stage's completion barrier, replays + hash-checks on resume);
  Python driver preflight (`_journal_preflight` → `ensure_journal_ready`: idempotent server
  spawn + stream ensure, refusal naming `--no-journal`), `--resume GROUP`/`--no-journal`
  flags with local-only + mutual-exclusion refusals; `h doctor` moves nats-server to the
  required tier named for what needs it. 6 new JS tests (in-memory journal fake: records,
  resume-skips-stages, hash refusal, no-journal, completed-no-op), 5 new CLI tests
  (default-on job config, resume group reuse, refusals, preflight gating — the fail-closed
  network guard caught the preflight in hermetic tests exactly as designed, stubbed like the
  runner); `COMMAND_FLAGS` sync guard caught the new flags. Full lint + 46 JS + 463 CLI
  tests green. LIVE: `chain-journal-poc-260814-213309` — stage 0 ($0.29) journaled, 10s
  budget tripped; resume replayed stage 0, ran only stage 1 ($0.26), completed; no-op and
  changed-composition refusal both exercised. One recorded nuance: `-p` SEEDS are
  deliberately outside the definition hash (they are fire-time chain DATA, and journaled
  captures overlay them for completed stages) — re-seeding a resume is allowed; changing the
  COMPOSITION is not. Steering updated in the same change set (CLAUDE.md substrates + fabric
  streams, cli/README, delegate-locally + use-h skills, doctor, cookbook entry).
- **2026-08-14 (increment 2 built + validated — plan COMPLETE)** — workflow step-level resume:
  `execute.ts` journals every completed step AND every parallel BRANCH individually (seq
  serialized behind one permit; the group map reconstructed from branches, so a dead panel
  re-pays only unfinished branches); `--resume INSTANCE`/`--no-journal` on `h workflow run`
  (preflight deduped into `commands/_local_journal.py`, shared with chain); `h runs watch
  GROUP` (new `runs` command group) replays a journal and follows live to the terminal record
  via an ephemeral consumer. 6 new JS tests (incl. partial-parallel resume), 4 new CLI tests.
  LIVE: `journal-wf-poc` — the plan template SIGINT-killed mid-agent-step with worktree+setup
  journaled; resume replayed both, ran only the agent, contract validated; watch printed the
  full journal and exited 0. Non-goals moved to carried-followups; steering lifted (see
  header); archived.
