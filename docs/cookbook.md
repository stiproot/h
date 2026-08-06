# Cookbook — h by example

Real commands that really ran. Every entry is a command executed against a live stack, stamped
with the date and the artifact it produced (a PR, a registered row, a run) — never aspirational
syntax. When an e2e validates a new composition, lift its command here (this is the long-lived
home the plan-management lift rule wants; plans are transient, this gallery is not). If a
surface changes, update or delete the entry in the same change — a stale example is worse than
none.

Grammar refs: `h chain run --help` (the chain EXPRESSION), CLAUDE.md "h primitives",
docs/plans/impl/chain-composition-surface.md.

## Delegate to a local agent CLI — no stack at all (direct substrate)

```sh
h delegate --agent codex "In one short sentence: what is a git worktree?"
```

`h delegate` runs the agent CLI as a local child process — no Dapr, no services, no registries.
Credentials come from your shell, with the repo's `.env` filling the gaps (shell wins). The only
prerequisite is `bun run build`. *(Validated 2026-08-06 — run
`direct-260806-124834:codex:1786013315291`.)*

## A local panel: several agents, one task, in parallel

```sh
h delegate --agent claude --agent codex --plan "In one short sentence: what is a git worktree?"
```

Every roster slot answers independently and concurrently; one agent failing (missing CLI, bad
auth) still leaves you its siblings' answers, and the job reports `ok: false`. `--plan` is
read-only. Each run lands in the standard run ledger, so `h runs` and obs-mcp read them beside
service runs. No synthesis here — for a judged panel use the `answer` template.
*(Validated 2026-08-06 — group `direct-260806-124834`, claude $0.0590 + codex.)*

## Delegate WRITE work into an isolated worktree

```sh
h delegate --agent codex --worktree "add a --dry-run flag to the importer"
```

`--worktree` cuts one worktree per roster slot off this checkout (branch `direct/<group>-<agent>`,
started from the fetched `origin/main`), so a delegated edit never touches your live tree and two
agents never share a checkout. *(Validated 2026-08-06 — worktree
`../h-worktrees/direct-260806-125017`.)*

## Run a whole TEMPLATE with no stack running (`--direct`)

```sh
h workflow run answer --direct -p task="when is a worktree better than git stash?"
h workflow run plan   --direct -p slug=my-feature -p spec=@spec.md
```

`--direct` renders the template and executes its steps in this process, driving the agent CLIs as
local children. Same definition, same `{{token}}`/`$ref` resolution, same output contract — only
the executor changes. There is no saved-workflow store to read on this substrate, so the argument
names a chart TEMPLATE (compose-on-fire, like `--inline`), `create-worktree` cuts from the checkout
you are standing in, and `setup` steps are skipped unless you pass `--with-setup` (they provision
your own `~/.claude`, not a container's). *(Validated 2026-08-06 — `answer-260806-135828`,
`plan-260806-135959` incl. a real worktree.)*

Flags that need an engine are refused BY NAME rather than ignored:

```sh
h workflow run answer --direct --cron '@daily'
  ✗ --cron need workflow-svc's engines — drop --direct to use them
```

## A panel with no infrastructure at all

```sh
h workflow run answer --direct --agent claude --agent codex -p task=@question.md
```

The roster panelizes CLI-side exactly as on the service substrate — a parallel step group, one
branch per agent, then a pinned judge synthesizing under the workflow's own contract — and the
direct executor just runs the group. *(Validated 2026-08-06 — `answer-260806-135910`: claude 8.9s ∥
codex 14.2s, judge 14.5s, contract validated, nothing running.)*

## A whole CHAIN with nothing running (`h chain run --direct`)

```sh
h chain run --slug q --direct -p task="what is the biggest risk here?" \
    -w answer --id first  --capture answer=answer \
    -w answer --id second --input task=first.answer
```

Same expression, same threading (namespaced captures, dotted `id.field` inputs, stages,
`loop-until-clean`) — sequenced in this process instead of by the engine on the cron tick, so it
BLOCKS and prints the threaded chain data at the end. Every member composes on the fly, so a
member must be a chart template (`-w answer`) or `-t` atoms; a published key with no template
(`implement-pr`) is refused with the composition that does work. Activation gates (`--after`,
`--at`, `--in`) and cron members are refused — they wait on a durable row.
*(Validated 2026-08-06 — `chain-direct-chain-260806-142307`: `first` captured under its namespace,
`second` read it back as its task.)*

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
*(Validated 2026-07-24 — docs/plans/impl/panels-as-a-modifier.md.)*

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
*(Validated 2026-07-18 — docs/plans/impl/schedule-and-fallback.md.)*

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
2026-07-25 — the child's task was literally the parent's answer;
docs/plans/impl/chain-engine-followups.md.)*

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
The child's `-p slug=fix-N` is optional belt-and-braces: as of issue #82 the engine gives the
parent's captured slug precedence over the child's implicit `--slug` at activation, so the
revise leg correctly lands on the PR's branch without the explicit override. An explicit
`-p slug=fix-N` still wins over both (kept in the example as documentation of that idiom).
*(The composed shape of the 2026-07-24/25 supervised batches, with the glue now engine-owned;
gates validated 2026-07-25; run end-to-end 2026-07-26 — PR #80's arc found the slug trap,
fixed by #82.)*

## Validate an existing PR against its ORIGINAL spec — review loop as merge gate

```sh
h chain run --slug val-43 -p repo=stiproot/trxy-v2 -p prNumber=43 \
  -p slug=trxy-arch-lint-2r -p spec=@orig-spec.md \
  -p clonePath=/path/to/pre-clone \
  --strategy loop-until-clean --max-iterations 3 \
  -- -w review-pr --agent claude codex --inline --input pr=prNumber \
     -t revise-pr --kind revise-pr --agent claude --inline
```

The chain-seeded `spec` reaches the panel automatically (the review-pr kind contract's
optional passthrough), so the reviewers audit the diff against the ORIGINAL task — not the
PR's self-description — and the evidence rule demands test runs proportionate to the diff.
`slug` must be the PR's OWN branch token (the revise leg rebases `feature/<slug>` onto main
and re-verifies under the deduced acceptance). Recover a trial run's original spec from its
chain row (`data.spec`). Serialize loops over PRs that share files — merge each before firing
the next. *(Validated 2026-07-26 ×5 — trxy PRs #42–#46 driven to merge; val-43's panel drew
the exact missing-test-evidence finding the verify-eval-loop-tightening plan was built for,
and val-44/45 caught wrong-side rebase resolutions in shared files.)*

## Inspect the engines

```sh
h chain list      # chain rows + scan heartbeat
h watch list      # durable watcher registrations
h cron list       # recur + discovery + one-shot sched rows
h schedule list   # the one-shot rows alone
```

## Deny an executor engine-wide — "no codex tonight", enforced

```sh
h agents deny codex     # every fire path now REFUSES run-codex (chains, crons, panels, fallbacks)
h agents list           # policy column shows DENIED
h agents allow codex    # re-enable
```

Validated 2026-07-29: with codex denied, a fired `run-codex` workflow FAILED at the activity
gate with `executor 'codex' is denied by the exec:config policy` — before any agent invoke, no
quota spent (docs/plans/impl/live-state-containment.md §2.3).

## Daily cost budget on an executor — spend caps the engine enforces

```sh
h agents budget claude 5        # fence claude at $5/day (shortname, USD)
h agents list                   # budget + today's tallied spend columns, gap-run warning
h agents budget claude --clear  # remove the budget
h agents allow claude           # lift a tripped cost-budget fence early
```

When the watcher's finalization tally (`watch:ledger:<date>` per-agent subtotals) crosses an
executor's budget, it writes a `cost-budget` deny expiring at the next UTC midnight — the
activity-registry gate then refuses that executor on every fire path; an operator deny is
never downgraded. Validated 2026-07-30 (docs/plans/impl/cost-containment.md A1 e2e): with claude
budgeted at $0.01, a watched `answer` run booked $0.0555 → the scan fenced claude
(`cost-budget, until next UTC midnight`), the next fire FAILED at the gate with
`executor 'claude' is denied … (auto: daily cost budget crossed …)`, and `h agents list`
showed `auto-denied | $0.01/day | $0.06`.
