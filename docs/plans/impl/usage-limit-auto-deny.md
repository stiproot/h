# Auto-deny on usage-limit: the engine fences an exhausted provider itself

Status: Complete — built, unit-tested, and deployed 2026-07-29 (operator green-lit the design
the same day); the automatic trigger's LIVE validation happens on the next real usage-limited
run — the wiring is engine-side and covered by scan tests
Established: 2026-07-29
Lifted to: the CLAUDE.md `exec:` registry bullet (row shape with provenance/expiry, the two
writers, the same-agent-fallback fail-fast semantics); the decision surface in
`domain/exec-policy.ts` (normalizeDenied/activeDenial/mergeAutoDeny + DEFAULT_AUTO_DENY_MS,
each carrying its why); the watcher wiring in `domain/watch-scan.ts` (executeAutoDeny beside
executeFinalize); scan + domain + CLI tests.

## The idea

When one run finalizes as `usage-limited`, the whole fleet should stop trying that provider
— instead of every subsequent chain burning wall-clock (and half-provisioned worktrees)
discovering the limit independently. Today the deny is manual (`h agents deny X`); the
detection is already automatic (`classify-stop` → the `run:` mirror's `stopReason` → the
watcher's finalization). This plan closes the loop: **the watcher, on finalizing a
`usage-limited` outcome, writes the executor into `exec:config` itself.**

Everything meets in workflow-svc, which is already the `exec:` registry's single writer — the
wiring is small. What needs planning is the semantics.

## Design questions to settle (the reason this is `Planning`)

1. **Row shape.** Today `denied` is `string[]`. Auto-deny wants per-entry provenance and
   expiry: `{name, reason: "operator" | "usage-limited", deniedAt, until?}`. The gate,
   the router, and `h agents` all read the shape — evolve it NOW, while the row is a day
   old and nothing else depends on it, rather than migrate later.
2. **Un-deny.** Manual only, or timed expiry? Provider reset windows differ (5h rolling for
   some, daily for others), so a single default is wrong. Likely: an optional `until` on
   auto entries (default from a per-provider table or a conservative constant), manual
   entries never expire. **An auto-lift must never lift an operator deny** — provenance is
   what makes that safe.
3. **Interaction with the usage-limit fallback**
   (docs/plans/impl/schedule-and-fallback.md). The fallback arms a continuation under a
   DIFFERENT agent — auto-deny must fence only the limited executor, never the fallback
   path. And a `--fallback-after` continuation on the SAME agent would be refused by its
   own deny unless the expiry aligns. These two features are siblings reading the same
   signal; they must compose, not race.
4. **Panels.** One branch hitting the limit denies the executor → concurrently-running
   sibling panels naming it will fail at their gate. That is consistent with the loud-refusal
   stance (docs/plans/live-state-containment.md §2.3 design), but say so explicitly and
   verify the chain-failure ledger makes the cause obvious.
5. **Flap resistance.** A single false-positive `usage-limited` classification (classify-stop
   is positive-match-only, but still) denies a healthy provider fleet-wide. Consider: deny on
   first signal (simple, matches the incident) vs. N-in-a-window. Lean simple; the cost of a
   wrong deny is bounded by expiry + `h agents allow`.

## Sketch (to be firmed)

- `watch-scan`'s outcome finalization: on `stopReason: usage-limited`, resolve the run's
  executor (from the run mirror / wf identity), merge an auto entry into `exec:config`
  (idempotent; never downgrade an operator entry), bump the watch ledger with a
  `autoDenied` count, publish the terminal event with the deny noted.
- `h agents list` shows reason/since/until; `h agents allow X` clears any entry kind.
- Tests: engine decide-level (finalize → deny row written), gate honors expiry, operator
  entries survive auto-lift.

## Relationships

- [live-state-containment](./live-state-containment.md) §2.3 built the enforcement this
  plan triggers automatically; its design (loud refusal, single-writer, shortnames) is
  inherited, not restated.
- docs/plans/impl/schedule-and-fallback.md owns the fallback continuation this must compose
  with (question 3).
- [model-fallback-continuity](./model-fallback-continuity.md) — the broader
  keep-working-across-provider-limits arc; this plan is its fencing primitive.

## Log

- 2026-07-29 — Stub created out of the live-state-containment session: the manual deny was
  built and live-verified the same day; the operator asked for the automatic trigger to be
  planned properly rather than bolted on.

## Log

- 2026-07-29 — Green-lit and built in one pass. The five Planning questions resolved as: (1)
  row shape evolved to provenance entries, bare strings still read as operator entries (no
  migration — the day-old live row normalizes on read); (2) expiry via a single conservative
  DEFAULT_AUTO_DENY_MS (6h) on auto entries only, operator entries never expire, `h agents
  allow` lifts either; (3) fallback composition: a DIFFERENT-agent fallback is untouched; a
  SAME-agent deferred continuation is refused while the fence holds — deliberate fail-fast,
  the deny expiry is the effective retry gate (encoded at DEFAULT_AUTO_DENY_MS's definition);
  (4) panels: sibling branches naming the fenced executor fail loud at the gate, consistent
  with §2.3's loud-refusal stance; (5) flap resistance: deny on first signal (classify-stop is
  positive-match-only; a wrong deny is bounded by expiry + one CLI command). mergeAutoDeny is
  the safety core: never downgrades operator entries, idempotent across scan ticks, replaces
  only expired auto entries. Live-fire validation deferred to the next real usage-limited run.
