# Cookbook — h by example

Real commands that really ran. Every entry is a command executed against a live stack, stamped
with the date and the artifact it produced (a PR, a registered row, a run) — never aspirational
syntax. When an e2e validates a new composition, lift its command here (this is the long-lived
home the plan-management lift rule wants; plans are transient, this gallery is not). If a
surface changes, update or delete the entry in the same change — a stale example is worse than
none.

Grammar refs: `h chain run --help` (the chain EXPRESSION), CLAUDE.md "h primitives".

## Delegate to a local agent CLI — no stack at all (local substrate)

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

`--worktree` cuts one worktree per roster slot off this checkout (branch `local/<group>-<agent>`,
started from the fetched `origin/main`), so a delegated edit never touches your live tree and two
agents never share a checkout. *(Validated 2026-08-06 — worktree
`../h-worktrees/direct-260806-125017`.)*

## Run a whole TEMPLATE with no stack running (`--local`)

```sh
h workflow run answer --local -p task="when is a worktree better than git stash?"
h workflow run plan   --local -p slug=my-feature -p spec=@spec.md
```

`--local` renders the template and executes its steps in this process, driving the agent CLIs as
local children. Same definition, same `{{token}}`/`$ref` resolution, same output contract — only
the executor changes. There is no saved-workflow store to read on this substrate, so the argument
names a chart TEMPLATE (compose-on-fire, like `--inline`), `create-worktree` cuts from the checkout
you are standing in, and `setup` steps are skipped unless you pass `--with-setup` (they provision
your own `~/.claude`, not a container's). *(Validated 2026-08-06 — `answer-260806-135828`,
`plan-260806-135959` incl. a real worktree.)*

Flags that need an engine are refused BY NAME rather than ignored:

```sh
h workflow run answer --local --cron '@daily'
  ✗ --cron need workflow-svc's engines — drop --local to use them
```

## Build a real feature locally — implement, verified against a spec

```sh
h workflow run implement --inline --local \
  --instance-id my-feature \
  -p slug=my-feature -p spec=@spec.md
```

The `implement` template on the local substrate: it cuts a worktree, plans read-only, then
implements against the spec, leaving the result as uncommitted working-tree changes (standalone
mode — compose `create-pr` in if you want the PR). Write the spec as the WHOLE brief, naming the
files to start from and the exact acceptance command including formatters — the delegate has none
of your context, and an acceptance command that omits `ruff format` returns passing tests in code
that fails the pre-push guards. *(Validated 2026-08-10 — instance `per-member-budget-cli`, plan
$1.17 + implement $1.22, shipped as PR #108.)*

Two things to expect on this substrate. **The worktree has no installed dependencies** —
`create-worktree` is a `git worktree add` and nothing more, so run `bun install
--frozen-lockfile` (and `uv sync --frozen` if needed) before any build/lint acceptance command or
any push, because the pre-push hook runs the full guard surface. **`clonePath` decides which
checkout it cuts from**, and an empty one falls back to the CLI's own git root — pass
`-p clonePath=<path>` explicitly whenever the branch you want lives somewhere specific.

## Review a PR, then revise it — both locally

```sh
h workflow run review-pr --inline --local -p pr=108 -p repo=stiproot/h
h workflow run revise-pr --inline --local -p pr=108 -p slug=my-feature \
  -p clonePath=/path/to/the/clone/holding/the/branch
```

The review reads the PR diff through the github MCP and posts a submitted review with
line-anchored comments; `revise-pr` then reads the PR's UNRESOLVED threads itself, rebases the
branch onto `origin/main`, fixes what the threads name, replies inline, resolves them, and
force-pushes with lease. Note `review-pr` cuts NO worktree — with no `cwd` a step falls back to
the repo root, so the reviewer reads your live checkout for the repo's conventions while taking
the diff from GitHub. *(Validated 2026-08-11 on PR #108 — review $1.09 found one real defect,
revise $1.19 fixed it and resolved the thread.)*

The revise leg fixes what the review NAMED. If you already know of a related defect the review
missed, put it in the task — a faithful revise is not a second review.

## A panel with no infrastructure at all

```sh
h workflow run answer --local --agent claude --agent codex -p task=@question.md
```

The roster panelizes CLI-side exactly as on the service substrate — a parallel step group, one
branch per agent, then a pinned judge synthesizing under the workflow's own contract — and the
local executor just runs the group. *(Validated 2026-08-06 — `answer-260806-135910`: claude 8.9s ∥
codex 14.2s, judge 14.5s, contract validated, nothing running.)*

## A whole CHAIN with nothing running (`h chain run --local`)

```sh
h chain run --slug q --local -p task="what is the biggest risk here?" \
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

## Review a PLAN before it becomes an implementation prompt

```sh
h chain run --slug s --local -p spec=@spec.md \
    -t plan --kind answer --id planning --input spec=spec --input slug=slug --capture plan=plan \
    -w review-plan --kind answer --id review --agent claude --agent codex \
        --input plan=planning.plan --input spec=spec --capture verdict=verdict
```

`review-plan` is the third review beside `review-pr` (a diff) and `review-spec` (a spec already in
a GitHub PR): it judges a plan in FLIGHT, against the request that prompted it, while changing
course is still cheap. Same `{verdict, summary}` contract as its siblings, so `--until
verdict=CLEAN` and `loop-until-clean` work against it unchanged; panelizable, so an `--agent`
roster fans it out and a pinned judge merges — FINDINGS beats CLEAN when any panelist's finding
survives. *(Validated 2026-08-06 — `chain-direct-worktree-sweep-260806-152156`: claude ∥ codex
panel, 11 findings merged, codex contributing several claude missed.)*

**Read it as what it is.** A plan review says whether to PROCEED to implement; it says very
little about code that already exists. On the run above, the plan drew 11 findings and the
`review-pr` of the resulting diff found 2 — the implementer had resolved most of them along the
way. Use both stages, and judge the code with `review-pr`.

## An EVENT-DRIVEN agent loop — agents handing work to agents (`h events`)

```sh
h events up                                   # one nats-server -js child; streams h-tasks / h-results
h events serve                                # the relay (leave running; agents run with YOUR env)
h events publish --agent claude --max-steps 5 -p task=@rules.md
h events tail 'h.result.>'                    # watch the loop's terminal event land
```

The local substrate's event fabric (POC). `publish` seeds a
FIRE DESCRIPTOR onto `h.task.default`; the relay composes the template per step (compose-on-fire,
same artifact as `--local`) and executes it through the local runner. The loop edge is the
`publish: {task, agent?}` field an agent may return beside its contract fields — the RELAY
publishes the hand-off, burning one step of the seed's mandatory `--max-steps` budget; omitting
`publish` resolves the loop; a spent budget lands an `exhausted` terminal instead. Every step is a
normal ledger run under the loop's group. *(Validated 2026-08-06 — `loop-260806-231849`: a 3-line
poem written one line per step, claude → codex → claude, terminal `resolved` on
`h.result.loop-260806-231849` carrying the finished poem; 3 ledger runs under the one group.)*

**Durability is the point.** SIGKILL the relay mid-step and restart it: the in-flight task
redelivers (ack is the relay's LAST effect) and the loop completes; `Nats-Msg-Id = <group>:<step>`
dedups a redelivered step's re-publish so the loop never forks. *(Validated 2026-08-06 —
`durab-260806`: relay killed during step 2/6; after restart the step redelivered and the 4-step
loop finished `resolved`.)*

**The budget always fences.** A task that always hands off exhausts instead of looping forever.
*(Validated 2026-08-06 — `budget-260806`: `--max-steps 2` → terminal `exhausted` with the pending
hand-off recorded.)*

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
*(Validated 2026-07-24.)*

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
*(Validated 2026-07-18.)*

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
2026-07-25 — the child's task was literally the parent's answer.)*

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
quota spent.

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
never downgraded. Validated 2026-07-30 (e2e): with claude
budgeted at $0.01, a watched `answer` run booked $0.0555 → the scan fenced claude
(`cost-budget, until next UTC midnight`), the next fire FAILED at the gate with
`executor 'claude' is denied … (auto: daily cost budget crossed …)`, and `h agents list`
showed `auto-denied | $0.01/day | $0.06`.
