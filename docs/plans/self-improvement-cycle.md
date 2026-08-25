# h improves h: friction detection → issues → the existing apply loop

Status: Active — **fold one is BUILT** (2026-08-25 re-verification; the line above said "nothing
built" and had not noticed). The miner is the `retro` template: it computes from the run ledger,
states findings in h's vocabulary, and files them with the `h-issues` skill for the discovery cron
to pick up under the trust label — which is precisely the fold-one shape §2 designed, reached from
a different direction. Fold TWO — per-repo knowledge accumulation — remains unwritten, and this
plan is now about that half, whose design is §7 (written 2026-08-25, not built — §7.6 carries
its open questions for the operator).
Established: 2026-07-10

**Re-groomed 2026-07-28 — read the body with these three corrections.**

1. **`issue-sweep` no longer exists.** Every reference below to "cron-fired `issue-sweep` →
   `feature` run" describes machinery retired 2026-07-12. The apply half is now a **discovery
   cron** (`cron:discover:<repo>:<label>`) that reads open issues on a label and fires one
   supervised `implement-pr` per newly-seen item, plus a per-PR revise-until-merged cron. This
   does not weaken the design — it strengthens it. §2's whole argument was "don't build a new
   engine, file an issue and let existing machinery apply it," and the machinery that consumes
   the issue is now *more* mechanical than when this was written. The handoff contract is
   unchanged: produce a well-formed, correctly-labeled issue.
2. **The templates renamed.** `feature` → `implement`, `feature-pr` → `implement-pr`,
   `pr-review` → `review-pr`, `revise` → `revise-pr`; `plugin-improvement` still exists.
3. **Open question 4 is answered by the existing trust gate.** Friction issues should be
   *filed* by the machine but still require a human `agent-approved` label before the discovery
   cron picks them up — that is exactly how the gate already works, so it costs nothing and
   preserves the h-builds-h trust boundary. The leaning in §6 was right.

**What is genuinely still open**, and why this stays Planning: the miner step itself (nothing
built), the cadence and window-scope questions (§6.1–6.2), and **fold two** — per-repo knowledge
accumulation — which has never been laid out. Fold two is the more valuable half now that the
apply loop is fully mechanical, and it is the natural place to start when this is picked up.

## Context

A real use-case for the harness is carrying out work in the maintainer's *other* repos.
Above and beyond orchestration, two self-improvement axes matter, and they are the subject
of this doc:

1. **Self-awareness (fold one, the focus so far):** h noticing what needs improving in *h
   itself* — the harness, the orchestration, the primitives — *while* it executes workflows.
2. **Self-improvement of the work (fold two, not yet designed):** h getting better at *the
   work itself* in target repos — accumulating durable knowledge per repo so it stops
   relearning context and stops repeating mistakes. (Placeholder; to be laid out and
   pressure-tested.)

This doc is the *detection front-half*. The *apply back-half* already exists and is
live-proven: see [h-builds-h.md](./impl/h-builds-h.md) — a labeled issue on the h repo →
cron-fired `issue-sweep` → `feature` run → PR → human merge. The friction cycle's whole job
is to **produce the well-formed issue** that the sweep already knows how to consume.

---

## 1. The core insight

Self-awareness is **not a new mechanism** — it is another instance of the shape h already
trusts: a registry + a `decide`-on-a-clock + a closed vocabulary + "machines scan, agents
judge" (the watcher and chain primitives; see [watcher-primitive.md](./impl/watcher-primitive.md)).
Point that shape inward.

The load-bearing principle carries over directly: **the executing agent must not do the
meta-reflection.** An agent mid-task that is also asked to critique the harness splits its
attention and derails. Reflection is a *separate judgment pass over durable signal*, run by a
different actor at a different time.

That splits the cycle into two stages with opposite cost profiles:

- **Capture — near-zero cost at emit time.** If noticing friction costs a whole issue-authoring
  detour, agents won't do it (or will do it *instead* of the actual work). Capture must be cheap
  and fire-and-forget.
- **Synthesis — expensive, batched, judgment.** Cluster many raw incidents into one articulated
  improvement. This is agent work, run periodically, separate from any task run.

The `h-issues` skill is the right shape for the **output** of synthesis (dedup search,
well-formed body, label discipline) — and the **wrong** shape for capture. Don't conflate them.

---

## 2. The proposed shape (fold one)

**A cron-fired saved workflow, not a new engine.** Watcher/chain run *on* the tick as a pure
`decide` because supervising and sequencing are mechanical. Friction *synthesis* is the
opposite — clustering "these five retries and two costGaps indict the worktree route" is
judgment, i.e. agent work. So this is a saved workflow whose step is: *agent reads operational
state via obs-mcp, clusters it, files issues via the `h-issues` skill.* No new `friction:`
registry, no new writer of the flat keyspace, no new engine. It stays a composition of existing
primitives.

**The signal is the operational state you already write.** Passive mining over what actually
happened is higher-confidence than asking agents to introspect:

- run ledger + `run:<id>` mirrors (per-step activity, tool calls, cost)
- `watch:ledger:<date>` / watch terminations / `costGap` outcomes
- retries, budget-terminates, the explicit tool-unavailable reports workflow prose already mandates
- Zipkin traces (latency tails, error spans)

The trace tells you *where* the friction was; a future agent-emitted note would tell you *why*.
Passive mining is the reliable half and the right thing to build first (see §4).

**Let GitHub be the dedup store — no cursor.** The naive version re-derives the same friction
every tick and re-files duplicates. Two existing facts fix this without a new watermark key:
window the read (last 24h of runs, stamp-forward style, self-healing), and lean on the fact that
`h-issues` **already dedups against open issues** before filing. The open issues on the h repo
*are* the registry of known friction.

**Run it slow, and gate it.** Friction is a slow signal — keep it off the 60s tick where the
watch/chain scans live. Daily is likely right. Gate the expensive part: a cheap first step
checks "was there any friction-shaped activity in the window at all?" and short-circuits an idle
day before spinning up judgment.

**Then the loop is closed by machinery that already runs:** friction workflow → issue on the h
repo → `issue-sweep` picks it up → `feature` run → PR → human merge → h-builds-h. Everything
downstream of "issue" is untouched.

```
 operational state (run ledger / watch:ledger / run: mirrors / Zipkin)   ← already written
        │
 cron (daily) fires saved "friction" workflow                            ← NEW, this doc
   step 0: any friction-shaped activity in the window? no → stop (cheap gate)
   step 1: agent mines the window, clusters incidents, distinguishes
           harness-defect from task-difficulty (recurrence is the discriminator),
           files well-formed issues via the h-issues skill (dedups vs open issues)
        │
 issue on the h repo, labeled for the sweep                              ← handoff
        │
 issue-sweep → feature → PR → human merge                                ← EXISTS (h-builds-h.md)
```

---

## 3. Why `plugin-improvement` is precedent, not a building block

`plugin-improvement.yaml` is `worktree → setup → improve → (verify)`, fired with `slug` +
`feedback`. It takes **already-articulated feedback** and applies it to a *plugin source repo*
(bumps `plugin.json`). So:

- It is purely an **apply half** — it does no detection, which is exactly the half we're designing.
- Its apply-half is plugin-shaped (`sourceRepo`, `tile`, `plugin.json`) and doesn't transfer to
  improving *h itself*. The friction cycle would **not** fire it.
- For improving *h*, the apply-half is `issue-sweep` + `feature` + `create-pr` (targets the h
  repo, produces a PR) — a different back-half.

Its real value is proving the **spine** closes end to end: `signal → workflow-trigger event
{key, params} → parameterized saved workflow applies it`. The friction cycle reuses that spine,
pointed at the h-repo back-half.

Sharpening this reading surfaced the key point: **the plugin flow never automated detection
either** — its "what to improve" came from a triage run (an agent judging plugin behavior), not
from mining operational state. So the friction **miner is genuinely new**; the spine on either
side of it is proven. The novel, get-it-right step is the one that reads the operational state
and decides "this recurring shape is a harness defect worth an issue."

---

## 4. Named scope boundary: passive-mine now, active-emit later

This design is the **passive-mining** half — grounded in what the trace recorded (the
higher-confidence signal), and requiring no new discipline from executing agents. What it can't
see is the qualitative "this API was awkward and I worked around it," which only lived in the
agent's head; the run ledger records *what* the agent did, not *why it was annoying*.

That's the **active-emit** channel — a cheap fire-and-forget "note friction" from an executing
agent into a durable store, refined later in the same synthesis pass. It's a fine v2. Do **not**
let "we'll add agent notes later" block shipping the trace-miner, which is the part trustworthy
without teaching agents anything new.

---

## 5. The discriminator: "h is wrong" vs "the task was hard"

A workaround does not indict the harness — sometimes the target repo is just a mess. **Recurrence
across runs** is the discriminator: one agent tripping over something is noise; the same shape of
friction across N runs is a harness defect with evidence attached. This is *why* capture must
accumulate and cluster rather than fire an issue per incident, and it's the core judgment the
synthesis step must encode in its prompt.

---

## 6. Open questions (for the maintainer)

1. **Cadence.** Daily vs hourly. Leaning daily for signal quality (friction is slow; a day's
   window clusters better and costs less).
2. **Window scope — the important one.** Does the miner read *only* h's own workflow runs, or
   also the runs h did *in the other repos*? Friction encountered while working in a target repo
   is often the richest harness signal of all (it exercises clone/worktree/MCP/setup paths under
   real conditions), which argues for including cross-repo runs — but it widens the surface the
   synthesis step must reason about.
3. **Fold two.** ~~Lay out the object-level self-improvement axis~~ — laid out 2026-08-25 in §7
   below; its own open questions are §7.6.
4. **Issue labeling handoff.** Which label the friction workflow applies so `issue-sweep`
   picks it up — and whether auto-filed friction issues should require a human `agent-approved`
   click before the sweep acts (the h-builds-h trust gate), or ride a separate lane. (Leaning:
   friction issues are *filed* by the machine but still gated by a human label before apply —
   preserves the h-builds-h trust boundary.)

---

## 7. Fold two — per-repo knowledge accumulation (design, 2026-08-25)

**Fold two is fold one with the SUBJECT swapped, and almost everything that made fold one cheap
carries over.** One asymmetry does not, and the whole design turns on it.

### 7.1 The symmetry

| | fold one (built: `retro`) | fold two |
| --- | --- | --- |
| Subject | h itself | the target repo |
| Signal | the run ledger | the same ledger, read for a different thing |
| Synthesis | agent clusters incidents | agent clusters what was RE-derived |
| Dedup store | open issues on the h repo | **the target repo's own steering file** |
| Output | a GitHub issue | **a PR against that steering file** |
| Human gate | the `agent-approved` label | the merge |
| Apply step | discovery cron → `implement-pr` → PR | none — the doc IS the artifact |

Fold two is *shorter* than fold one: fold one's output needs a second machine run to become a
change, while fold two's output is already the change. The PR is the whole thing.

It also needs no new primitive, for the same reason fold one needed none. Fold one refused to
build a `friction:` registry and leaned on open issues as the dedup store; fold two refuses a
`knowledge:` registry and leans on **the steering file itself** — read it before proposing, and
if the fact is already there, drop it. No cursor key, no new writer of the flat keyspace, no
engine. Fold two costs a template.

### 7.2 The asymmetry that drives every constraint: an issue is INERT, a steering line is LOADED

A bad fold-one issue sits in a tracker until a human triages it away. A bad fold-two line is
**read by every subsequent run in that repo** and confidently misleads it. Fold two can make h
*worse* at a repo, compounding, in a way fold one structurally cannot — it is a self-modification
path, where fold one is a suggestion box.

Four constraints follow, and none of them is taste:

1. **PR only, never a direct write.** The merge is the ONLY gate fold two has; fold one's label
   step does not exist here.
2. **Every proposed line cites a path, and the cite is checked against the tree at write time.**
   This is the rule the `retro` step learned the expensive way — a correct measurement with an
   unsupported inference bolted on is the hardest defect to catch — and the stakes are higher
   here, because a bad retro finding produces a bad issue while a bad steering line produces bad
   *instructions*.
3. **Deletion is a first-class output, not an afterthought.** A steering file rots, and a pass
   that only ever ADDS makes the doc longer and more wrong every time it runs — the process would
   degrade its own artifact. Proposing removal of a line the tree now contradicts is the
   highest-value thing this can do, and it is available only because the target's steering is
   source-controlled. h's own `check-plans`/`check-vocabulary` guards exist because the same rot
   happens here.
4. **Small diffs, capped.** A pass proposing twenty lines is not reviewable; it gets merged unread
   (the worst outcome, given (2)) or closed wholesale.

### 7.3 The discriminator: DURABILITY

§5's discriminator for fold one is *recurrence across runs* — "h is wrong" vs "the task was hard".
Fold two's sibling question is **"will this still be true in a month?"**

- A fact about ONE feature is run context. It belongs in the `plan-feature-<slug>.md` handoff the
  implement step writes and throws away, and `implement`'s prose already says that file is not a
  tracking log.
- A fact about the REPO is steering.

The operational test: **would a run of a DIFFERENT task in this repo have wanted to know it?**
Yes → steering. No → run context. This is checkable by the proposing agent, which is what makes
it usable in a prompt.

### 7.4 h's own repo is the worked example, and it hands us the format

CLAUDE.md's *Key gotchas* section IS this artifact, accumulated by hand over months — each entry
names the symptom, the cause, the fix, and stamps when it bit live ("Bit us live 2026-08-10 …").
Fold two automates a habit the operator already performs for h. That means the output format
needs no invention and no new convention: **symptom → cause → fix → the date it cost something.**

The need is demonstrably real and currently misfiled. Facts of exactly this shape — "runs against
this repo need host mode, because a CLI it depends on is host-only", "this repo's toolchain is
invisible to a naive probe, so a run that checks for it the obvious way concludes it is absent" —
today live in the OPERATOR's memory rather than in the repo where every run could read them.
They are re-explained per session. That is fold two's backlog, already written, in the wrong place.

### 7.5 Where the file is

A consumer repo keeps its steering wherever it keeps it: `CLAUDE.md`, `AGENTS.md`, a `.cursorrules`,
or under `.h/`. The template must DISCOVER rather than assume, and when a repo has none, proposing
its creation is the same PR — and is the highest-value first pass for a repo h has only just
started working in. (`bootstrap-repo` is not this: that is the genesis path for a repo that does
not exist yet.)

### 7.6 Open questions (operator, before anything is built)

1. **Cadence and trigger — the important one.** `retro`'s nightly `since` window is fold ONE's
   shape. Fold two's evidence is sharpest at the END of a feature arc, while the friction is fresh
   and the `branch` scope already names it — which argues for a closing chain member rather than a
   nightly sweep. Leaning: chain member.
2. **It must read the tree to verify its claims**, so it needs a worktree, a branch and a push —
   the write kind, reusing `create-pr`'s machinery. Confirm that is wanted, since it makes fold two
   materially more expensive than fold one's read-only miner.
3. **One PR per pass, or a long-lived steering branch a pass appends to?** Per-pass is noisy on an
   active repo; a long-lived branch is quieter but stales and starts conflicting.
4. **Does fold two ever run on h ITSELF?** It would let h edit `CLAUDE.md` — the most load-bearing
   file in the repo and the one every h agent loads on every run. Given §7.2, almost certainly
   excluded in v1, or gated harder than a merge.
5. **Is a merge a sufficient gate at all?** Fold one is gated twice (a human labels the issue, and
   a human merges the resulting PR). Fold two is gated once, on a change whose whole purpose is to
   instruct future agents. This is the question to settle before writing the template, not after.

---

## Progress log

- 2026-07-10 — design conversation captured. Fold one shape agreed in principle: a daily,
  activity-gated, cron-fired saved workflow that mines operational state, clusters with
  recurrence as the harness-defect discriminator, and files issues via `h-issues` (GitHub open
  issues as the dedup store), feeding the existing `issue-sweep`→`feature` apply loop. Passive-
  mine first, active-emit deferred. `plugin-improvement` classified as spine-precedent, not a
  building block. Open: cadence, cross-repo window scope, fold two, the label/trust handoff.
- 2026-08-25 — **Re-verified against the tree.** Fold one is BUILT — the `retro` template is §2's
  miner, reached from the retro/ledger direction rather than from this doc: it computes from the
  run ledger, forbids reasoning from an agent's self-report, requires evidence per finding,
  searches open issues before filing (§2's "let GitHub be the dedup store", exactly), and files via
  `h-issues` behind the trust label (§6 Q4's leaning, confirmed in practice). Two of §2's design
  points are NOT in it and are the honest gap: the **cheap activity gate** (step 0, short-circuit an
  idle window before spinning up judgment) and §6 Q2's **window scope** decision — `retro` reads
  whatever ran, so cross-repo runs are included by default rather than by ruling.
- 2026-08-25 — **Fold two designed** (§7), per §6 Q3. It is fold one with the subject swapped and
  is shorter, because its output is the artifact rather than a request for one. The design turns on
  a single asymmetry: fold one's output is inert until a human acts, while fold two's is LOADED by
  every future run — so it can compound into making h worse at a repo, which fold one cannot. Not
  built: §7.6 carries five questions for the operator, and per the standing preview convention the
  surface goes to the operator before implementation.
