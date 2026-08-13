---
name: use-h
description: Run agentic workflows from this repo with the h CLI — fire a domain workflow template (`h workflow run <template> --local`), hand a bounded task to an agent CLI (`h delegate`), check the toolchain (`h doctor`), and read results and cost from the run ledger. Use whenever driving, simulating, or automating domain work through h from a repo that consumes it (one carrying `.h/config.toml`), when asked to run, compose, or debug an h workflow here, or when an h command refuses a flag or a path and you need to know why.
---

# Using h from a consumer repo

h is an agentic workflow runtime: it composes work as **workflow definitions** — ordered steps
invoking activities, most of them "run an agent CLI against this task" — and executes them on
one of two substrates. This repo is a **consumer** of h: it carries its own domain workflow
templates under `.h/charts/` and declares its paths in `.h/config.toml`, while h itself is
operator-provisioned tooling (a built h checkout with the `h` command on PATH, like helm or
the nats CLI). h never auto-installs anything; every missing piece is refused loud by name,
and `h doctor` reports the whole toolchain on one screen.

The substrate a consumer repo uses is almost always the **local** one: `--local` executes the
definition in the CLI process, driving agent CLIs (claude / codex / pi / …) as local child
processes — no Dapr, no services, no containers. The agent inherits this repo's own
`.mcp.json` unmodified, which is the point: **a domain workflow drives this repo's MCP tools**
(the composition h calls D5). The service substrate (durable, supervised, recurring) exists
too — plain `h workflow run <key>` fired at a running h stack — but needs that stack up;
choose it when work must outlive your session, not because it feels more real.

## The consumer contract

`.h/config.toml` at the repo root is discovered by walking up from cwd (the way git finds its
repo), so any `h` invocation from inside the repo needs no exported environment. Precedence
per setting: **env var > `.h/config.toml` > h-checkout default**. Relative paths resolve
against the repo carrying the file. Keys (each paired with an env var — see the
[CLI reference](references/cli-reference.md)): `charts_dir`, `local_bin`, `workspace_dir`,
`worktrees_dir`, `runs_dir`, `dotenv`, `events_store`. Unknown keys fail loud — a typo'd key
silently falling back is how a run lands in the wrong charts.

**Charts are a SEARCH PATH, not a replacement**: the configured `charts_dir` is the primary
and h's stock chart is the fallback, so this repo's domain templates (`h template list` shows
a `chart` column) sit beside h's stock ones (`answer`, `implement`, `review-pr`, …). A name
present in both resolves to the primary.

## Running work

```sh
h doctor                                          # toolchain + which consumer config is in effect
h template list                                   # domain + stock templates, with ownership
h template get <name>                             # inspect one template's rendered definition

h workflow run <template> --local \
  --instance-id <readable-id> \                   # names the run; the run ledger keys on it
  [-p key=value]... [-p spec=@file.md]            # CONTENT rides -p; @path splices a file

h workflow run answer --local --agent claude --agent codex -p task=…   # a judged panel
h delegate "TASK" --agent codex [--worktree] [--plan] [--json]         # the atom: one task, one/more agent CLIs
h chain run --slug s --local EXPR                 # sequence several definitions, state threaded
```

Flags are the closed **machinery** vocabulary (`--agent` = executor, `--model`,
`--instance-id`); everything content-shaped rides `-p key=value`. A roster (several `--agent`
flags) panelizes: parallel independent answers plus a pinned judge on `h workflow run`, plain
parallel answers with no synthesis on `h delegate`.

## What `--local` refuses, and why

Local execution declines anything that needs an engine, **by name**: `--cron`, `--watch`,
`--budget` (per-member), `--retry`, `--at`, `--in`, `--fallback-*`, `--fresh`, `--via`.
Supervision, recurrence and sequencing live in h's service engines precisely so a workflow
never supervises itself; in-process, the driver is the supervisor. Do not work around a
refusal — it means the work wants the service substrate. Likewise:

- **`setup` steps are skipped** unless `--with-setup` — they would provision the *operator's
  own* `~/.claude`, not a container's.
- **Work targets are bounded** to the workspace h manages (`h-workspace/<repo>`, the
  worktrees cut from it, h's own repo). Anything else is refused, with `--allow-external` as
  the deliberate override. A local agent runs as the operator with their credentials and no
  sandbox — the boundary is the blast radius.
- **A freshly cut worktree has no installed dependencies** — run the repo's install commands
  there before any build/lint acceptance step.

## Reading the result

Every run writes the standard **run ledger** (`summary.json`, `events.jsonl`, `output.txt`
under the configured runs dir, keyed by instance id). On the local substrate there is no
watcher, so the ledger and the CLI's printed cost table are **the only cost accounting** — a
cost of `—` means the agent reported none (e.g. codex on a ChatGPT plan), never that the run
was free. A template that declares an `outputs:` schema ends its run with a machine-validated
fenced JSON block — the last thing in `output.txt`, and the thing to parse, not the prose.

## Safety

A delegated agent runs **as you**, with your shell environment and credentials, in the
directory you point it at. Use `--worktree` (or a template that cuts one) for anything that
writes to the repo; use `--plan` for read-only answers. Domain workflows that mutate
*external* state (a database, a live service, social accounts) must pin their safe
environment in the template's values and refuse production targets in the task prose — the
repo's own templates document what they touch. The task text is the delegate's whole brief:
state the goal, name the starting files, and give the full acceptance command, formatters
included.

For the full command surface — config keys/env pairs, the event fabric (`h events`) for
step-budgeted loops, worktree admin — see the [CLI reference](references/cli-reference.md).
To create or change a domain template in this repo, use the `author-h-template` skill.
