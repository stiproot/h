# Delegated-run reliability — move claims off prose

Status: Planning — nine supervised runs against trxy on 2026-09-01/02 produced one recurring
defect shape; this plan converts the highest-cost instances from prose to checked or impossible.
Established: 2026-09-02

## The premise, and the evidence for it

Nine `implement → create-pr` runs, every one verified by hand before merge. **Not one was safe to
merge on its own report**, and every defect had the same shape: *a claim that nothing forced to be
true*. The agent could not tell it was wrong, and nothing else in the loop could either.

| what was claimed | what was true | cost |
| --- | --- | --- |
| PR opened against the requested base | opened against `main` | 69 files onto main; reverted |
| "1 pre-existing failure, unrelated" | it broke the test itself | nearly merged a red suite |
| "removed 2026-08-30 when the .tsx fix landed" | `f428b3d1`, 2026-08-31, a CI commit | a fabricated provenance in a plan |
| a test imports the code it tests | an unused `import type` + eslint-disable | a guard silenced, invisibly |
| 37/47 integration files failing | worktree missing the root `.env` | nearly rejected a PR that found a live security hole |

A sixth belongs to the driver, not the agent: **I stopped checking the PR base** after two runs,
because a `-p baseBranch` parameter made it feel guaranteed. It is not — it is prose handed to a
non-deterministic executor, honoured three times in four.

**The controls that failed were all written down clearly, in the place the agent reads.** More
emphatic prose is not the fix; it is the lever that already did not work.

## The rule this plan applies

For any value that MUST hold, in order:

1. **Impossible** — can the shape prevent the failure?
2. **Checked** — can a machine verify it after the fact?
3. **Prose** — only if neither.

Judgement stays at 3 and belongs there: what is out of scope, when to stop, whether a policy
SHOULD deny. Everything above it does not.

## The changes, in leverage order

### 1. `verify` reports baseline and final as CONTRACT FIELDS (h) — biggest single win

Today the acceptance overlay asks in prose for a baseline (added 2026-09-01, `417c57f`). Prose
cannot stop a run concluding "pre-existing, unrelated", which was the most expensive failure of
the night and the hardest to disprove — it took running the suite on the integration branch to
show otherwise.

Make the contract carry `baseline: {command, exitCode, failures}` and `final: {…}`, and fail the
step when `final.failures > baseline.failures`. **"Pre-existing" stops being an opinion and
becomes arithmetic.**

*Open decision: is the comparison enforced in the engine (both substrates, no driver needed) or by
the driver (simpler, but only helps a supervised run)? Engine is the better answer if the fields
are reliably produced; that needs proving first.*

### 2. `create-pr` reports the base it used (h) — smallest change, removes an incident class

One field on the existing contract. The driver asserts it matches what was requested. Removes the
only incident of the night that reached `main`, and removes it from the set of things a human has
to remember.

### 3. `create-worktree` seeds declared gitignored files (h) — the one worth making impossible

A worktree is correctly a clean checkout. A consumer that keeps real credentials in gitignored
files therefore hands its agents a tree that fails for reasons they cannot see — and "pre-existing,
unrelated" is the only conclusion available from inside it. It cost time twice and nearly cost a
good PR. Let a run declare paths to seed from the clone, operator→worktree only, never the reverse.

### 4. A spec-writing skill (h) — the underrated one

Spec quality was **the single biggest predictor of run quality**, and every improvement was
hand-rolled and lives nowhere: name the acceptance command including formatters; demand the fix be
DEMONSTRATED able to fail; require the command behind any correction; name the gitignored files a
fresh worktree will lack; forbid softening a failing assertion; state what is out of scope so
scope creep is refusable. The last spec of the night was materially better than the first for
reasons none of which are written down.

### 5. Plan measurements carry their commands (plan-management) — the fourth surface

`plan-management` 0.4.0 already requires validate-before-pickup, and it WORKED: it caught stale
claims in four of seven plans. The gap is one level down. A plan's numbers are prose, so
re-validating them is an exercise a human performs rather than something a machine does — and
tonight a plan measured TWO DAYS earlier had wrong counts (11/9 vs an actual 20/5), while another
advertised two items that had already shipped.

Proposed: a plan's measurements carry the command that produced them in a runnable block, plus a
`Groomed:` header line recording when it was last validated and the verdict. Then "is this plan
still true" is a command, not a judgement call. (This repo already writes `Groomed:` lines by
convention — they were invented ad hoc on 2026-09-01 and used consistently; the skill should own
the convention rather than each repo reinventing it.)

### 6. Guards need reasoned exemption lists (trxy pattern, generalise)

A guard with no exemption mechanism gets satisfied by whatever is cheapest — an unused import, in
one case. Two guards landed with explicit named-and-reasoned exemptions; that shape should be the
default, because **a visible hole beats a silenced one.**

## What is deliberately NOT proposed

- **More steering.** Every control that failed was already written down.
- **Removing the shepherd.** The `is_admin` finding needed "this is a product question, park it",
  which is judgement. Expect these changes to raise the floor, not remove the role.

## Verification

The claim this plan makes is falsifiable: run the same shape of campaign again after (1)-(3) land
and count how many merges required driver repair. Tonight's number was **nine of nine**.

*Revisit when: (1)-(3) have landed and a second campaign has run — or sooner if a delegated run
produces a defect shape not on the table above, which would mean the premise is incomplete.*
