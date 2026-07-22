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
| `Complete` | Implemented, durable context lifted out, ready to archive to `docs/plans/impl/` (core plans).                                 |

Keep the status line honest and current — it's the first thing anyone (human or
agent) reads to know where the work stands.

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
2. Move the file: `docs/plans/<name>.md` → `docs/plans/impl/<name>.md`.

Domain-specific plans (`docs/plans/domain/`) have no archive step — delete or keep
locally once the work lands.

## Archiving checklist (core plans)

Before you move a plan to `impl/`, confirm:

- [ ] Status is `Complete` with a one-line outcome.
- [ ] Every piece of lasting context has a home outside the plan, linked from a
      "Lifted to:" list — nothing unique is left only in the plan.
- [ ] Sub-plans it spawned are themselves resolved or have their own status.

If you can't point to where a finding now lives, it isn't lifted yet — finish
step 4 before archiving.
