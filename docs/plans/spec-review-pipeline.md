# Spec review pipeline — review the plan before it becomes a prompt

Status: Active — the status line said "not built" until 2026-08-25, which was two templates out
of date. Re-verified against the tree that day: the machinery EXISTS and the plan overshot its own
acceptance in one place. Outstanding is the live-validation criterion alone.
Established: 2026-07-27

## Origin

Two failures on 2026-07-27, one day apart in kind:

1. **trxy PR #54** — a spec scoped from a stale plan doc asked for work that already
   existed. The run implemented it faithfully, the review panel returned CLEAN, and the PR
   had to be closed unmerged. The panel was not wrong: spec-aware review asks "does this
   diff satisfy the spec", and it did. **A spec built on a false premise is structurally
   invisible to the review loop.**
2. **h PR #80** — the plan's own acceptance demanded two things that could not both hold
   (runtime spec threading AND a byte-identical spec-less render). Three review rounds
   surfaced the contradiction but could not resolve it; the operator had to amend the
   plan mid-flight.

Both are the same defect class: **the spec was wrong before any agent read it**, and every
downstream mechanism — implement, verify, review, revise — faithfully executed the error.

The operator's insight (2026-07-27): a spec IS a plan document, plan documents are
source-controlled, so a spec can be a PR — reviewed by a panel, merged, and only then
executed. Once in main it is hard and ready to be carried out.

**Live evidence the shape works:** the `team-skate-design` chain (batch 2) was run
design-only for risk reasons, producing `docs/plans/team-skate-games.md` as its
deliverable. Its review panel found, on paper, that the proposed result model "does not
define a coherent `loser_usr_id` value for N-player individual wins" — a data-model hole
that, caught after implementation, is a migration to undo. That run was the pipeline's
first instance by accident; this plan makes it deliberate and repeatable.

## Two tiers, both first-class

The pipeline must NOT become mandatory ceremony — most changes are bounded and are best
planned and carried out in one session. Two supported paths:

- **Direct (light).** Bounded work with settled premises: spec authored in-session,
  implement + review loop as today. Unchanged from current practice. This stays the
  default for fixes, single-seam changes, and anything the driver can hold in their head.
- **Spec-reviewed (heavy).** Larger or riskier work: a SPEC CHAIN produces the spec as a
  plan doc in the TARGET repo, opens a PR, a panel reviews it, revisions land, it merges to
  main. Only then does an IMPLEMENT CHAIN run against the merged doc.

Choosing the tier is a driver judgement, not a rule engine. Heuristics for heavy:
touches a data model or migration; several interlocking design questions; cross-cutting
invariants; the plan is an idea stub rather than a scoped design; or the work will span
more than one chain.

## Design

### 1. The spec lives in the target repo, and the implement chain POINTS at it

Today specs are scratchpad files spliced in with `-p spec=@file` — durable only inside the
chain row. Under the heavy tier the spec is a source-controlled plan doc in the repo being
changed, so the implement chain can reference it by path.

This REFINES the existing DRIVER.md convention ("never bare plan-doc pointers for
cross-repo targets — splice content"). The reason for that rule was that an agent working
in repo X cannot read a plan doc living in repo h. When the spec lives in the SAME repo the
agent has checked out, a pointer is correct and strictly better: no drift between the
prompt and the doc, and the doc is diffable, reviewable, and permanent. Splicing remains
right for cross-repo direction (an h plan driving trxy work).

### 2. Spec review is a DIFFERENT contract from code review

`review-pr`'s checklist is code-shaped (correctness, scope, docs accuracy, test evidence).
A spec wants different questions, and they are exactly the ones that would have caught our
two failures:

- **Premise check** — does the spec assert things that are true of the repo TODAY? Every
  claim of the form "X does not exist" / "Y is not covered" gets verified against the tree.
  (This is what #54 needed.)
- **Internal consistency** — can every acceptance criterion hold simultaneously? (This is
  what #80 needed.)
- **Completeness** — are open questions named as open, or silently decided? A decided
  question needs its rationale and its rejected alternatives.
- **Checkable acceptance** — could an implementer prove each criterion? "Works well" fails;
  "command X exits 0" passes.
- **Scope integrity** — is the work bounded, and does it say what is explicitly NOT in
  scope?
- **Feasibility** — does the design fit the repo's existing seams, or does it quietly
  imply forking machinery?

Mechanism: a new `review-spec` chart template (sibling of `review-pr`, same
CLEAN/FINDINGS contract so `loop-until-clean` works unchanged), OR `review-pr` with a
`mode` param. Prefer the separate template — the prose differs enough that overloading
one template would muddy both, and the one-declarer composition rule keeps them cheap.

### 3. Independent critical review, always — spec conformance is necessary, not sufficient

Separate from the pipeline, `review-pr`'s prose needs a correction that #54 exposed:
satisfying the spec must never be the whole test. A reviewer keeps full independent
judgement — "does this change duplicate work that already exists?", "is this change worth
making at all?", "is the spec itself wrong here?" — and a finding that the SPEC is
mistaken is a first-class finding, not out of scope. Ship this regardless of the pipeline;
it is a small prose change with immediate value.

## Acceptance

**Re-verified 2026-08-25** — check the tree, not this list:

- [x] `review-spec` template exists (`cli/charts/workflows/templates/review-spec.tmpl.yaml`),
      publish-native on `repo`/`slug`/`pr`/`focus`, and reuses the existing `review-pr` chain kind
      and verdict contract rather than introducing an engine kind — so `loop-until-clean` drives it
      unchanged, exactly as this plan required. Golden: `test_review_spec_golden`.
- [x] `review-pr` prose carries the independent-judgement correction
      ("NOT SUFFICIENT — full independent review judgement always applies on top of it"),
      goldens re-blessed.
- [x] DRIVER.md documents both tiers and the choosing heuristics (§*Choosing a workflow tier*:
      direct/light as the default, spec-reviewed/heavy for data models, migrations, interlocking
      design questions, cross-cutting invariants, idea stubs, or multi-chain work — never mandatory).
- [x] **Overshot:** a THIRD review landed that this plan never scoped — `review-plan.tmpl.yaml`,
      which reviews a plan *in flight* (the text a planning agent just produced, against the request
      that prompted it) rather than a spec already sitting in a PR. `review-pr` reviews a DIFF,
      `review-spec` a spec PR, `review-plan` a plan while changing course is still cheap. That
      closes the #80 half of the origin story more directly than the spec-PR tier does, since #80's
      contradiction was IN the plan, not in a spec built from it.
- [ ] `h chain run` expressing the heavy tier end-to-end — expressible today (the members and the
      threading exist); never run as one composed chain.
- [ ] **The remaining gate: validated on one real change** — a spec PR drawing at least one
      substantive finding that would otherwise have surfaced during or after implementation. This
      is the criterion the plan cannot retire itself on, because the whole premise is that a
      false-premise spec is invisible to review, and only a live run tests that.

### Original acceptance (as scoped 2026-07-27)

- A `review-spec` template exists, declares the CLEAN/FINDINGS contract, and drives
  `loop-until-clean` unchanged.
- `h chain run` can express the heavy tier end-to-end: spec chain → spec PR → review loop
  → (operator merge) → implement chain reading the merged doc by path.
- `review-pr` prose carries the independent-judgement correction, goldens re-blessed.
- Validated on one real change: a spec PR draws at least one substantive finding that would
  otherwise have surfaced during or after implementation.
- DRIVER.md documents both tiers and the choosing heuristics.

## Non-goals

- Making the heavy tier mandatory. Ceremony on bounded work is a cost, not a safeguard.
- A separate spec REGISTRY or new primitive — a spec is a plan doc in a repo; the existing
  chain/review machinery carries it.
- Automating the tier choice.

## Log

- 2026-07-27 — Scoped from the #54 miss, with #80 as the second data point and the
  `team-skate-design` run as accidental proof the shape catches real design defects
  (`loser_usr_id` undefined for N-player individual wins, found on paper). Operator framed
  the symmetry: spec = plan doc = source-controlled = reviewable PR; both tiers must stay
  first-class.
