---
name: diagrams
description: The visual communication layer — canonical mermaid diagrams under docs/diagrams/ that model h's architecture and interactions, updated in the same change that alters what they model, rendered to images for cross-device communication. Use when explaining a change to the operator, when a change alters an interaction a diagram models (update it in the same change), when asked to "show" or "diagram" how something works, or when adding a new canonical diagram to the set.
---

# Diagrams — communicating through pictures, not prose walls

The operator and the assistant iterate fast; prose summaries of changes pile up faster than
they can be read. The fix: diagrams as the communication medium, in TWO GENRES:

- **Canonical** — the core set under `docs/diagrams/`, modeling the architecture AS IT IS.
  Registered in the index, update-with-the-change, drift-checked where generated. The rules
  below govern these.
- **Transient** — diagrams that EXPRESS AN IDEA: a proposed change in a plan doc, a design
  alternative in a conversation, a before/after in a PR body. They live inside their host
  document and die with it (plans are transient; so are their pictures). NOT registered in
  the index, NOT drift-checked, allowed to show intention rather than reality — that is
  their whole job. Render them the same way (`tools/diagrams/render.sh <path/to/doc.md>`)
  and share the PNGs.

A transient diagram GRADUATES to canonical when, after its change lands, the picture keeps
being the way the system gets explained — then it moves to `docs/diagrams/`, gets reframed
to model reality, and joins the index.

## Enriching a plan with change diagrams (the standard proposal workflow)

When a plan item proposes a change to interactions or contracts, put the diagrams IN the
plan doc (transient genre): typically one sequence diagram (how the flow changes) and one
class diagram (how the contracts change), then render and share the images so the proposal
is reviewable on any device.

**The delta-color convention** — make what is NEW or CHANGED visually obvious:

- classDiagram: `classDef added fill:#dcfce7,stroke:#16a34a` (green = new),
  `classDef changed fill:#fef9c3,stroke:#ca8a04` (amber = behavior/shape changes),
  untouched elements stay default. The `:::` tag must sit ON THE DECLARATION
  (`class X:::added {`) — a standalone `class X:::added` after a bodied declaration is
  silently ignored. Body lines must keep parens BALANCED per line (an unbalanced `(` crashes
  mermaid's member parser). State the legend in prose.
- sequenceDiagram: wrap NEW interaction segments in `rect rgb(220,252,231)` … `end`
  (green tint); mark changed messages with a `[CHANGED]` prefix; leave unchanged machinery
  untinted and say so in a Note.

## The three rules (canonical genre)

1. **Sources are the truth, one home each.** A diagram is one `docs/diagrams/<name>.md`:
   a short prose frame, ONE mermaid fence, reading notes. GitHub, IDEs, and Claude artifacts
   render the fence natively — the markdown IS the cross-device format. Never duplicate a
   diagram into another doc; link to it.
2. **Update-with-the-change** (the cookbook's rule, applied to pictures). If a change alters
   an interaction a diagram models — a new step, a new participant, a moved responsibility —
   the diagram updates IN THE SAME change set. The diagram diff is the change explanation.
   A stale diagram is worse than none.
3. **Model reality, not intention.** Verify the flow against code (or a live run) before
   drawing it. A diagram that shows what we meant to build communicates the wrong thing.
   (Drawing implement-pr-run surfaced that the saved workflow was stale — modeling forces
   verification.)

## Rendering to images (for chat, Slack, a phone)

```sh
tools/diagrams/render.sh                      # all diagrams → docs/diagrams/rendered/*.png
tools/diagrams/render.sh implement-pr-run     # just one
```

Self-provisioning: mermaid-cli lives in the gitignored `tools/diagrams/.deps/` (installed
with `bun add`, NOT a bun-workspace member — puppeteer/chromium must never burden CI or the
app images). `rendered/` is
gitignored; render on demand and share the PNG (in a Claude session: `SendUserFile` the PNG,
or publish the .md as an artifact — both render the diagram).

## Generated diagrams (C4 code level) — the AST is the truth for members

Level-4 diagrams date fastest, so they are GENERATED, not hand-drawn:
`tools/diagrams/gen-code-diagram.mjs` extracts members (interface methods/props, union arms, module
function signatures) from the TypeScript AST, while SCOPE, TOPOLOGY, and NOTES stay curated
in a manifest embedded in the doc (`<!-- gen:c4-code {json} -->`). This keeps the c4-code
guide's story-members-only rule honest: curation picks the symbols, the parser never lets
their members go stale.

- **Never hand-edit a generated fence** — edit the manifest (scope/relations/notes) or the
  code, then `node tools/diagrams/gen-code-diagram.mjs`. Drift is a LINT FAILURE
  (`--check` runs in `bun run lint`), so a refactor that changes a diagrammed contract
  fails the build until the diagram regenerates.
- The division of labor with the c4-mermaid-plugin: the PLUGIN defines what the diagram
  types are (conventions, syntax, validation); OUR tooling automates producing them to
  those conventions.
- The tooling is a composable toolkit at `tools/diagrams/` (sanitize / ts-extract /
  mermaid-class / managed-doc; unit-tested via `node --test`, wired into root test), with
  thin CLIs on top; `tools/` is the dev-tooling home beside `tools/ci-runner/`. Its README
  records WHY it is deliberately not a `packages/js/*` workspace member (zero-build lint
  ordering; never ships in app images; source-level extraction needs no dependency edge)
  and the in-place graduation path (add a package.json there — a standalone bun package on
  the `web/` precedent) if the family grows. A new generator = new extractor + assembler +
  thin CLI; the doc plumbing and sanitizer are shared.
- Manifest gotcha: it lives in an HTML comment, so no `--` sequences anywhere in the JSON
  (relations use `null` for the default arrow; notes avoid literal `--flags`).

## Authoring guidance

- **Kinds**: sequence diagrams for interactions (the default — this is a runtime whose
  interesting facts are message flows); C4 (via the c4-mermaid-plugin skills — load the
  matching `c4-*` skill and follow its syntax + required validation step) for structure;
  state diagrams for lifecycle rows (watch/chain/cron statuses). The `code-comprehension`
  plugin produces EPHEMERAL diagrams in answers; when one keeps getting redrawn, it
  graduates into docs/diagrams/ under these rules.
- **Scope**: one diagram = one story a reader keeps needing told. 6–9 participants max in a
  sequence; compress repetition with `loop` ("the run-* pattern") and show it in detail once.
- **Annotate the invariants**, not just the arrows — the reading-notes section names the
  load-bearing properties (mark-before-fire, the gate, fail-before-PR) with step numbers.
- **Register it**: add a row to `docs/diagrams/README.md`'s table in the same change.
- **Mermaid syntax traps** (each bit a real diagram): no commas in `loop`/`alt`/`opt`
  LABELS, and no semicolons ANYWHERE in message text (`;` is a statement separator — the rest
  of the line parses as a new statement). Render before committing:
  `tools/diagrams/render.sh <name>` is the syntax check.
- **Mermaid C4 layout traps**: `UpdateLayoutConfig` goes at the TOP (after `title`), and —
  the big one — LONG element descriptions stretch shapes to full row width, silently
  collapsing the grid to one component per row. Keep descriptions to a phrase (≤ ~40 chars;
  file name in the technology slot); put the detail in the reading notes. Compiling is not
  enough for C4 — LOOK at the render before committing.

## The set and its growth

`docs/diagrams/README.md` is the index — current set + the planned list. Grow it by NEED:
when an explanation gets written twice in prose, that is the signal to add the diagram. Do
not pre-draw the whole system.
