---
name: write-spec
description: Write the spec a delegated implementing agent is handed — the sections, order, six rules (each with its incident), and the mechanical read-back the driver checks before reading the diff. Use whenever authoring a spec for `h delegate`, `h workflow run --local`, or `h chain run --local` against a consumer repo.
---

# Writing a spec an implementing agent can execute unsupervised

Nine `implement → create-pr` runs in two days. Spec quality was the single biggest predictor of
run quality. Every improvement was hand-rolled; by the ninth run the driver had learned six rules
that lived only in that session's memory. This skill is where they live from now on.

A spec is not instructions for you. It is a **contract** an implementing agent executes cold — no
accumulated context, no ability to ask clarifying questions. Write for the reader who cannot push
back.

## Part 1 — the shape of a spec

Every spec has these seven sections, in this order. Do not reorder them; the order is load-bearing.

### 1. Why this exists

The measured problem, with the **number** and **where it was measured**. Not "the UI is slow" but
"median load time on the dashboard is 4.2 s (Lighthouse, 2026-09-01, staging)". A spec that opens
with an instruction gets an agent that does not know what "done" is FOR — it optimises for the
letter of the instructions and misses the spirit of the goal.

### 2. Scope

What to change **and what not to touch**, by name. "Do NOT touch any flow file" is enforceable;
"try not to change too much" is not. Scope creep is only refusable when the boundary is written
down. Name the files, directories, or classes that are off-limits and the reason.

### 3. What it must do

The behaviour, as **observable facts**, not as design. "The check exits non-zero and names every
doc whose source has a newer commit than the doc itself" — not "implement a freshness check".
Observability means: if you ran the thing in a terminal, you would see this output.

### 4. The trap

The one way this task **silently produces a wrong-but-green result**. Every task has one; name
it, and tell the agent how to **prove** it was avoided. Do not leave this section blank: if you
cannot name a trap, the trap is that you have not looked hard enough.

Example: a freshness check that compares filesystem mtimes passes forever in any clone, because
every file gets the checkout timestamp — and a fresh clone or worktree is how CI and every agent
run sees the repo. The proof: run it in the main checkout AND in a fresh worktree of the same
commit, and report both counts. An mtime check reports N in one and 0 in the other; a git-time
check reports the same N in both.

### 5. Demonstrate it can fail

For any guard, test or check the spec introduces: **make it fail on purpose**, report what it
printed, revert. A check that has never been seen failing has not been tested. The failure
demonstration is not optional — it is the evidence that the check is real.

Say WHERE it is reported: the `demonstrations` field of the verify contract (what was broken,
the command, the failing lines verbatim). "Report what it printed" in prose is not checkable —
the step that opens the PR runs in another session and cannot see the terminal, so a
transcript that is not in a contract field gets reconstructed from memory.

**Incident:** a PR body quoted `not ok 27`, a line number and `got:/expected:` for a runner that
prints `have:/want:`; the real transcript (`not ok 21`) was in the implementing step's ledger and
nowhere the PR-opening step could reach.

### 6. Acceptance

The exact command(s), including the **formatters**. `format:check` is a different scope from
`format` in some repos, and an agent that ran the fix command and saw nothing change has no way
to know the check was format-only. State the starting state explicitly: "fresh worktree, no
`node_modules`, `.env` copied from `worktree.seed`". Say the baseline is taken **before any
change**.

### 7. Definition of done

A checklist an **unrelated reader** could tick. Not "the feature works" but "the acceptance
command exits 0 on a fresh worktree with both baseline and final reported, and the PR body
carries those numbers".

---

## Part 2 — the six rules

Each rule is paired with the incident that made it necessary. One sentence per incident.

### Rule 1: "Pre-existing" is a claim, and the most convenient one an agent can make

Require: the baseline command run **before** the change; the same command **after**; both exit
codes and failure counts reported; and the statement that a failure is pre-existing accepted only
when it also fails on the **base branch** (not just the worktree's HEAD before the edit).

**Incident:** a run turned `db:test` red in a file it had edited and wrote "1 pre-existing
failure unrelated to changes"; the suite exits 0 on the base branch and 1 on the run's branch.

### Rule 2: A correction needs the command that establishes it

When the spec asks for a stale claim to be corrected (a date, a commit SHA, a removed
dependency), require the command and the citation in the text. Otherwise the agent invents a
plausible date and cause.

**Incident:** "removed 2026-08-30 when the .tsx fix landed" — the real answer was a different
day, a different commit, and a different reason, found by `git log -S`.

The same rule binds the spec's AUTHOR. A test recipe the spec hands over — "assert X with
`has_table_privilege`", "use `throws_ok` on the update" — is a claim that the recipe works
against this tree, and the author is the one who can check it in seconds: run it before naming
it. "Whichever the neighbours use" is not a recipe; it delegates a design decision to the agent,
who must then either guess or substitute, and a substitute made under time pressure is where a
weaker proxy gets in.

**Incident:** a spec offered two pgTAP asserts for "a signed-in user cannot write the table";
neither could work (the grant exists, so the privilege check is true; RLS denies the UPDATE
silently, so `throws_ok` never fires). The agent found that honestly and substituted a
policy-count proxy — green with RLS switched off — which the driver then had to replace with
the behavioural assert (attempt the write as the role, read the value back). One `psql` before
writing the spec would have found both.

### Rule 3: Never satisfy a guard by silencing it

The honest fix for a true false-positive is a **named, reasoned exemption** — an entry in the
guard's own exemption list with the reason beside it, so the hole stays visible. An unused import
added to satisfy "a test imports what it tests" is a reject. A disable comment with no reason is
a reject.

**Incident:** an unused `import type` plus an `eslint-disable` line added to the flagged test to
satisfy "a test imports what it tests" — the regex was satisfied and nothing else changed. The
flag was a true false-positive (the test spawns the app as a child process on purpose), so the
honest fix was a named exemption, which is what landed.

### Rule 4: Name what a fresh worktree will not have

Gitignored env files, generated assets, installed toolchains outside the lockfile. An agent
cannot discover a file that is not there, and a missing credential reads as a red suite.

**Incident:** 37 of 47 integration test files "failed" (703 SKIPPED) because the worktree
lacked the root `.env`. If the repo declares `worktree.seed`, say so and name the files anyway
— the spec is read by the agent, the seed config is not.

### Rule 5: Never soften a failing assertion

If a test the run did not write fails, the spec's answer is "report it" — changing the expected
value, skipping the test, or widening a tolerance is out of scope by default. A spec that does not
say this will get an agent that "fixes" the test instead of the code.

**Incident:** a security-finding PR whose failing test WAS the deliverable; a run "fixing" the
assertion would have hidden the vulnerability.

### Rule 6: Machinery goes in flags and contract fields, not prose

The base branch, the agent, the model, and the acceptance command are fire-time parameters and
contract fields the run **reports**. The spec should not restate them as prose instructions,
because prose is honoured three times in four and a reader cannot tell which time this was.

**Incident:** a PR was opened against `main` with `baseBranch=beta` clearly stated in the task
text — 69 files onto the wrong branch, reverted by hand. The base is now a contract field the
run reports, which is what makes it checkable.

---

## Part 3 — the read-back

Before reading the diff, the driver checks these fields **mechanically** from the run's reported
structured blocks. A missing field is a reject.

- **`base`** (the create-pr step's block) equals what was requested — the `-p baseBranch=`
  the run was fired with.
- **`final.failures <= baseline.failures`** (the implement step's block) — a number that grew is
  a regression the run owns.
- **`baseline.commit` equals the base branch's head and `baseline.dirtyPaths` names nothing
  but the run's own plan file** (`?? plan-feature-<slug>.md`, which the `implement` template
  deliberately leaves uncommitted — so `dirty` is `true` on every implement run, and the boolean
  alone cannot tell that file from a half-written edit) — otherwise the "baseline" measured the
  agent's own work, and the inequality above is being checked against a meaningless floor.
  `final.dirtyPaths` is held to the same list: the final runs on the committed tree.
  **Incident:** a run reported a baseline of 2 failures — both format errors in files it had
  just created — and honestly noted as much in `notes`; the numbers still satisfied the check.
  **Incident:** the boolean read `dirty: true` for a whole night of runs before its first
  `dirtyPaths` report showed the only entry was the plan file.
- **`stopReason == "completed"`** for every agent step — read from the run ledger's
  `summary.json`, not the structured block; `usage-limited`, `timeout` or `failed` means the
  work is incomplete whatever the block says.

Tell the implementing agent that these three fields will be checked. An agent that knows the
driver will re-run the baseline is more careful about what it reports.

---

## Exemplar spec: git-time freshness guard

The following is a complete, real-shaped spec for a fictional guard that detects stale
documentation — a file whose git-recorded last-modified commit is older than the source file
it mirrors. It exercises every section, including the trap.

---

### Why this exists

`docs/` contains six generated `.md` files that mirror TypeScript source. On 2026-09-01, three
of them were 40+ commits behind their sources (measured by `git log --oneline docs/` vs
`git log --oneline src/`). A reviewer caught one; the other two shipped stale. This guard is the
machine check that would have caught all three.

### Scope

- **Create** `scripts/check-docs-freshness.mjs` — the guard script.
- **Wire** it into `package.json`'s `lint` chain: append
  `&& node scripts/check-docs-freshness.mjs` after `check-diagrams.mjs`.
- **Do NOT** touch `docs/` content, `CLAUDE.md`, or any other script.

### What it must do

For each file listed in `scripts/fixtures/doc-sources.json` (a map `{"docs/foo.md":
"src/foo.ts"}`), the guard reads the most recent commit that touched the doc file and the most
recent commit that touched the source file. If the source file's commit is strictly newer than the
doc file's commit, the guard prints a line:
```
STALE docs/foo.md (last updated <doc-sha>, source updated <src-sha>)
```
and exits non-zero after processing all pairs. A doc file with no git history is treated as
maximally stale (epoch commit). A source file with no git history passes (nothing to mirror yet).

### The trap

**Filesystem mtime is not git time.** A check that calls `fs.statSync(path).mtimeMs` will pass
forever in any fresh clone, because every file gets the checkout timestamp. The correct source of
truth is `git log -1 --format=%ct -- <path>`, which returns the Unix timestamp of the most recent
commit that touched the file.

**Prove it was avoided:** on the unmodified tree, in a fresh worktree, run:
```
node scripts/check-docs-freshness.mjs
```
Then `touch docs/foo.md` (one of the mirrored files) and run again. If the result changes, the
guard is using mtime. If the result is unchanged (because git does not know about the `touch`),
the guard is using git time — which is correct. Record both outputs.

### Demonstrate it can fail

Before writing the guard, temporarily add `docs/fake-stale.md` to the fixtures map pointing at
`src/foo.ts` (where `docs/fake-stale.md` does not exist, so it has no git history and reads as
epoch). Run the guard; it must print `STALE docs/fake-stale.md` and exit 1. Record the output,
then revert the fixture change.

### Acceptance

Starting state: fresh worktree, `bun install --frozen-lockfile` run, no uncommitted changes.

```sh
# baseline — run BEFORE any change:
bun run lint

# after the change:
bun run lint
```

Both runs must exit 0. Report the exit code and the number of lint errors for each.

### Definition of done

- [ ] `scripts/check-docs-freshness.mjs` exists and uses `git log -1 --format=%ct` (not mtime).
- [ ] `package.json` lint chain includes it.
- [ ] `scripts/fixtures/doc-sources.json` exists with at least one entry.
- [ ] Guard demonstrated failing (output recorded).
- [ ] Mtime trap avoided (both `touch` outputs recorded).
- [ ] Baseline lint exit 0; final lint exit 0; counts reported.
- [ ] Driver read-back: create-pr's `base` equals the requested branch, `final.failures <=
      baseline.failures`, `baseline.commit` is the base head with `dirtyPaths` naming only the
      plan file, every step's `stopReason` is `completed`.
