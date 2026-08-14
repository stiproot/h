# tooling scout — a formal process for mining external agent tooling for h

Status: Planning — strategy drafted 2026-08-14; scout-chain design awaiting operator preview (templates not yet built)
Established: 2026-08-14

## The idea

Powerful open-source agents, harnesses and orchestration frameworks are appearing weekly. h is
a harness FOR harnesses — executors plug into workflows and chains as fire-time identity — so
each of those repos is simultaneously a potential **executor**, a source of **patterns** for
h's own primitives, and a source of **tooling** h's agents could use. Today reviewing one is
ad-hoc: clone it somewhere, read it, maybe remember something. This plan formalizes the
process — **the scout** — and, in h fashion, makes the process itself an h chain: review the
clone, interrogate the findings into ONE poc-able opportunity, implement the POC on a
worktree. Dogfooding is the point: the scout chain is exactly the review→plan→implement shape
h already composes.

POC subject (operator-chosen): [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).

## The process

One scout = one candidate repo through five steps:

1. **Intake.** Name the candidate and the intake question ("what does h want from this?").
   A candidate qualifies on any of the four lenses below. Record the license up front —
   a pattern can be learned from anything, but code/integration lifts need a compatible one.
2. **Clone** — under `h-workspace/<repo>` (shallow), satisfying the managed-workspace
   boundary. The operator or driver does this; it is one git command, not a chain step
   (the local substrate deliberately has no clone activity).
3. **The scout chain** (the automation — design below): a review member reads the clone and
   produces structured findings against the lenses; a selection member interrogates the
   findings against h's principles and writes an implementable spec for the single best
   opportunity; an implement member builds that POC on an h worktree.
4. **Disposition** — every scout terminates in exactly one of:
   - a **POC branch** on h, evaluated like any feature work (PR or discard);
   - **h issues** for opportunities worth doing but not now (`h-issues` skill; each carries
     its trigger, per the interrogate-before-building rule);
   - a recorded **"nothing to take"** verdict — a normal, valuable outcome, logged here.
5. **Lift.** A validated scout run's command goes in the cookbook; recurring lens learnings
   fold back into the scout template's prose (the lens list's durable home is the template
   itself, not this plan).

### The four lenses (what the review member looks for)

- **Executor** — is it (or does it wrap) a headless-drivable agent CLI? Auth model, JSON/
  stream output, autonomy flags, MCP support. If yes, h's `integrate-agent` skill is the
  landing recipe (strategy + service + activity + identity).
- **Orchestration patterns** — loops, budgets, checkpointing, supervision, scheduling,
  state threading. Compared explicitly against h's primitives (watcher/chain/cron engines,
  the events fabric's budgeted loops, structured-output threading): what does it do that h
  cannot express, and is the gap a missing feature or a rejected design?
- **Tooling & integrations** — extensions, MCP servers, skills/steering packaging that h
  agents could consume per-run (the `h.pluginSetupSteps` precedent: provisioning is a
  fire-time param, never baked).
- **Observability & UX** — run ledgers, experiment logs, dashboards, replay/resume UX —
  candidates for the run ledger / viz research.

Every lens answers with evidence (file paths in the clone), not vibes — the same
grounded-in-paths discipline the code-comprehension plugin enforces for diagrams.

## The scout chain (design — PREVIEW, not yet built)

Three stages on the LOCAL substrate (`h chain run --local` — blocks, prints threaded data;
no engines needed, and the implement stage's worktree isolates the write work):

```
stage 1  scout-repo   (NEW template)  cwd = the external clone; read-only review
                                      outputs: {summary, license, opportunities, report}
stage 2  plan-poc     (NEW template)  input findings = scout.report
                                      outputs: {chosen, rationale, spec}
stage 3  implement    (stock)         input spec = poc.spec; worktree on h's checkout
```

```sh
h chain run --slug scout-pi-autoresearch --local \
  -p repoPath=$HOME/code/h-workspace/pi-autoresearch \
  -p slug=scout-autoresearch-poc -p clonePath=$HOME/code/h \
  -w scout-repo --id scout --capture report=report \
  -w plan-poc   --id poc   --input findings=scout.report --capture spec=spec \
  -w implement  --input spec=poc.spec
```

Template design notes:

- **`scout-repo`** — params: `repoPath` (required; the agent step's `cwd`, so the workspace
  is passed, never described), `focus` (optional intake question, default ""). Task prose
  carries the four lenses + the evidence discipline + license capture. Contract:
  `{summary, license, opportunities: [{title, lens, value, effort, pocShape}],
  recommendation, report}` — `report` is the full findings document (the threading payload);
  the discrete fields are for machine reading and future fan-out.
- **`plan-poc`** — params: `findings` (required). Task: interrogate each opportunity against
  h's principles (harden-by-encoding, engines-outside-workflows, operator-provisioned
  tooling, declarative-over-coded), pick exactly ONE with a shippable ~1-day POC shape, and
  write the spec as a whole brief (files to start from, full acceptance command — the
  delegate-locally rules). Contract: `{chosen, rationale, spec}`.
- **Stage 1 as a panel** is one flag away (`--agent claude codex` on the scout member) —
  independent reviews + pinned judge. Worth it for contested candidates; default single.
- Names are imperative kebab-case per the template convention; both new templates are
  ordinary stock templates (publish-native, chain-agnostic, runnable standalone — e.g.
  `h workflow run scout-repo --local -p repoPath=…` for a review-only scout).

### Maturation path (not now)

- **Scout backlog as labeled issues** — candidates filed with a `scout` label; h's
  DISCOVERY CRON fans out one scout chain per newly-labeled issue (the h-builds-h loop's
  shape, pointed outward). Revisit when: the manual scout cadence exceeds ~1/week.
- **A `scout-tooling` skill** — the process as steering, once ≥3 scouts have validated the
  lens list. Revisit when: the third scout completes.
- **Cookbook entry** — on the first validated run (part of this POC's definition of done).

## POC subject: pi-autoresearch (recon 2026-08-14)

Cloned at `h-workspace/pi-autoresearch` (MIT, v1.6.2). What it is: an extension for the
**pi** coding agent (already an h executor) implementing an autonomous optimization loop —
*try an idea, benchmark it, keep what works, revert what doesn't, repeat* (inspired by
karpathy/autoresearch). Pieces: three extension tools (`init_experiment` /`run_experiment`/
`log_experiment` — auto-commit per kept experiment), skills (`autoresearch-create/-finalize/
-hooks`), a JSONL experiment log (`.auto/log.jsonl`), auto-resume guards, compaction
handling, a live dashboard.

Driver first impressions (to be tested by the scout run, not trusted): the experiment loop is
a **budgeted keep/revert loop with a measurable objective** — h has loop-until-clean chains
and budgeted events loops, but no benchmark-driven keep/revert shape; that pattern may be the
poc-able opportunity. Secondary: pi extension provisioning per-run (the `pluginSetupSteps`
sibling for the pi executor), and the auto-resume/compaction guards vs h's checkpoint-first
convention.

## Open questions

- **Where does stage 3 point for a scout POC?** Default h's own checkout (the opportunity is
  an h improvement), but a scout of a TARGET-repo tool might POC in that repo's clone.
  Decide per scout via `clonePath`; revisit if a pattern emerges.
- **Panel-by-default for stage 1?** Cost vs contested-candidate value. POC runs single;
  decide after seeing one report's quality.

## Log

- **2026-08-14** — plan established: process (intake → clone → chain → disposition → lift),
  four lenses, chain design (scout-repo + plan-poc + stock implement, local substrate),
  pi-autoresearch cloned and reconned as the POC subject. Design preview pending operator
  confirmation; nothing built.
