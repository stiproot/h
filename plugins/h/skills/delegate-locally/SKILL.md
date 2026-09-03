---
name: delegate-locally
description: Hand a bounded piece of work to another agent CLI (codex, pi, openhands, claude) running as a local child process via `h delegate` / `h workflow run --local` / `h chain run --local` — no Dapr, no services, no containers. Use when you want a second opinion, an independent panel on a hard question, parallel exploration, or write work isolated in its own git worktree, and you do NOT need the run to survive your process. Prefer the service substrate (plain `h workflow run`) when the work must outlive this session, recur, or be supervised.
---

# Delegating to local agents

h has two execution substrates. This skill is about the **local** one: `h` drives the agent CLIs
as child processes of your own shell. Nothing has to be running — no Dapr, no agent services, no
Redis, no containers. The prerequisite is CLIs the operator has
already authenticated.

The other substrate — plain `h workflow run` / `h chain run` — fires the same definition at
workflow-svc, where the watcher, chain and cron engines supervise, sequence and recur it durably.
**Choose by whether the work must outlive you**, not by what feels lighter.

## When to delegate locally

Good reasons:

- **A second opinion you'll act on now.** A different model reasoning independently catches things
  you won't, because it does not share your context or your assumptions.
- **A panel on a genuinely open question.** Several agents answering independently, then a judge
  synthesizing — worth the cost when the answer is contested, not when it is a lookup.
- **Parallel exploration.** Three agents reading three subsystems at once.
- **Write work you want isolated.** `--worktree` gives each agent its own checkout, so a
  delegated edit never touches the live tree.

Bad reasons — do these yourself:

- Anything you can answer from the code in front of you. A delegation costs real money and
  ~10–40s; reading a file costs neither.
- Work that needs your accumulated context. The delegate starts cold; re-explaining it is usually
  more expensive than doing the task.
- Anything unattended, recurring, or long-horizon. That is the service substrate's job.

## The three surfaces

```sh
# the atom: one task, one or more agents, in a directory
h delegate --agent codex "explain why this parser drops trailing commas"
h delegate --agent claude --agent codex --agent pi "which of these three designs is soundest?"
h delegate --agent codex --worktree "add a --dry-run flag to the importer"
h delegate --agent codex --plan --json "…"        # read-only; machine-readable envelope

# a whole template, executed here
h workflow run answer --local -p task=@question.md
h workflow run answer --local --agent claude --agent codex -p task=…   # panel + pinned judge
h workflow run plan   --local -p slug=x -p spec=@spec.md               # cuts a worktree

# a chain: several definitions, state threaded between them
h chain run --slug x --local -p task=… \
    -w answer --id first  --capture answer=answer \
    -w answer --id second --input task=first.answer
```

`h delegate` deliberately does NOT synthesize a roster's answers — it prints each. For a judged
synthesis use `h workflow run answer --local --agent a --agent b`, which panelizes through the
same transform the service substrate uses and adds a pinned judge.

A fourth surface is the EVENT FABRIC (`h events`, POC): `h events up` runs a local
`nats-server -js` (operator-installed binary), `h events serve` arms the relay, and
`h events publish --max-steps N -p task=…` seeds an event-driven loop in which an agent's
structured output may hand the next task to the next agent via a `publish: {task, agent?}` field —
the relay does the publishing and a mandatory step budget fences the loop. Every step is a normal
local run (ledger, env, cost — all the rules below apply); the relay's shell must carry the same
credentials `h delegate` would need (e.g. `CODEX_AUTH_MODE=chatgpt` for codex).

## Reading the result

- Each agent run writes the standard **run ledger**, so `h runs` and the obs surfaces pick local
  runs up beside service ones. The per-run cost table `h delegate` prints is not decoration:
  nothing supervises a foreground run — the watcher tallies cost for runs the RELAY executes, not
  for one in your shell — so **that table and `h runs` are the only cost accounting here**. A cost of `—` means the agent reported none (e.g. codex on a ChatGPT plan), never
  that the run was free.
- A `--local` CHAIN additionally journals each completed stage (the fabric's `h-journal`
  stream; auto-ensured, `--no-journal` opts out), so a run that dies or fails mid-chain resumes
  with `h chain run --local --resume GROUP <same expression>` — completed stages replay from
  the journal instead of being re-paid. A changed expression is refused (it is a NEW run);
  resuming a completed group is a loud no-op.
- `--json` on `h delegate` gives the raw envelope: one report per roster slot, each with
  `status`, `output`, `costUsd`, `runId`.
- One agent failing does not lose the others' answers; the job just reports `ok: false`.

## What is refused, and why

Most engine flags WORK here now (2026-08-17): `--cron`/`--max-fires`, `--at`/`--in`,
`--watch`/`--budget`, and discovery fan-out all run against a local engine host over JetStream.
Bring it up with `h events up` — and `h events up --with-relay` if nothing will be watching the
terminal, because a cron fires by publishing and a queue nobody drains is a recurrence that
silently never runs.

What is still refused, and each names something real rather than a gap waiting to be filled:

- `--retry`, `--fallback-*` on a FOREGROUND run — both RE-FIRE, which needs something that outlives
  the run, and nothing outlives a shell. (They work on relay-executed fires.)
- `--via` and `--fresh` — routing through an agent service's babysitter, and purging a durable Dapr
  instance. Neither exists here.
- `run-itest` (an ephemeral k8s namespace), `gc-worktrees` (an agent SERVICE's workspace — use
  `h worktrees sweep`), and the service-only agents (no agent-cli strategy drives them).
- `write-wf-row` / `register-cron` AS STEPS — both happen here, but as engine BRACKETS around a run
  on either substrate, so a template naming one is a composition error.
- Chains: `--after` activation gates, and `h chain list --local` — local chains are driver-sequenced
  and journaled rather than engine-hosted.

`--budget` on a foreground run is enforced by the DRIVER between steps: it declines to start more
work past the deadline but cannot kill a running agent, which the per-step timeout bounds. Do not
work around a refusal — each one names what it needs.

Rules worth knowing before you are surprised by them:

- **`setup` steps are skipped** unless you pass `--with-setup`. They provision `~/.claude` — which
  here is the *operator's own* configuration, not a container's.
- **A freshly cut worktree has no installed dependencies.** `create-worktree` is a `git worktree
  add`, nothing more: no `node_modules`, no `.venv`. So a task whose acceptance command is a build,
  lint or typecheck will fail there until you run `bun install --frozen-lockfile` (fast — it
  hardlinks from the shared bun cache) and/or `uv sync --frozen` in the worktree. The repo's
  pre-push hook runs the full guard surface, so **a push from an uninstalled worktree fails too**.
  Watch out for the diagnosis: the toolchain guard reports `no tsc at .../node_modules/.bin/tsc`
  and prints the poisoned-bun-cache repair recipe, which is the WRONG fix here — a fresh worktree
  simply never had an install, and one `bun install` is the whole answer.
- **`create-worktree` cuts from the checkout you point it at**; a step's own `clonePath` still wins.
- **Work targets are bounded to the workspace h manages.** `--cwd` (delegate) and `--repo`
  (`h events serve`) must resolve inside `h-workspace/<repo>` — h's own clone of the target — the
  worktrees cut from it (`h-worktrees/`), or h's own repo. Anything else is refused by name, with
  `--allow-external` as the deliberate override. So the first step of working on a new repo is
  **clone it under `h-workspace/`**, never point h at a checkout you have work in progress in.
  This is the local mirror of what the service substrate always did (agents work in the shared
  workspace root), and it is a safety boundary rather than tidiness: see Safety below.

## Safety

A delegated agent runs **as you**, with your shell environment and your credentials, in whatever
directory you point it at. There is no uid drop and no sandbox on this substrate — that isolation
exists only for the containerized fleet. So:

- Use `--worktree` for anything that writes. It is one flag and it contains the blast radius.
- Use `--plan` when you only want an answer; it runs the agent read-only where the CLI supports it.
- Do not delegate a task whose text you have not read, into a checkout you care about.
- **Make the agent's workspace TRUE.** A task that asserts where the agent is ("you are in repo X
  on branch Y") while the cwd says otherwise does not confuse the agent into stopping — it sends
  it SEARCHING, and it searches as you, across your whole filesystem. Live on 2026-08-10 an agent
  did exactly that, found a second clone of the target repo, and branched and committed into the
  operator's in-flight work. Pass the workspace, do not describe it; the managed-workspace guard
  above and the relay's per-group worktree exist to keep the description honest.
- **The "workspace has not been trusted" warning is expected in h's clones, and inert.** Claude
  ignores a repo's `permissions.allow` until its path is trusted, and h's managed clones are never
  opened interactively, so the trust dialog never fires there — but local runs pass
  `--dangerously-skip-permissions` (or read-only plan mode), which never prompts, so the ignored
  allow-list changes nothing. h deliberately does NOT stamp trust on its own (that would be h
  writing security assertions into the operator's `~/.claude.json` for every repo it clones). The
  operator opt-in is `h workspaces trust [PATH]` — managed checkouts only; it silences the warning
  and puts the allow-list in effect.

## Writing the task

The delegate has none of your context, so the task text is the whole brief. State the goal, name
the files or symbols worth starting from, and say what "done" looks like. `@path` splices a file,
so a spec or a question can live in one. For a panel, ask a question that has a real answer —
"which of these is soundest and why" beats "thoughts?", which returns three essays that cannot be
compared.

**Name the WHOLE acceptance command, formatters included.** A delegate does exactly what "done"
says: give it only the test command and you get passing tests in unformatted code, which then
fails the pre-push guards. State the full gate the change must survive (e.g. `uv run ruff format
cli/h && uv run ruff check cli/h && uv run --package h-cli pytest cli/h/tests`), and check the
command actually works before you hand it over — a wrong acceptance command sends the agent
debugging your instructions instead of doing the task.

**Check for prior work before delegating.** Search branches, open PRs and existing worktrees for
the thing you are about to commission. A delegate starts cold and will happily rebuild something
that is already sitting in review — the cost lands before anyone notices the duplication. (Bit us
live 2026-08-10: a feature was re-implemented from scratch while its PR had been open a week.)

## Long write work: checkpoint-first, driver-as-fallback

For a FOREGROUND run nothing supervises you: the watcher, the retry engine and scheduled
continuations act on runs the relay executes, and a `h delegate` in your shell is reachable by
none of them — **so the driver is its own fallback engine**. A long delegate can die mid-run on a subscription/usage limit (the
report says `[usage-limited]` with the CLI's reset time — h#111/#112 made that legible), and a
restarted run that begins from zero wastes everything the dead one did. Two conventions contain
this:

- **Write the task RE-ENTRANT.** Instruct the agent to (1) check the branch for prior checkpoint
  commits and continue from the next unfinished item, and (2) commit every completed deliverable
  immediately as its own `<stage>(n):` commit, never batching finished work behind unfinished
  work. A killed run then costs only its in-flight item, and ANY agent can resume — the branch is
  the checkpoint, not the dead agent's context.
- **Anticipate the limit instead of surviving it.** Every run records the rate-limit windows
  its CLI reported (`h agents list --local` prints them per executor: `5h 53% → 17:00 · 7d
  22% → Tue 21:00`; `!` = the CLI's last report was REJECTED), and the pre-fire gate reads that
  row: a fire that would push a window past 100% is refused by name with the reset time and
  the ways past it, before any cost lands. Read the row before a long delegate. For
  unattended work pass `--on-quota wait` — the gate then refuses at 90% and, when it does,
  the run SLEEPS until the reset (up to 6h) instead of failing. `--ignore-quota` is the
  deliberate override, for a run you have decided is worth the risk of dying usage-limited.
- **Fall back across CLIs deliberately.** Re-firing the same id reuses the worktree idempotently;
  on a usage-limited stop either wait out the reset or re-fire the same task under a different
  authenticated CLI (`--agent codex`, `--agent openhands`) — the checkpoint convention is what
  makes the handoff safe. This is the manual sibling of the service substrate's
  `--fallback-agent`; if you find yourself doing it repeatedly for the same recurring work, that
  work wants the service substrate.
