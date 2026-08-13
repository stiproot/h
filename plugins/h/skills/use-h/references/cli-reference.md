# h CLI reference — the consumer surface

The commands and configuration a repo consuming h actually uses. The full operator surface
(service substrate, chains with engines, crons, watches, schedules) is documented in the h
repo itself (`cli/README.md`, `docs/cookbook.md`).

## `.h/config.toml` keys ↔ env vars

Precedence per setting: env var > config file > h-checkout default. Relative paths resolve
against the repo carrying the file.

| Key | Env var | Meaning |
| --- | --- | --- |
| `charts_dir` | `H_CHARTS_DIR` | this repo's chart root (primary in the search path) |
| `local_bin` | `H_LOCAL_BIN` | the built `h-local` runner (`bin.js`) |
| `workspace_dir` | `H_WORKSPACE_DIR` | the managed workspace root (`h-workspace/`) |
| `worktrees_dir` | `H_LOCAL_WORKTREES_DIR` | where local-substrate worktrees are cut |
| `runs_dir` | `AGENT_RUNS_DIR` | the run ledger root |
| `dotenv` | `H_DOTENV` | the `.env` that fills credential gaps (shell wins on `--local`) |
| `events_store` | `H_EVENTS_STORE` | the event fabric's JetStream store |

Unknown keys and non-string values fail loud.

## Toolchain

```sh
h doctor          # one-screen report: required binaries (node, git, helm), agent CLIs,
                  # optional pieces (nats-server), the built runner, both chart roots,
                  # and which consumer config is in effect. A report, never a gate.
```

Prerequisites for `--local` runs: an h checkout built once (`bun install && bun run build`),
`helm` and `node` on PATH, and agent CLIs the operator has already authenticated —
credentials come from the shell, with the repo's `dotenv` filling gaps.

## Templates

```sh
h template list                 # all templates on the search path, with a chart-ownership column
h template get <name>           # one template's rendered definition
h template drift [KEYS…]        # saved definitions vs a re-render of their templates
```

## Running on the local substrate

```sh
h workflow run <template> --local [-p k=v]... [--instance-id id] [--agent A]... [--model M]
h workflow run <t> --local --with-setup        # opt IN to the definition's setup steps
h workflow run <t> --local --allow-external    # deliberate override of the workspace boundary
h delegate "TASK" --agent codex [--agent claude]... [--model M] [--cwd D] \
    [--worktree [--base B]] [--plan] [--timeout S] [--id G] [--json]
h chain run --slug s --local -p task=… \
    -w answer --id first  --capture answer=answer \
    -w answer --id second --input task=first.answer
```

- `-p key=value` populates content params; `@path` splices a file (`-p spec=@spec.md`).
- Several `--agent` flags = a panel. `h workflow run` panelizes with a pinned judge;
  `h delegate` prints each answer with no synthesis.
- Engine flags are refused by name on `--local`: `--cron`, `--watch`, `--budget` (per-member),
  `--retry`, `--at`, `--in`, `--fallback-*`, `--fresh`, `--via`. A chain-wide prefix
  `--budget` IS honoured (checked between stages).
- Refused activities: `write-wf-row`, `register-cron`, `register-discover`, `run-itest`, and
  service-only agents — refused, never silently skipped.

## The event fabric (`h events`) — step-budgeted local loops

One `nats-server -js` child (operator-installed binary), two streams (`h-tasks`,
`h-results`). An agent's structured block may carry `publish: {task, agent?}` to hand the
next step to the next agent; the relay publishes it, and a mandatory `--max-steps` budget
fences the loop.

```sh
h events up|down|status
h events serve [--repo PATH] [--in-place]       # the relay; every group gets its own worktree
h events publish --max-steps N -p task=@t.md [--template answer] [--agent claude] [--group G]
h events await GROUP [--timeout S] [--json]     # block for one loop's terminal (replays history)
h events results [--durable NAME] [--json]      # durable back-edge: terminals since last ack
h events tail 'h.result.>'                      # live watch only — misses what it wasn't present for
```

## Results and leftovers

```sh
h runs                                          # recent runs off the ledger
h worktrees list [--json] [--repo PATH]         # worktrees h cut, status-graded (dirty/scratch/unpushed)
h worktrees rm BRANCH [--force] [--prune-untracked]
h worktrees sweep [--dry-run] [--force] [--prune-untracked]
```

`--force` discards tracked edits and unpushed commits; `--prune-untracked` discards only
files git never tracked, naming each first. Two flags because they accept different classes
of loss.

## Pointing at a service stack (durability)

The substrates compose: the same template fired WITHOUT `--local` goes to a running h
service stack (Dapr workflow engine + the watcher/chain/cron engines) and gains durability,
supervision, recurrence, and scheduling (`--cron`, `--watch`, `--at`, `--fallback-agent`, …).
That requires the operator's h stack to be up; nothing in this repo needs to change — the
definition is the same.
