# h improves h: friction detection → issues → the existing apply loop

Status: Active — **fold one is BUILT** (2026-08-25 re-verification; the line above said "nothing
built" and had not noticed). The miner is the `retro` template: it computes from the run ledger,
states findings in h's vocabulary, and files them with the `h-issues` skill for the discovery cron
to pick up under the trust label — which is precisely the fold-one shape §2 designed, reached from
a different direction. Fold TWO — per-repo knowledge accumulation — remains unwritten, and this
plan is now about that half.
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
3. **Fold two.** Lay out the object-level self-improvement axis (per-repo knowledge accumulation)
   so it can be pressure-tested the same way.
4. **Issue labeling handoff.** Which label the friction workflow applies so `issue-sweep`
   picks it up — and whether auto-filed friction issues should require a human `agent-approved`
   click before the sweep acts (the h-builds-h trust gate), or ride a separate lane. (Leaning:
   friction issues are *filed* by the machine but still gated by a human label before apply —
   preserves the h-builds-h trust boundary.)

---

## Progress log

- 2026-07-10 — design conversation captured. Fold one shape agreed in principle: a daily,
  activity-gated, cron-fired saved workflow that mines operational state, clusters with
  recurrence as the harness-defect discriminator, and files issues via `h-issues` (GitHub open
  issues as the dedup store), feeding the existing `issue-sweep`→`feature` apply loop. Passive-
  mine first, active-emit deferred. `plugin-improvement` classified as spine-precedent, not a
  building block. Open: cadence, cross-repo window scope, fold two, the label/trust handoff.
