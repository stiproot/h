# resumable local runs — a JSONL journal so a dead driver's spend survives it

Status: Planning — scoped 2026-08-14 (store decision locked: JSONL beside the run ledger); increment order and journal format below awaiting build
Established: 2026-08-14

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

## Store decision (locked 2026-08-14)

**Plain JSONL beside the run ledger.** `<runsDir>/<group>/journal.jsonl`, append-only, one
record per completed unit. Rationale, recorded so it isn't relitigated:

- **Not NATS JetStream KV** — NATS is an OPTIONAL piece of one feature (`h events`),
  operator-provisioned and refused by name; journaling there would make plain `--local`
  runs depend on a daemon that is optional today (dependency inversion: the fabric rides ON
  the substrate, never under it). Everything JetStream is good at — delivery, consumers,
  watches — is concurrency machinery a single-writer/single-reader journal never touches.
  The fabric remains the answer to a DIFFERENT question: durable delivery BETWEEN runs;
  the journal is resumable state WITHIN a run. They compose — a relay-executed step is an
  ordinary local run and resumes like one.
- **Not SQLite** — transactions and queries an append log doesn't need, at the cost of a
  native module (or the still-experimental `node:sqlite`), an opaque binary beside
  otherwise human-readable local artifacts, and this repo's existing SQLite scar (the
  2026-07-05 name-resolver WAL lock-stall).
- **JSONL is the house pattern with fresh endorsement** — the run ledger is already
  `events.jsonl` replayed on read, and the pi-autoresearch scout specifically flagged its
  `.auto/log.jsonl` + replay-on-restart (`reconstructJsonlState`) as the pattern worth
  learning. This plan is that pattern applied to h itself.

## Design

### Journal format

One JSONL file per run group, written by the executor (JS side — `h-local` owns execution,
so it owns the journal; the Python CLI only reads it to answer `--resume` preflight
questions). Records:

- `{"seq": n, "type": "meta", "kind": "workflow"|"chain", "definitionHash": "...",
  "group": "...", "ts": ...}` — first line; the hash is over the composed definition/member
  set, so resuming under a silently-changed composition refuses loud.
- `{"seq": n, "type": "step", "stepId": "...", "result": {...}, "structured": {...}, "ts"}`
  — a workflow step completed (parallel groups: one record per branch + one for the group).
- `{"seq": n, "type": "stage", "cursor": k, "data": {...}, "ts"}` — a chain stage completed
  and captured; `data` is the full chain data AFTER capture (small — structured fields, not
  transcripts), so stage-level resume needs exactly one record read.
- Torn-write rule: a final line that fails to parse is treated as ABSENT — the unit it
  described redoes. You can only lose the record of the unit in flight at death, which is
  the unit that must redo anyway. At-least-once per unit; agent steps are re-fired
  idempotently (same instance id reuses the worktree, the established re-fire semantics).

### Surface

- `h chain run --local --resume GROUP …` — same expression required (validated against the
  journal's definitionHash; mismatch refuses loud, no `--force` in the first increment —
  a changed composition is a NEW run, by design). Continues at the journaled cursor with
  the journaled chain data.
- `h workflow run <t> --local --resume INSTANCE` — same shape at step granularity.
- `--resume` without `--local` is refused by name: the service substrate's durability is
  the Dapr engine's, not the journal's.

### Increment order

1. **Chain-level (stage granularity) first** — cheapest, and the increment the scout run
   would have used: the stage record already carries the complete post-capture chain data,
   so resume = read last stage record, set cursor+data, re-enter the existing stage loop
   (`chain.ts`). No change to step execution.
2. **Workflow-level (step granularity) second** — `execute.ts` consults the journal before
   each step; completed steps load results instead of running. Parallel-group semantics
   (partial branch completion) live here, which is why it is second.

## Non-goals

- **A local engine daemon / workflow-svc-without-Dapr** — full operational parity is the
  wrong target: the engines exist outside workflows by design, host mode IS the local
  durable option, and a laptop daemon inherits the who-supervises-the-supervisor problem.
  Revisit when: a consumer repo genuinely needs recurrence/supervision and demonstrably
  cannot run the service stack — and then the first question is a slimmer stack bring-up,
  not a parallel engine.
- **Journal-driven observability** — the run ledger + obs surfaces stay the read path;
  the journal is resume state, not a second ledger. Revisit when: the journal proves to
  duplicate ledger content byte-for-byte and merging them would delete code.

## Log

- **2026-08-14** — scoped from the substrate-parity discussion (operator + assessment
  agreed): no local engine service (parked, trigger above); JSONL-on-filesystem locked
  over NATS KV and SQLite with rationale recorded; chain-level resume named increment 1
  with the scout chain as the live trigger. Also clarified for the record: NATS was never
  part of the plain `--local` path — the events fabric rides ON the local executor
  (relay → ordinary local runs), so the journal composes with it rather than replacing it.
