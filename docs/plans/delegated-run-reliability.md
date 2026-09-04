# Delegated-run reliability — move claims off prose

Status: Active — (1)–(3) landed 2026-09-02; (4) landed as h #122 (the `write-spec` skill). Three
campaigns' counts are in *Verification*: **9 of 9 → 3 of 5 → 2 of 13 merges needed repair**, and
the last two repairs were spec defects, not report defects — each report-shaped defect got its
own contract field the night it appeared and did not recur. What remains is item 7's decision
(`run-exec`), whose trigger has fired; the plan archives on that ruling.
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

*Landed 2026-09-02 (`8a93c46`): `seed: [paths]` on both substrates' `create-worktree`,
`worktree.seed` in a consumer's values (layered over stock templates via `2b5114c`), relative-only
paths, never overwrite, an escape refused before any copy. Proven against a fixture before the
commit. (1)'s fields and (2)'s `base` landed with the same series; `h workflow run --local` now
prints every contract-carrying step's validated block as `<step> ▸ {json}` (`177422a`) so the
driver reads them without opening the ledger.*

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

### 7. A deterministic `run-exec` activity (h) — found while declaring trxy's consumer values

trxy's chart runs its MECHANICAL steps (a script that prints JSON and exits non-zero on failure)
through `run-claude`, and says so in its values: *"the day a stdout-capturing run-exec lands
upstream, this line is the only change"*. Every template already declares
`activity: {{params.execActivity}}`. So today an LLM is paid to run a shell command and transcribe
its stdout — the transcription is exactly the "claim nothing forced to be true" shape this plan
exists for, applied to a step that has no judgement in it at all. A `run-exec` activity (command
in, `{exitCode, stdout, structured}` out, the output contract applied to stdout) makes the
mechanical steps impossible to misreport and free. Both substrates; the local one is a child
process, the service one is the same in an agent container.

*Revisit when: the verify overlay's baseline/final counts (item 1) have been produced by a real run
— the same activity is what would make THEM deterministic too, which decides whether `run-exec`
is a step activity or the verify overlay's own mechanism.*

## What is deliberately NOT proposed

- **More steering.** Every control that failed was already written down.
- **Removing the shepherd.** The `is_admin` finding needed "this is a product question, park it",
  which is judgement. Expect these changes to raise the floor, not remove the role.

## Verification

The claim this plan makes is falsifiable: run the same shape of campaign again after (1)-(3) land
and count how many merges required driver repair. Tonight's number was **nine of nine**.

**Second campaign (2026-09-02 20:40 → 2026-09-03 19:20, same loop shape, (1)–(3) landed first):
3 of 5 merges needed driver repair, and the shape of the three tells the story.**

| merge | repair | shape | what closed it |
| --- | --- | --- | --- |
| h #122 write-spec skill | Y — content | incidents embellished with dates/causes not in the spec | spec rule 2 (a correction needs its command) — the skill's own text |
| trxy #86 mobile types A3 | Y — report only | PR body omitted the DoD evidence the ledger held | `4394492`: object tokens render as JSON into create-pr |
| trxy #87 skate guard-pin test | Y — report only | create-pr FABRICATED the failing-test transcript it could not see | `598bf0a`: `demonstrations` contract field; create-pr forbidden to invent |
| trxy #89 rls-denial tests | **N** | — | — |
| trxy #91 mcp-atoms guard | **N** | — | — |

Two readings. First, the mechanical read-back (base, baseline/final, stopReason) was green on all
five, so (1)–(3) removed their incident classes outright — none of the night-1 table's rows
recurred. Second, every remaining defect was a REPORT the agent wrote about work that was correct,
and each one stopped recurring the night its evidence became a contract field. That is the
plan's rule confirmed from the other side: the defects that survive are exactly the claims that
are still prose.

**Third campaign (2026-09-03 21:30 → 2026-09-04 09:46, same loop shape, trxy #92–#104 —
13 merges, 12 on claude and the last on codex): 2 of 13 needed driver repair, and neither was a
report defect.**

| merge | repair | shape | what closed it |
| --- | --- | --- | --- |
| trxy #97 type-dup B1 | Y — content | a ported comment lacked the rule-2 citation the spec asked for | one-line fixup `59b69766`; the spec now names the citation as a DoD line |
| trxy #98 app-settings mcp tool | Y — content | pgTAP assert was a policy-count proxy; the spec offered two asserts that both cannot work | fixup `8c3124c9`; a spec defect, not an agent one |
| the other eleven (#92–#96, #99–#104) | **N** | — | — |

The mechanical read-back — now FOUR asserts: `base`, `final <= baseline`, `baseline.commit ==
the base head at fire time && dirty == false`, `stopReason == completed` per step — was green on
all thirteen. The one create-pr defect of the night was a codex run reporting `skipped: GitHub
MCP tool not installed` (the template named only the MCP tool; `076922a` gave it the `gh`/REST
fallback); the driver opened that PR by hand, but the CODE needed nothing. So the count moved 9/9
→ 3/5 → 2/13, and the residue is now spec quality, which is the `write-spec` skill's territory,
not this plan's.

*Revisit when: item 7 (`run-exec`) has its operator decision, or a delegated run produces a
defect shape not on any table above. The campaign count is no longer the open question.*
