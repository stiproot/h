# Fail loud at registration when a chain member's required inputs cannot be satisfied

Status: Planning — full spec below (rescued 2026-07-29 from an ephemeral scratchpad); awaiting
operator sign-off on the registration-refusal behavior before building
Established: 2026-07-29

A chain member can be registered in a state that CANNOT work, and the engine accepts it. The
failure then surfaces minutes later, deep inside an activity, as an error about something
else entirely. Harness defect #4 of 4 from the 2026-07-28 batch
(docs/plans/harness-batch-continuation.md §2); the other three are fixed or carried.

Reproduced live 2026-07-28.

## The reproduction

```sh
h chain run --slug demo -p repo=owner/name -p spec=@brief.md \
  -- -w plan --kind answer --agent claude openhands --input spec=spec --capture plan=plan
```

Registration **succeeds**. The run then dies in the worktree activity with:

```
git worktree of …/repo at …/worktrees/demo failed: git exited with code 255:
Preparing worktree (new branch 'feature/')
fatal: 'feature/' is not a valid branch name
```

Nothing in that message mentions the actual cause: **`slug` was never supplied, so the
`{{params.slug}}` token resolved to empty and the template built the branch name
`feature/` + "".**

## Why it happens

- The `plan` template provisions a worktree and therefore requires `slug`.
- `plan` has no entry in the closed `MEMBER_KINDS` literal, so it must ride another kind —
  in practice `--kind answer`.
- The `answer` kind's coded contract supplies only `{ task }` (`chain-members.ts`, the
  `answer` entry). It has **no worktree**, so it never needed a slug and does not provide one.
- Declaring `--input` replaces the coded input half, so the member's inputs become exactly
  what the operator declared — here just `spec`.

Result: a member whose template demands `slug` is registered with nothing supplying it.

**Contrast with the kinds that do it right.** `implement-pr` and `revise-pr` call
`requireStr(data, "slug", "…needs a slug on the chain data")` and fail LOUD with an accurate
message. The gap is that this check lives in each kind's hand-written `buildParams` rather
than in registration, so a member riding a mismatched kind is unprotected.

## What to build

**Validate at REGISTRATION that every parameter a member's definition references can be
satisfied.** Registration already validates the other half — a declared `--capture` is checked
against the member's declared `outputs` schema — so this closes a real asymmetry:
**outputs are checked, inputs are not.**

Sketch (adapt to the actual code):

1. From the member's resolved definition (inline `steps` or the fetched saved definition),
   collect every `{{params.X}}` token referenced in step inputs, and the declared `params:`
   defaults block.
2. Compute what will actually be supplied at fire time: the coded kind contract's
   `buildParams` keys, plus declared `--input` mappings, plus chain-level `-p` seeds, plus
   fire-time identity params (`runActivity`/`agentId`/model slots).
3. A referenced param that (a) has no non-empty default in the definition's `params:` block
   and (b) is not supplied by any of the above ⇒ **fail registration** naming the member, the
   parameter, and the likely fix.

Message should be actionable, e.g.:

```
member 'plan' (kind: answer) references {{params.slug}}, which nothing supplies.
  the 'answer' kind's contract provides: task
  you declared:                          spec
  fix: add --input slug=slug (or seed it chain-wide with -p slug=…)
```

**Be conservative about false positives.** A param with a legitimate non-empty default in the
rendered `params:` block is satisfied — do not flag it. If a param's value can only be known
at fire time and genuinely may be empty (`clonePath` is the example: empty means "use the
shared default"), it must not fail. Prefer under-reporting to blocking a valid chain: a false
positive here is worse than the current bug, because it blocks working compositions.

**Related, do NOT bundle:** the absence of a first-class `plan` member kind
(docs/plans/carried-followups.md §2) is the root cause of *this* instance, but the
validation gap is general and would still exist with a `plan` kind. Fix the validation here;
leave the kind alone.

## Tests

- A registration test asserting the exact repro above is REFUSED, with the parameter named
  in the error.
- A registration test asserting a well-formed equivalent (`--input slug=slug` added) is
  ACCEPTED.
- A regression test that a param with a real default (or a legitimately-empty one such as
  `clonePath`) does NOT trip the check — this is the false-positive guard and matters most.

## Acceptance

- `bun run lint`, `bun run build`, `bun run test`, `uv run --package h-cli pytest cli/h/tests`
  all green. **Run lint — do not report green without running it.**
- Report the actual commands run and their real output in the PR body.

## Log

- 2026-07-29 — Spec rescued verbatim from the ephemeral scratchpad the batch left it in
  (docs/plans/harness-batch-continuation.md §2.1 flagged the path as mortal). No CLI flags
  change; what changes is REGISTRATION BEHAVIOR — previously-accepted (broken) compositions
  are refused — so it waits for operator sign-off per the surface-change preview rule.
