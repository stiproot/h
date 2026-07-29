# Chain engine follow-ups — issues #76–#79, implemented locally

Status: Complete — all four issues (#76–#79) implemented and unit-tested in one change set 2026-07-25; wire smoke green
Established: 2026-07-25

Lifted to:
- Chain activation gates (`--after <chainId>`, `--at`/`--in`) and persist-only registration → the Chain bullet in [CLAUDE.md](../../../CLAUDE.md) + `chain.model.ts`.
- Terminal-stage captures landing on the finalized row → `chain-scan.ts`'s shared capture step.
- The loop × stages resolution (`startCursor` is a STAGE; loop-segment stages must be single-member) → `chain_expr.py` / `chain.py`'s registration validation, and recorded on [inline-chain-cron-composition](./inline-chain-cron-composition.md), whose open sub-question it closed.
- Worktree reuse-by-branch → `packages/js/git-core/src/git-client.ts` `addWorktree`.
- The zero-glue two-chain pattern it unlocked → [docs/cookbook.md](../../cookbook.md).

## Scope

The four issues lifted from the supervised-batch retrospectives, in dependency order:

1. **#77 — terminal captures**: `executeAdvance` captures the completed stage's outputs into the
   chain data; the completed-finalize path does NOT — so a chain's LAST stage never lands its
   captures on the finalized row. Fix: one shared capture step run on every completed stage,
   including the finalize and loop-clean paths.
2. **#79a — non-blocking `/chain/run`**: `registerChainForFire` persists the row AND eagerly fires
   stage 0 in the request path — a slow/hung fire blocks the handler past client timeouts, and a
   died fire strands a `scheduling` row that the UNKNOWN streak then finalizes `orphaned`. Fix:
   registration persists and returns; the SCAN fires a `scheduling` stage whose members are all
   UNKNOWN (attach-by-default makes a re-fire of an actually-started instance safe), converting
   the orphan window into self-healing. The streak stays as the backstop for degraded reads on
   rows that HAVE fired.
3. **#79b — loop × stages**: chain.py emits `loop.startCursor` as a MEMBER index; the engine
   treats it as a STAGE cursor. Fix CLI-side: startCursor = the review member's STAGE; stages
   before the loop segment may be concurrent (the panels shape), stages inside the loop segment
   (startCursor..last) must be single-member — refused loud at registration otherwise. Engine
   unchanged.
4. **#76 — worktree reuse-by-branch**: `addWorktree` fails when the branch is checked out in ANY
   existing worktree. Fix in git-core: consult `git worktree list --porcelain` first and return
   the existing worktree's path for the requested branch (idempotent across workspaces — the
   issue's option (b): solves the collision; the disk-leak half stays open, revisit if it bites).
   Members that need a fresh base already `fetch + reset --hard origin/<branch>` themselves.
5. **#78 — chain activation conditions** (the design decision): a chain row gains OPTIONAL
   `after?: chainId` and `notBefore?: ISO` activation gates, checked by the same scan branch that
   fires un-fired `scheduling` rows (#79a):
   - `notBefore` in the future → wait (no streak).
   - `after` set → read the parent row: finalized `completed` → ACTIVATE (merge the parent's
     finalized data under the child's data where absent — parent seeds, child's own `-p` wins —
     then fire stage 0); finalized otherwise → finalize the child `terminated` with an explanatory
     note (never run a review of a failed implement); absent → wait, orphaning via the streak.
   - CLI: `h chain run --after <chainId>`, `--at <iso>` / `--in <dur>`.
   This is the issue's "chain-arms-chain" reframed as the CHILD declaring its dependency — no new
   registry, single-writer intact, the engine alone sequences, and "registration is data" (#79a)
   makes it one scan branch. Scheduling a chain falls out of `notBefore` for free. The
   supervisor-glue batches reduce to: register the implement chain and its `--after` review chain
   up front; the engine does the rest (#77 supplies the prNumber, #76 unpins the branch).

## Deliberately not in this change

- Worktree deletion on finalize (the leak half of #76) — reuse makes it benign; a lifecycle
  sweep can follow if disk pressure appears.
- `--panel N` / attribution / cosmetics (panels plan findings 4–5).

## Acceptance (the zero-glue smoke)

Register two chains up front on a live stack:
`h chain run --slug X -t implement verify create-pr …` and
`h chain run --slug X-review --after X --input pr=prNumber … --strategy loop-until-clean` —
the pair runs implement → PR → panel review → revise to review-clean with ZERO out-of-band
commands (no manual prNumber, no worktree frees, no chain-run glue).

## Log

- 2026-07-25 — Plan written; implementation in dependency order #77 → #79 → #76 → #78, engine +
  CLI + tests in one change set, closing all four issues.
- 2026-07-25 — Implemented in one change set: terminal captures on finalize + loop-clean paths
  (#77); persist-only registration with the scan's activation branch firing/attaching
  fire-then-mark (#79a); `after`/`notBefore` activation gates with parent-data seeding, abort on
  a failed parent, orphan-streak on an absent one (#78); CLI `--after`/`--at`/`--in`;
  startCursor as the review STAGE + single-member loop-segment refusal (#79b); reuse-by-branch
  in git-core/addWorktree returning the effective path, primary checkout excluded (#76).
  Engine 313 + CLI 260 + git-core 16 green; 8 new behavior tests.
