# Cookbook — h by example

Real commands that really ran. Every entry is a command executed against a live stack, stamped
with the date and the artifact it produced (a PR, a registered row, a run) — never aspirational
syntax. When an e2e validates a new composition, lift its command here (this is the long-lived
home the plan-management lift rule wants; plans are transient, this gallery is not). If a
surface changes, update or delete the entry in the same change — a stale example is worse than
none.

Grammar refs: `h chain run --help` (the chain EXPRESSION), CLAUDE.md "h primitives",
docs/plans/chain-composition-surface.md.

## Run a saved workflow, pick the executor

```sh
h workflow run implement-pr -p slug=my-feature -p spec=@spec.md --agent codex
```

`-p` populates content values (`@path` splices a file); `--agent` is machinery — it expands to
the `{runActivity, agentId}` fire-time identity params. *(Validated continuously; identity
table: `cli/h/src/h_cli/config.py`.)*

## Run a template inline — nothing published

```sh
h workflow run revise-pr --inline -p pr=30 -p repo=stiproot/h -p slug=pi-agent
```

`--inline` treats the argument as a CHART TEMPLATE: rendered on the fly, steps fired directly;
the only durable trace is the `wf:` status row. *(Validated 2026-07-20+, the default style for
one-offs.)*

## Panel: plural `--agent` (panels-as-a-modifier)

```sh
h workflow run answer -p task=@question.md --agent claude --agent codex --agent openhands
```

A roster panelizes any read/judge workflow at fire time: one branch per agent in a parallel
step group, a pinned judge (claude) synthesizes under the workflow's own output contract. On
`h workflow run` the flag repeats (Typer); in a chain expression it's space-greedy (below).
*(Validated 2026-07-24 — docs/plans/panels-as-a-modifier.md.)*

## The full parallelism tour — two panels ∥, then implement (container e2e, PR #64)

```sh
h chain run --slug a9-template-gate-guard -p repo=stiproot/h \
  -p designTask=@design-task.md -p risksTask=@risks-task.md \
  -- \
  -w answer --agent claude codex     --inline --id design --input task=designTask --capture answer=answer \
  --parallel \
  -w answer --agent claude openhands --inline --id risks  --input task=risksTask  --capture answer=answer \
  -t implement verify create-pr --agent codex --inline --input spec=design.answer --input slug=slug
```

Stage 0: TWO panels run concurrently (chain-stage parallelism × in-workflow panel groups),
each capturing its synthesized `answer` under its `--id` namespace (D5). Stage 1: codex
implements with the design panel's answer as its spec (`--input` reads the dotted namespace —
and REPLACES the kind's coded params, hence the explicit `slug=slug`). *(Validated 2026-07-24,
container mode → PR #64 in ~6 min.)*

## Panel review loop — review until clean (PR #64's review arc)

```sh
h chain run --slug a9-review-loop -p repo=stiproot/h -p slug=a9-template-gate-guard \
  -p prNumber=64 -p focus=@risks-answer.md \
  --strategy loop-until-clean --max-iterations 3 \
  -- \
  -w review-pr --agent claude codex --inline --input pr=prNumber --input focus=focus \
  -t revise-pr --kind revise-pr --agent codex --inline
```

A panelized `review-pr` (each panelist posts its own PR review; the judge emits the ONE
CLEAN/FINDINGS verdict the loop keys on) alternating with codex revisions. Note the split from
the chain above: loop-until-clean × stages is a deferred reconciliation — loops want purely
sequential members. Chain-level flags (`--strategy`, `--max-iterations`, `--slug`, `-p`) sit
BEFORE the `--` separator; the expression after it. *(Validated 2026-07-24 — 3 iterations,
panelists disagreed in round 1 and the unanimity rule caught it.)*

## The default chain — feature → review → revise

```sh
h chain run --slug my-feature -p spec=@spec.md -p repo=stiproot/h --strategy loop-until-clean
```

No expression ⇒ the default `-w implement-pr -w review-pr -w revise-pr`. *(Validated 2026-07-20,
PR #52.)*

## Schedule a run, or pause and resume one

```sh
h workflow run implement-pr -p slug=x -p spec=@s.md --in 2h        # fire ONCE, later
h workflow pause <instanceId> implement-pr --in 30m                # stop now, continue later
h workflow resume <schedId>                                      # ...or continue immediately
```

One-shot `cron:sched` rows; pause reuses the run's workspace so the worktree survives.
*(Validated 2026-07-18 — docs/plans/schedule-and-fallback.md.)*

## Usage-limit fallback — continue under another agent

```sh
h workflow run implement-pr -p slug=x -p spec=@s.md \
  --fallback-agent openhands --fallback-after 10m --fallback-max 1
```

On a `usage-limited` outcome the watcher arms a deferred continuation under the fallback
identity, reusing the workspace. *(Validated 2026-07-18.)*

## Discovery cron — one workflow per new labeled issue

```sh
h cron discover add stiproot/h --label agent-approved --cadence "*/10 * * * *" --max-per-day 6
```

Fires a provision workflow whose activity registers the `cron:discover:` row (§10 — registry
state is created by activities, not edges). The h-builds-h issue loop. *(Validated 2026-07-12+.)*

## Chain activation gates — schedule a chain, or gate it on another chain

```sh
h chain run --slug wiresmoke-p -p repo=stiproot/h -p task="Reply with the single word ALPHA." \
  -- -t answer --kind answer --inline --agent claude --capture handoff=answer

h chain run --slug wiresmoke-c --after wiresmoke-p -p repo=stiproot/h \
  -- -t answer --kind answer --inline --agent claude --input task=handoff
```

Registration is data (issue #79): both return instantly as `scheduling`; the engine's tick fires
them. The child holds until the parent finalizes `completed`, then activates SEEDED from the
parent's finalized data — including its last stage's captures (issue #77), so `--input
task=handoff` reads what the parent captured. A failed parent terminates the child instead.
`--at <iso>` / `--in <dur>` gate on time the same way — chains are schedulable. *(Validated
2026-07-25 — the child's task was literally the parent's answer; docs/plans/
chain-engine-followups.md.)*

## The zero-glue pipeline shape — implement, then an --after review loop

```sh
h chain run --slug fix-N -p repo=stiproot/h -p spec=@spec.md --in 2h \
  -- -t implement verify create-pr --agent codex --inline
h chain run --slug fix-N-review --after fix-N -p slug=fix-N \
  --strategy loop-until-clean --max-iterations 3 \
  -- -w review-pr --agent claude codex --inline --input pr=prNumber \
     -t revise-pr --kind revise-pr --agent codex --inline
```

Both registered up front: the implement chain fires at its time, opens the PR and captures
`prNumber` terminally; the review chain activates seeded with it and loops to review-clean.
Worktree reuse-by-branch (issue #76) lets the revise land in the implement chain's checkout.
**The child's `-p slug=fix-N` is LOAD-BEARING**: a chain's own `--slug` also seeds `slug` in
its data and SHADOWS the parent's captured slug on activation (issue #82) — omit it and the
revise leg cuts a stray `feature/<child-slug>` branch from main instead of landing on the
PR's branch (bit us live 2026-07-26, PR #80's first review loop). *(The composed shape of the
2026-07-24/25 supervised batches, with the glue now engine-owned; gates validated 2026-07-25;
run end-to-end 2026-07-26 — PR #80's arc, which found the slug trap.)*

## Inspect the engines

```sh
h chain list      # chain rows + scan heartbeat
h watch list      # durable watcher registrations
h cron list       # recur + discovery + one-shot sched rows
h schedule list   # the one-shot rows alone
```
