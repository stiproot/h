---
name: night-campaign
description: Run an overnight h campaign — a queue of delegated units, each groomed, specced, fired, gated by the driver, and merged, with a scratchpad that survives context compaction and a morning hand-over. Use whenever the operator starts or resumes a nightly/overnight loop, says "let's do another night run", asks you to shepherd delegated runs against a consumer repo, or invokes /loop for campaign work — and whenever you are the driver deciding what to fire next, whether to merge, or how to hand over. Also use when a run finishes and you must decide accept-or-reject.
---

# Night campaign — the overnight driver loop

An overnight campaign is a QUEUE of small units, each taken through the same cycle by a driver
session that never writes the feature code itself. It is the shape that produced 23 merged PRs in
one night against trxy, every one gated before merge.

**This skill is the campaign shape only.** It deliberately does not restate what already has a
home, and those homes are authoritative where they overlap:

| For | Read |
| --- | --- |
| The driver ROLE, merge protocol, fallback-driver limits, run-ledger diagnosis | `docs/DRIVER.md` |
| How we build and communicate (plain language, rendered diagrams, tooling-first) | `ways-of-working` skill |
| Writing the spec an agent executes, and the read-back fields | `write-spec` skill |
| Grooming a plan before scoping from it | `plan-management` skill + CLAUDE.md *Plans* |

If this file and `docs/DRIVER.md` ever disagree about merging, DRIVER.md wins — fix this file.

## The loop

Each iteration handles ONE unit. Never widen it because the queue looks long.

1. **Groom the next unit against the tree** — claims still true, goal still wanted. Measure, do
   not recall: counts come from a command. Record the verdict either way; a rejection with
   evidence is a successful iteration.
2. **Write the spec** (`write-spec`). Name the trap. Name the stack's own guides if the code is
   governed by any — skills are trigger-loaded on a description match, so a spec that never says
   "Effect" gets an agent that never loads the Effect rules.
3. **Fire one run**, `--on-quota wait`, and arm a Monitor on its stderr so step events wake you.
4. **Read back mechanically** before reading the diff: `base`, `final.failures <= baseline.failures`,
   `baseline.commit` == the head you fired from, `baseline.dirty`, every step `stopReason:
   completed`, and `closes` when an issue was named.
5. **Re-run the numbers yourself.** A recount the spec asked for is checked by running the command,
   not by trusting the table. A mismatch is a reject.
6. **Run the acceptance gate in the worktree** — see *The gate* below.
7. **Merge, stamp, groom the next unit** into the tracking doc, push, remove the worktree.
8. **Append the iteration to STATE.md** with a timestamp from `date`.

## The gate — the one non-negotiable

**Never merge on an agent's green claim.** Run the acceptance yourself, in the run's own worktree,
including the touched test file TWICE (the second run is what proves teardown works). Say GATE-OK
or reject with a reason.

Additional checks, each of which caught a real defect:

- **`src` diff empty** when the spec said test-only. If it is not, read it: it may be a genuine
  production fix the conversion exposed (that is how `checkAccess`, which returned `false` for
  every spot, was found) — accept it only if the run DECLARED it, and then widen the gate to the
  full suite because production code changed.
- **Doc diff**: no removed lines beyond the status phrase, no duplicate entry, and **no PR number**
  — the driver stamps that at merge. A run once guessed `(#116)` correctly and it was still wrong.
- **Assertions, not just results.** Read whether the tests can fail: assertions inside
  `if (…)` guards, `toBeDefined()` on a degrading op, or a filter over shared data are green
  without proving anything.

## The scratchpad set

Four files in the session scratchpad. They exist because context compacts mid-campaign and a
successor — including you, later — must be able to resume from files alone.

| File | Holds | Written |
| --- | --- | --- |
| `PLAN.md` | the rules, the queue, one numbered item per unit with its verdict | at groom |
| `STATE.md` | the running log: what fired, what merged, what was found | every iteration |
| `FRICTION.md` | tooling friction hit while doing something else | when hit |
| `MORNING.md` | the hand-over: one action first, then decisions | continuously |

`MORNING.md` is the night's deliverable, not a summary written at the end. Keep it current as
facts change — a hand-over that lists PRs the operator merged hours ago costs them more time than
no hand-over. Re-measure its headline numbers against the tree before handing over.

## Pacing and parallelism

- **Read the quota row before every fire** (`h agents list --local`). Near a ceiling, cut a
  SMALLER unit rather than idling — leaving 25% of a window unused is waste, not safety.
- **One run per target repo** when the units share a database; a second run's integration tests
  will fight the first over the same rows. Runs against h itself may go alongside — h's gate
  touches no DB.
- Use the wait between steps: groom the next unit, write its spec, keep the hand-over current.
  The queue should never be waiting on you.

## Landing the work

- Stack every PR on the campaign branch (`beta`), never `main`; the operator merges the branch.
- Where main is branch-protected, a driver run PARKS its PR for the operator — say so rather than
  reporting it as done.
- Resolve conflicts by **rebase**, not `git merge`, when the repo's merge flow is rebase-based: a
  merge commit makes GitHub's rebase button refuse ("cannot be rebased").
- Remove each worktree after merge. When the collector refuses one for unpushed commits, verify
  the WORK is on main (file-level, not the PR's label — squash merges leave the tip unreachable)
  before overriding.

## Failure modes this loop has actually hit

- **A completed step discarded for a malformed report.** 34 minutes and $4.80 of correct, committed
  work thrown away because the final JSON block had the wrong shape. Salvage it: verify the diff,
  run the trap demonstration yourself, gate it, push the branch and open the PR by hand.
- **Arithmetic instead of measurement.** A PR body reported "962 → 945" by subtracting conversions;
  the recount said 953. Specs must demand the command's OUTPUT, and the driver re-runs it.
- **A green local gate and a red CI on identical code.** Assertions on rendered CLI output wrapped
  differently because CI's checkout path is longer. Assert on width-normalised text.
- **The baseline measured before the build.** A fresh worktree is unbuilt and this repo's CLI tests
  import built `dist`, so the baseline reported two phantom failures. Build, THEN baseline.
- **An assertion satisfied by other people's data.** A test filtered a shared feed and asserted
  non-empty; any other worker's row satisfied it. Assert on the fixture's own id.
