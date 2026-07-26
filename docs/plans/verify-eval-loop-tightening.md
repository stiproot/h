# Verify & eval loop tightening — acceptance deduced, review evidence-checked

Status: Implemented — 2026-07-26
Established: 2026-07-26

## Origin

The trxy-v2 trial (PRs #42–#46) shipped a behavioral change to six core services with **no test
run anywhere in the loop** — and post-hoc validation (654/654 integration tests, run by hand)
showed we got lucky, not safe. The agent's log contains zero test deliberation: three layers of
context each said "lint is done" (the operator-supplied verifyCmd, the target repo's own
`verify` script, its steering). The review panel didn't flag the omission because nothing asks
it to. Separately, reviewers audit a PR against its OWN description — the original spec never
reaches them even though the chain data carries it end-to-end.

The through-line: h was too PRESCRIPTIVE about acceptance (an operator-guessed command became
the definition of done) and too PERMISSIVE about evidence (no one checks that done was proven).

## Enhancements (one plan, three seams)

1. **De-prescribe verify — acceptance is deduced from the target repo's context.**
   The `verify` overlay's prose changes shape: the supplied `verifyCmd` becomes the FLOOR, and
   the agent is instructed to determine the repo's FULL acceptance from its own context (its
   CLAUDE/steering, docs, scripts — e.g. a repo whose coverage lives in `test:integration`),
   run what applies to the change it made, and REPORT in its output what it ran and why that is
   sufficient. A code-touching change that runs no tests must say so explicitly and justify it.
   The structured contract stays unchanged (verify PASS/FAIL); the prose carries the duty.
2. **Spec-aware review, optional by design.**
   Diff-only review stays the default and stays valuable (sometimes the diff IS the subject).
   When a `spec` param is supplied, `review-pr` renders an `===ORIGINAL SPEC===` section and the
   review checks the diff satisfies THE SPEC, not merely the PR's self-description. The
   review-pr kind contract passes `spec` through from chain data when present (the same optional
   passthrough pattern as clonePath/verifyCmd) — every existing chain already seeds `spec`, so
   the zero-glue pairs gain this with no new CLI surface.
3. **Review evidence check.**
   The review-pr checklist gains one item: when the diff touches code, the PR body must carry
   test-execution evidence proportionate to the change (which suites ran, or an explicit
   justified exemption) — absence is a FINDING. This tightens the eval loop from the reviewer
   side regardless of what the implementer did, and composes with (1): the implement leg now
   produces exactly the evidence the review leg demands.

## Non-goals

- Choosing any target repo's test strategy (that lives in the target repo's own steering —
  see trxy's ways-of-working plan for its half).
- Hard-failing verify on missing tests mechanically — repos legitimately differ; the mechanism
  is deduce-and-justify plus reviewer enforcement, not a universal gate.

## Acceptance

- A code-touching run against a repo whose steering demands integration tests runs them (or
  loudly justifies not doing so) with only the floor command supplied.
- A chain-seeded spec reaches the review prose at FIRE time: the `spec` param is an
  always-open runtime slot rendered like the existing `focus` param (token always present,
  section inert when empty). A spec-less review's BEHAVIOR is unchanged, but the render is
  deliberately NOT byte-identical to the pre-change template (the empty section exists) —
  the accepted cost of runtime threading. Chart-time gating was rejected: it silences
  fire-time specs (PR #80's round-1 review finding).
- A PR body without test evidence on a code diff draws a review FINDING (validated
  post-merge in a live panel run — an operational check, deliberately not provable inside
  this diff).
- Goldens re-blessed deliberately; template guards stay green.

## Log

- 2026-07-26 — Scoped from the trial's sharpest finding (tests skipped by construction, not by
  disobedience) after hand-validating PR #43 (654/654 integration green). Sibling plan on the
  trxy side covers the target-repo half (verify script includes tests; mobile e2e mandatory on
  mobile-consumed changes).
- 2026-07-26 — Implemented all three seams: (1) verify.tmpl.yaml re-framed to floor + deduce-full
  acceptance; (2) review-pr.tmpl.yaml + values.yaml gain optional spec param;
  chain-members.ts threads spec from chain data; two unit tests added; (3) review-pr
  checklist gains test-evidence bullet. Goldens re-blessed after reviewing .ambr diff.
  Test evidence: bun run lint (23/23), bun run build (16/16), bun run test (319 tests);
  uv run --package h-cli pytest — 260 pass, 2 FAILURES in test_chain.py (non-hermetic tests
  needing the gitignored values.local.yaml; pre-existing on base, tracked as issue #81, fixed
  by PR #85 — NOT green, just not this PR's breakage).
- 2026-07-26 — The PR #80 review loop (3 panel rounds) exposed a contradiction in this plan's
  original acceptance: "runtime spec threading" and "byte-identical spec-less render" cannot
  both hold. Resolved for runtime threading via the focus-param pattern (always-rendered
  token, inert when empty); acceptance above amended to match. The loop also demanded the
  test-evidence wording in this log be exact (it was: "pytest green" hid two failures) —
  the eval loop tightening this plan ships caught its own PR's evidence imprecision, which
  is the point.
