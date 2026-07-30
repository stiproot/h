---
name: plan-management
description: >
  The workflow for planning docs in the h repo: how to create a plan in
  docs/plans/ (or docs/plans/domain/ for a local, domain-specific change), use it
  as a living tracking log while implementing (recording findings, learnings,
  decisions, and blockers as you go), spawn sub-plans, and — critically — lift any
  lasting context into its one long-lived home before archiving a finished core
  plan to docs/plans/impl/. Use this whenever you are about to write a plan or
  tracking doc, are doing work a plan tracks, are finishing or archiving a plan, or
  when the user refers to "the plan", a tracking doc, planning an approach, or next
  steps — even a casual "let's plan this out" or "update the plan". This is the
  meta-process for the plan docs themselves; it composes with domain skills like
  author-workflow-template or hex-node-service (use those for the work, this for
  the doc). Adapted for h from the trxy plan-management discipline.
---

# Plan management

Plans are how non-trivial work is scoped and tracked in this repo. A plan starts
as a design, becomes the running log of the implementation, and ends by handing
its lasting lessons to permanent homes and archiving itself. The point of the
discipline is that **the repo's long-lived knowledge never depends on a plan** —
plans are transient, so anything that must outlive the work has to be lifted out
before the plan is filed away.

Do NOT leave plans in the harness scratch location (`~/.claude/plans/…`) — that is
the plan-mode default, not this repo's home. Move any plan you write there into
`docs/plans/` (or `docs/plans/domain/`) as soon as it is real.

## Where plans live

Two tiers, matching the committed `.gitignore` split:

- **Core / architecture plans** — source-controlled. A change to a primitive, a
  new composition, a cross-cutting invariant, anything a teammate should see.
  - **Active/in-flight:** `docs/plans/<name>.md`
  - **Archived (done):** `docs/plans/impl/<name>.md`
- **Domain-specific plans** — local only (`docs/plans/domain/` is gitignored).
  An h-change with narrow domain details that doesn't need to be source-controlled.
  - `docs/plans/domain/<name>.md` — no archive lifecycle; delete when done or keep
    locally. If a domain plan turns out to carry durable architecture value, lift
    it to a core plan.

There is no separate index file in h — the `docs/plans/` directory listing plus
each plan's status line IS the index. (Plans predating this convention, 2026-07-22,
don't yet carry status lines; that's fine — retrofit only when you touch one.)

**Large plans split into a subdirectory.** If a plan is too large for one readable
doc (rule of thumb: it has several independent areas/phases, or a single file would
run past ~1000 lines), make it a directory instead of a monolith:
`docs/plans/<name>/README.md` (the index — carries the plan-level status line,
shared context, and a table linking the parts) plus one doc per area/phase
(`01-<area>.md`, `02-<area>.md`, …), each with its OWN status line so the index
table + part statuses show at a glance where the work stands. Shared context
(background, cross-cutting instructions, refuted alternatives) lives ONLY in the
README — parts link back to it, never restate it. Archive the whole directory as a
unit: `docs/plans/<name>/` → `docs/plans/impl/<name>/`, gated on every part being
`Complete`. (First instance: `docs/plans/hardening-audit/`.)

Every plan starts with a status line and a one-line summary, e.g.:

```markdown
# <Title>

Status: Active — <one-line what/why>
Established: <YYYY-MM-DD>
```

## Status vocabulary

| Status     | Meaning                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Planning` | The plan itself needs design/scoping before implementation can start. A plan is born here if the approach isn't settled yet.  |
| `Active`   | Being implemented. The doc is the live tracking log — keep it current.                                                        |
| `Blocked`  | Implementation is stuck. Record the blocker (what, why, what would unblock) in the doc.                                       |
| `Deferred` | Parked, not abandoned — a real idea nobody is working on. MUST carry a `Revisit when:` line naming what brings it back.      |
| `Complete` | Implemented, durable context lifted out, ready to archive to `docs/plans/impl/` (core plans).                                 |

Keep the status line honest and current — it's the first thing anyone (human or
agent) reads to know where the work stands.

**`Deferred` exists so a parked idea doesn't have to lie.** Before it, a stub sat at
`Active` (misleading) or got archived as if finished (burying open questions where
nobody looks). A `Deferred` plan stays in `docs/plans/`, reads as parked at a glance,
and names its own trigger — so the decision to revive it is a lookup, not an
archaeology exercise.

## Enforced, not just conventional

`scripts/check-plans.mjs` runs on every `bun run lint` and fails on:

- a missing or `**Status:**`-spelled status line, an off-vocabulary status, or a
  missing `Established: YYYY-MM-DD`;
- a `Deferred` plan with no `Revisit when:` trigger;
- a `Complete` plan still sitting in `docs/plans/`, or a non-`Complete` plan in `impl/`;
- an archived plan with no `Lifted to:` list (the archiving checklist's central gate);
- **any `docs/plans/` reference in SOURCE CODE** (`apps/`, `packages/`, `cli/`, `web/`,
  `scripts/`, the charts) — plans are transient, so a plan pointer in code is rationale
  parked in a file that will be archived and forgotten. State the rationale in the comment
  itself, or cite the durable home (`ARCHITECTURE.md`, `CLAUDE.md`, a skill, the cookbook).
  This is the lift-on-archive discipline applied at WRITE time (swept clean 2026-07-30);
- any `docs/plans/**.md` path cited from a NON-source file outside `docs/plans/` (steering
  docs, runbooks — where pointing at in-flight work is legitimate) that does not resolve —
  archiving a plan silently rots such citations.

Two deliberate non-rules. The guard never infers that a plan *should* be archived —
several are legitimately long-lived, and archiving is gated on a lift-then-archive
judgment no regex can proxy; it only checks that what a plan claims is well-formed.
And plan **bodies** are exempt from the link check: a plan is a point-in-time record,
so it may cite a doc since retired (the same exemption `check-vocabulary.mjs` makes).

If you add a status to the table above, add it to `STATUSES` in the guard — they are
deliberately kept in lockstep.

## The lifecycle

### 1. Create — the starting point

Write the plan in `docs/plans/` (core) or `docs/plans/domain/` (local). Capture the
goal, the approach, and the steps. Set `Status: Planning` if the approach still
needs working out, or `Active` if you're starting implementation immediately.

### 2. Implement — the plan is the tracking doc

As you work, the plan is your running log, not a frozen spec. Append **findings**
(what you discovered about the system), **learnings** (what surprised you / what
you'd do differently), **decisions** (what you chose and why), and **blockers**.
Update the status as it changes. This running trail is what makes a plan resumable
by someone else — or by you after a context reset.

### 3. Spawn sub-plans as needed

Work often uncovers a distinct, separable effort. When it does, create another
`docs/plans/<sub>.md` rather than overloading the current one. If that sub-effort
needs its own design first, it's born `Status: Planning`; if it's ready to execute,
`Status: Active`. Cross-link parent and sub-plan so the relationship is discoverable.

### 4. Lift durable context out — the step that matters most

Before a core plan is archived, move anything that must live on out of the plan and
into its **one** long-lived home (rule of one home — put it in exactly one place and
link, don't restate). h's homes:

| Lasting context                                | Goes to                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Why the system is shaped this way / a primitive| `ARCHITECTURE.md` (the conceptual home) — with the terse index in `CLAUDE.md` |
| An operational how-to / workflow / convention  | a skill: `.claude/skills/` (repo session) or `skills/` (agent-facing harness) |
| A rule/invariant that should be enforced       | a lint rule (dependency-cruiser / import-linter) + the relevant `CLAUDE.md` note — the *Harden by encoding* principle |
| A recurring runtime gotcha / how-to-run detail | a `CLAUDE.md` "Key gotchas" entry, or `docs/*-runbook.md` for a human runbook |
| Something the assistant should remember across sessions | an auto-memory under the memory dir + a `MEMORY.md` pointer   |
| Why a specific line of code is the way it is   | a comment at that code                                                  |

After lifting, the plan should contain only its transient trail (what happened, in
what order) — no unique knowledge that anything else needs.

### 5. Complete and archive (core plans)

When the work is done and context is lifted:

1. Set `Status: Complete — <one-line outcome>`, and add a short "Lifted to:" list
   linking where the durable context now lives.
2. Move the file: `docs/plans/<name>.md` → `docs/plans/impl/<name>.md` (a split
   plan moves as a whole directory: `docs/plans/<name>/` → `docs/plans/impl/<name>/`).

Domain-specific plans (`docs/plans/domain/`) have no archive step — delete or keep
locally once the work lands.

### Deferred items an otherwise-finished plan leaves behind

A plan is often done except for one or two items it deliberately parked. Don't keep the
whole plan `Active` for them, and don't drop them on archive. Move them to
**`docs/plans/carried-followups.md`** (`Status: Deferred`) — the single home for items
carried out of archived plans — and point the plan's `Lifted to:` line at the section.
One greppable home beats a scatter of near-empty follow-up docs.

An item leaves that doc by being built, by becoming a GitHub issue (the h-builds-h
loop's queue — the route `panels-as-a-modifier` took for #76–#79), or by being
explicitly dropped with a reason.

## Archiving checklist (core plans)

Before you move a plan to `impl/`, confirm:

- [ ] Status is `Complete` with a one-line outcome.
- [ ] Every piece of lasting context has a home outside the plan, linked from a
      "Lifted to:" list — nothing unique is left only in the plan.
- [ ] Deferred leftovers are in `docs/plans/carried-followups.md`, not stranded.
- [ ] Sub-plans it spawned are themselves resolved or have their own status.
- [ ] **Citations still resolve.** `ARCHITECTURE.md`, `CLAUDE.md`, and the skills may cite
      plans by path (source code may NOT — see Enforced above); moving one to `impl/`
      breaks every citation. Rewrite them in the same change — `check-plans.mjs` will fail
      the build if you don't, but fixing them yourself keeps the diff coherent.
- [ ] Relative links INSIDE the moved file still resolve — it just gained a directory
      level, so `../../ARCHITECTURE.md` becomes `../../../ARCHITECTURE.md`.

If you can't point to where a finding now lives, it isn't lifted yet — finish
step 4 before archiving.
