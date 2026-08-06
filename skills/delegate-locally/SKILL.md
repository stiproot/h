---
name: delegate-locally
description: Hand a bounded piece of work to another agent CLI (codex, pi, openhands, claude) running as a local child process via `h delegate` / `h workflow run --local` / `h chain run --local` — no Dapr, no services, no containers. Use when you want a second opinion, an independent panel on a hard question, parallel exploration, or write work isolated in its own git worktree, and you do NOT need the run to survive your process. Prefer the service substrate (plain `h workflow run`) when the work must outlive this session, recur, or be supervised.
---

# Delegating to local agents

h has two execution substrates. This skill is about the **local** one: `h` drives the agent CLIs
as child processes of your own shell. Nothing has to be running — no Dapr, no agent services, no
Redis, no containers. The prerequisites are `bun run build` once, and CLIs the operator has
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

## Reading the result

- Each agent run writes the standard **run ledger**, so `h runs` and the obs surfaces pick local
  runs up beside service ones. The per-run cost table `h delegate` prints is not decoration:
  there is no watcher on this substrate, so **that table and `h runs` are the only cost
  accounting**. A cost of `—` means the agent reported none (e.g. codex on a ChatGPT plan), never
  that the run was free.
- `--json` on `h delegate` gives the raw envelope: one report per roster slot, each with
  `status`, `output`, `costUsd`, `runId`.
- One agent failing does not lose the others' answers; the job just reports `ok: false`.

## What is refused, and why

Local execution declines anything that needs an engine, and says which one: `--cron`, `--watch`,
`--budget`, `--retry`, `--at`, `--in`, `--fallback-*`, `--fresh`, `--via`, and (on chains)
`--after` plus cron members. Do not work around a refusal — it means the work wants the service
substrate. Likewise the executor refuses `register-cron`, `write-wf-row`, `register-discover` and
`run-itest` by name rather than skipping them: a silently-skipped gate is worse than a stopped run.

Two local-substrate rules worth knowing before you are surprised by them:

- **`setup` steps are skipped** unless you pass `--with-setup`. They provision `~/.claude` — which
  here is the *operator's own* configuration, not a container's.
- **`create-worktree` cuts from the checkout you invoked in.** There is no pre-cloned shared
  workspace; a step's own `clonePath` still wins.

## Safety

A delegated agent runs **as you**, with your shell environment and your credentials, in whatever
directory you point it at. There is no uid drop and no sandbox on this substrate — that isolation
exists only for the containerized fleet. So:

- Use `--worktree` for anything that writes. It is one flag and it contains the blast radius.
- Use `--plan` when you only want an answer; it runs the agent read-only where the CLI supports it.
- Do not delegate a task whose text you have not read, into a checkout you care about.

## Writing the task

The delegate has none of your context, so the task text is the whole brief. State the goal, name
the files or symbols worth starting from, and say what "done" looks like. `@path` splices a file,
so a spec or a question can live in one. For a panel, ask a question that has a real answer —
"which of these is soundest and why" beats "thoughts?", which returns three essays that cannot be
compared.
