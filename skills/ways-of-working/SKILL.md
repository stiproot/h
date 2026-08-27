---
name: ways-of-working
description: How we collaborate while building h — explain changes in plain language rather than h's internal vocabulary, lead with a RENDERED diagram (via vizzle) instead of paragraphs when the subject is design or architecture, treat h as ours to improve rather than work around, and build missing tooling as priority work instead of routing around it. Use whenever you are about to explain a design decision, describe how something works, propose an approach, or write more than a couple of paragraphs of architectural prose; and whenever you hit a missing tool, a broken command, or a defect in h while doing something else. Applies to work on the h repo ONLY — never impose these on a target repo.
---

# Ways of working

How we build h together. This is the collaboration layer: not what to build, but how to explain
it, and what to do when the tooling gets in the way.

**Scope guard:** these are h's conventions, for work on h. An agent h fires at some other
repository follows THAT repo's conventions — do not carry these across.

---

## 1. Explain in plain language; save the vocabulary for the artifact

h's own docs are deliberately dense. ARCHITECTURE.md, CLAUDE.md and the plan set carry a precise
internal dictionary — *chain member*, *stage*, *the arm-\* pattern*, *rung-2 seam*, *fire
descriptor* — and that density is correct there, because those files are read by someone who
needs the exact term and a machine guards the vocabulary.

**A conversation is not that artifact.** While we are iterating and ideating, the same density
becomes a cost: it forces the reader to hold a glossary in their head to follow a point they have
not agreed to yet. Worse, precise jargon can *sound* like a settled conclusion when it is really
a proposal, which makes it harder to push back on.

So when explaining a change in conversation:

- **Lead with what changes and why it matters**, in words that would make sense to a competent
  engineer who has never read this repo. Then name the h term once, if the term is going to
  matter later.
- **Prefer the concrete over the categorical.** "The nightly retro reads yesterday's runs and
  files what it finds" beats "the retro member's `since`-scoped invocation mines the ledger and
  emits h-vocabulary findings through the issue seam."
- **One idea per sentence.** h's docs use long compound sentences with em-dashes to pack context
  into a line someone will re-read. In conversation the reader is reading once.
- **When you need a term, spend one clause defining it** rather than assuming: "a chain member —
  one workflow in an ordered sequence — …".

The test: *could the reader disagree with this without first decoding it?* If not, simplify. The
committed doc is where the precision goes; keep the conversation about the idea.

This does not mean vague. Numbers, file paths and concrete behaviour are exactly what make plain
language convincing — the thing to drop is unexplained vocabulary, not detail.

---

## 2. Lead with a rendered diagram, and actually send it

`CLAUDE.md`'s *Diagrams are the medium* section is the where-and-when policy, and the `diagrams`
skill carries it. This adds the part that keeps getting skipped: **rendering it and putting the
image in front of the operator.**

A mermaid fence in a reply is not a diagram — it is source code for one. Much of this work
happens through remote Claude sessions read **on a phone**, where a fence is unreadable and an
image is perfect. So finishing the job means producing the PNG.

The recipe, when explaining design or architecture:

```sh
# 1. write or update the doc (canonical set lives in docs/diagrams/, indexed in its README)
# 2. render it — this IS the syntax check
uvx vizzle@0.2.0 render docs/diagrams/<name>.md docs/diagrams/rendered
# 3. LOOK at the PNG before sending. mermaid will happily emit a valid-but-unreadable column.
# 4. send the image so it lands in the conversation, not just on disk
```

Then send the rendered file to the operator rather than only describing it. `docs/diagrams/rendered/`
is gitignored on purpose: render on demand, share the image.

Three things worth knowing before you fight the layout:

- **`UpdateLayoutConfig($c4ShapeInRow=…)` is inert** in the pinned mermaid — C4 lays out two
  shapes per row whatever you write, so you cannot widen your way out of a tall column. The
  levers that work are `UpdateRelStyle($offsetX/$offsetY)` for colliding labels, and splitting an
  over-full diagram in two.
- **Tall is fine; wide is not.** A long vertical diagram scrolls naturally on a phone.
- **The render can be broken rather than the diagram.** `mmdc` drives headless Chrome; if
  puppeteer has no browser it fails with a stack trace that looks like a diagram error. Fix with
  `npx puppeteer browsers install chrome-headless-shell` — and see §4, because that is a tooling
  gap, not a diagram problem.

Generated `-class` diagrams are drift-checked (`uvx vizzle doc --check`, in lint), so regenerate
those with `uvx vizzle doc` rather than hand-editing. Hand-authored sequence and C4 diagrams have
**no guard at all** — if a change alters what one models, updating it is on you, in the same
change set.

---

## 3. h is ours — improve it rather than work around it

We own this repo. When work in h surfaces a rough edge in h, that is not a distraction from the
task; it is the most valuable thing the task produced. The friction was paid for already — the
only question is whether anything comes back for it.

Route it by size:

- **Small and in front of you** — a stale doc line, a missing flag, a guard that should exist:
  fix it in the same change. `CLAUDE.md` already asks for this for invariants ("add or extend its
  guard in the same change, not a follow-up").
- **A clean unit of work someone could land as one PR:** file it with the `h-issues` skill so the
  discovery cron or a human can pick it up.
- **Needs a decision first:** it is a plan, not an issue — see `CLAUDE.md`'s *PLAN OR ISSUE*
  test. Park it with a `Revisit when:` trigger rather than leaving it implicit.
- **Big enough to delegate:** h can build h. Fire it as work — `h delegate`, `h workflow run
  --local`, or a chain — rather than doing everything in the driving session. The
  `delegate-locally` skill covers when that is worth it.

The failure mode to avoid is silent accommodation: noticing something is wrong, adapting around
it, and moving on. The adaptation is invisible, so the defect survives and every later run pays
it again.

---

## 4. Missing tooling is priority work, not a detour

If you are about to work around a missing or broken tool — do it by hand, skip the check, paste
source instead of an image, add a manual step to a runbook — **stop and build the tool first.**

The reasoning is that a workaround is paid every single time, by everyone, forever, while the
tool is paid once. h exists because that trade kept coming out the same way. A workaround also
hides the gap: once someone has routed around it, nothing records that the thing is missing, so
it never gets fixed on purpose.

In practice, when starting a piece of work:

- **Name the tooling it needs before starting**, and check each piece actually works. A command
  documented in a runbook is not evidence it runs on this machine.
- **When something is missing, building it comes first** — ahead of the work that revealed it.
  Then do the original work with the tool in place.
- **Encode it where it will fire again.** A fix in your head helps once; a script, a guard, a
  `Makefile` target or a skill helps every time. The `check-*.mjs` guards in `bun run lint` are
  this principle's main output — each one is an invariant somebody decided was worth a machine
  checking rather than a human remembering.
- **Say what you built and why**, so the cost is visible and the operator can disagree.

A worked example, from the session that produced this skill: explaining a corrected architecture
diagram required rendering it, and the render failed — puppeteer had no browser. The workaround
(paste the mermaid source and describe it in prose) would have been faster once and useless
forever, on a phone especially. Installing the browser took one command and made every future
diagram renderable. Then the diagram went out as an image.
