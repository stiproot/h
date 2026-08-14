# tooling scout — a formal process for mining external agent tooling for h

Status: Active — process built + first scout run 2026-08-14 (pi-autoresearch: verdict "nothing to take", the process's skeptical selection working as designed); this doc is the scout log until the scout-tooling skill exists
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

## The scout chain (BUILT 2026-08-14)

Three stages on the LOCAL substrate (`h chain run --local` — blocks, prints threaded data;
no engines needed, and the implement stage's worktree isolates the write work):

```
stage 1  scout-repo   cwd = the external clone; read-only review
                      outputs: {summary, license, opportunities, recommendation, report}
stage 2  plan-poc     input findings = scout.report
                      outputs: {chosen, rationale, spec}
stage 3  implement    input spec = poc.spec; worktree on h's checkout
```

The validated command lives in [docs/cookbook.md](../cookbook.md) ("Scout an external
repo"). Two grammar facts the first fire established: a novel template chains under
`--kind answer` (kinds are the closed threading-contract set; declared `--capture`/`--input`
replace the kind's halves), and chain-wide `-p` seeds land on the CHAIN DATA, pulled per
member via `--input param=source` — registration-time validation named the exact fix at each
step.

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
- **Cookbook entry** — DONE 2026-08-14 ("Scout an external repo" in docs/cookbook.md).

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

## Scout log (verdicts)

### 1. pi-autoresearch — 2026-08-14 — NOTHING TO TAKE

Run `chain-scout-pi-autoresearch-260814-091135` (local substrate, $0.64 scout + $1.29
selector). The scout surfaced eight patterns with file-path evidence (deterministic
compaction summary, consecutive-failure halt, segment state, MAD confidence scoring, the
`METRIC name=value` stdout protocol, per-iteration `.auto/hooks/{before,after}.sh` with JSON
payloads, ASI self-annotation, the project-local replayable JSONL experiment ledger); the
selector interrogated each against h's primitives and dropped all eight with stated reasons —
most already covered by chain data threading, structured outputs, watcher retry and budgets;
the METRIC protocol actively fights the fail-closed explicit-contract design. Executor lens:
nothing (a pi extension over closed-source peer deps, no headless surface). Parked with
triggers:

- **Benchmark-driven keep/revert loop** (the shape MAD scoring + METRIC lines serve).
  Revisit when: an optimization workflow with a numeric convergence target actually arrives
  (e.g. "make this benchmark faster" as an h workflow) — the loop strategy comes first, the
  quality signals only after it.
- **Between-stage hooks** (the one genuine gap: operator side effects with per-stage context,
  no workflow edit). Revisit when: a second workflow wants a between-stage side effect —
  one demand is a coincidence to note, two is the pattern (3–5 days, chain model + scan +
  CLI, both stacks).

Process finding: a `chosen: "none"` verdict fails the implement stage loud (empty `spec`),
so a full three-stage scout of a no-opportunity repo terminates as a FAILED chain. Correct
per D6 fail-as-unit, but the exit reads wrong for a verdict the process explicitly honors.
Revisit when: none-verdicts recur and the failed-chain exit misleads someone — the fix
space is run the two-stage form by default and fire implement manually on a real spec, vs
a conditional-advance chain feature (a real primitive change; interrogate hard).

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
- **2026-08-14 (later)** — process BUILT and first scout RUN: `scout-repo` + `plan-poc`
  templates landed (459 CLI tests green, goldens untouched), the three-stage chain fired on
  the local substrate against pi-autoresearch, and the selector returned "nothing to take"
  with all eight opportunities dropped on stated reasons — the skeptical-selection design
  doing its job on its first outing. Verdict + parked items (with triggers) in the scout
  log above; validated command lifted to the cookbook. Chain-grammar learnings (novel
  templates ride `--kind answer`; seeds are chain data, pulled via `--input`) recorded in
  the cookbook entry.
