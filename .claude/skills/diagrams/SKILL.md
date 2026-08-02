---
name: diagrams
description: h's canonical-diagram policy — the WHERE AND WHEN for diagrams in this repo. Canonical mermaid diagrams live under docs/diagrams/, registered in the index, named <scope>-<kind>.md, and REGENERATED/UPDATED in the same change that alters what they model; transient diagrams enrich plan docs and die with them. The mechanics (generated-diagram toolkit, mermaid/C4 traps, delta colors, rendering) are the generated-diagrams plugin skill — this skill says where and when in h, that one says how. Use when explaining a change to the operator, when a change touches a part of the system a canonical diagram models (regenerate/update it in the same change), when asked to "show" or "diagram" how something works, or when adding a new canonical diagram to the set.
---

# Diagrams — h's canonical set and its rules

**Composition: the `generated-diagrams` plugin skill (code-comprehension plugin) says HOW —
the manifest format, extractors, mermaid/C4 syntax traps, the delta-color convention, the
UML-component encoding, rendering. THIS skill says WHERE AND WHEN in h.** Load that skill
for any mechanics question; everything below is h policy.

The operator and the assistant iterate fast; prose summaries of changes pile up faster than
they can be read. The fix: diagrams as the communication medium, in TWO GENRES:

- **Canonical** — the core set under `docs/diagrams/`, modeling the architecture AS IT IS.
  Registered in the index, update-with-the-change, drift-checked where generated. The rules
  below govern these.
- **Transient** — diagrams that EXPRESS AN IDEA: a proposed change in a plan doc, a design
  alternative in a conversation, a before/after in a PR body. They live inside their host
  document and die with it (plans are transient; so are their pictures). NOT registered in
  the index, NOT drift-checked, allowed to show intention rather than reality — that is
  their whole job. Render them the same way (see Rendering below) and share the PNGs.

A transient diagram GRADUATES to canonical when, after its change lands, the picture keeps
being the way the system gets explained — then it moves to `docs/diagrams/`, gets reframed
to model reality, and joins the index.

## The steering rule: regenerate-on-touch

**When a change touches a part of the system a canonical diagram models — a diagrammed
contract, an interaction with a new step/participant/moved responsibility — regenerate or
update that diagram IN THE SAME CHANGE.** Concretely:

- Generated (`-class`) docs: `gen-code-diagram --dir docs/diagrams` regenerates;
  `gen-code-diagram --check --dir docs/diagrams` is the drift gate and runs in
  `bun run lint` (the bin ships in the `@stiproot/code-comprehension` devDependency), so a
  refactor that changes a diagrammed contract FAILS THE BUILD until the diagram regenerates.
- Hand-authored docs (sequence/state/C4 framing): edit the doc, re-verify against the code.
- Render to confirm: via the `generated-diagrams` plugin skill —
  `bash "${CLAUDE_PLUGIN_ROOT}/skills/generated-diagrams/scripts/render.sh" docs/diagrams docs/diagrams/rendered`
  (or a single doc as the first arg; fallback with no plugin:
  `bunx -p @mermaid-js/mermaid-cli mmdc --quiet -i docs/diagrams/<name>.md -o docs/diagrams/rendered/<name>.png --scale 2 --backgroundColor white`).
  `docs/diagrams/rendered/` is gitignored — render on demand and share the PNG.

## Enriching a plan with change diagrams (the standard proposal workflow)

When a plan item proposes a change to interactions or contracts, put the diagrams IN the
plan doc (transient genre): typically one sequence diagram (how the flow changes) and one
class diagram (how the contracts change), then render and share the images so the proposal
is reviewable on any device. Use the delta-color convention (green = new, amber = changed,
red = rejected — the plugin skill has the exact classDefs/tints); exemplar: the
fire-descriptor plan's arbitration-conflict diagram.

## The three rules (canonical genre)

1. **Sources are the truth, one home each.** A diagram is one `docs/diagrams/<name>.md`:
   a short prose frame, ONE mermaid fence, reading notes. GitHub, IDEs, and Claude artifacts
   render the fence natively — the markdown IS the cross-device format. Never duplicate a
   diagram into another doc; link to it.
2. **Update-with-the-change** (the cookbook's rule, applied to pictures). If a change alters
   an interaction a diagram models — a new step, a new participant, a moved responsibility —
   the diagram updates IN THE SAME change set (see the steering rule above for the exact
   invocations). The diagram diff is the change explanation. A stale diagram is worse than none.
3. **Model reality, not intention.** Verify the flow against code (or a live run) before
   drawing it. A diagram that shows what we meant to build communicates the wrong thing.
   (Drawing implement-pr-run-sequence surfaced that the saved workflow was stale — modeling
   forces verification.)

## Generated class diagrams — h's conventions

**A canonical class diagram of code contracts is GENERATED, never hand-drawn** (the doctrine,
manifest format, extractor contract, and extend-the-toolkit rule live in the
`generated-diagrams` plugin skill). h's parameters: the managed docs live in
`docs/diagrams/` (`--dir docs/diagrams`), manifests resolve file paths against the repo root
(invoke from the root — `--root` defaults to cwd), and drift is a LINT FAILURE
(`gen-code-diagram --check --dir docs/diagrams` in `bun run lint`). Hand-authoring is only
for the genres no AST holds: sequence/state diagrams (verify against code) and C4
component/container framing.

## Authoring guidance (h policy)

- **File naming — the kind lives in the name**: `<scope>-<kind>.md`, kind one of
  `-sequence`, `-class` (UML class / generated C4 code — both mermaid `classDiagram`),
  `-c4-component`, `-uml-component`, `-c4-container`, `-c4-context`, `-state`. A reader must
  be able to tell a C4 component diagram from a UML class diagram by file name alone
  (`agent-cli-c4-component.md` vs `agent-cli-class.md`). Sequence and class are the
  operator's primary kinds — when adding coverage for a component, those two come first:
  the class diagram GENERATED (never hand-drawn), the sequence diagram hand-authored and
  verified against the code.
- **Kinds**: sequence diagrams for interactions (the default — this is a runtime whose
  interesting facts are message flows); C4 (via the c4-mermaid-plugin skills — load the
  matching `c4-*` skill and follow its syntax + required validation step) for structure;
  UML COMPONENT diagrams for the interface-centric view (what a component PROVIDES vs
  REQUIRES — the encoding is in the plugin skill; exemplar:
  docs/diagrams/agent-cli-uml-component.md); state diagrams for lifecycle rows
  (watch/chain/cron statuses). The `code-comprehension` plugin produces EPHEMERAL diagrams
  in answers; when one keeps getting redrawn, it graduates into docs/diagrams/ under these
  rules.
- **Scope**: one diagram = one story a reader keeps needing told. 6–9 participants max in a
  sequence; compress repetition with `loop` ("the run-* pattern") and show it in detail once.
- **Activation bars are required in sequence diagrams** — a lane without activations hides
  who is busy when. Use `->>+`/`-->>-` on request/reply pairs and explicit
  `activate`/`deactivate` for long-lived spans (an engine active across steps; a subprocess
  from spawn to exit — deactivated by its terminator when that differs from the caller).
- **Annotate the invariants**, not just the arrows — the reading-notes section names the
  load-bearing properties (mark-before-fire, the gate, fail-before-PR) with step numbers.
- **Register it**: add a row to `docs/diagrams/README.md`'s table in the same change.
- **Render before committing** — the render is the syntax check (mermaid traps live in the
  plugin skill), and for C4 LOOK at the image, not just the exit code.

## The set and its growth

`docs/diagrams/README.md` is the index — current set + the planned list. Grow it by NEED:
when an explanation gets written twice in prose, that is the signal to add the diagram. Do
not pre-draw the whole system.
