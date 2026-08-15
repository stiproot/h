# Installing h

h installs the way nats does: **one command for h itself, operator-provisioned binaries for
everything h drives.** The wheel is self-contained — it ships the CLI, the stock workflow
chart, and a bundled single-file runner — so no h checkout exists at runtime.

## 1. Install the tool

```sh
uv tool install 'h-cli @ git+https://github.com/stiproot/h#subdirectory=cli/h'
h doctor
```

The wheel builds from the repo source at install time, which needs **`bun` on PATH** (it
bundles the JS runner; bun is build-time-only, exactly as in the h repo itself). Upgrade or
repair with `uv tool install --reinstall …`; remove with `uv tool uninstall h-cli`.

## 2. Provision what h drives (h never auto-installs)

`h doctor` is the one-screen report; every surface also refuses loud by name at its point of
use. Required: `node` (spawns the runner), `git`, `helm` (renders charts), `nats-server` (the
run journal + event fabric — journaled runs refuse without the binary; `--no-journal` is the
per-run out; h starts and manages the *process* itself). Plus at least one agent CLI you have
authenticated: `claude`, `codex`, `openhands`, `pi`.

## 3. Where things live (packaged defaults, all overridable)

A packaged install keeps its state under `~/.h/`: `workspace/` (the managed clones boundary —
work targets outside it are refused, `--allow-external` overrides), `worktrees/`,
`workspace/.runs` (the run ledger), `workspace/.nats` (the fabric store), and `.env` (agent
credentials — the shell wins, this file fills gaps).

A consumer repo overrides any of that in `<repo>/.h/config.toml` (discovered by walking up
from cwd; `~` expands; env vars win per setting):

```toml
charts_dir = ".h/charts"              # the repo's domain chart (primary; stock is the fallback)
workspace_dir = "~/code/h-workspace"  # reuse an existing workspace instead of ~/.h/workspace
dotenv = "~/code/h/.env"              # reuse existing credentials
```

## 4. First run

```sh
cd <a repo carrying .h/config.toml — or clone one under the workspace>
h template list                        # domain templates beside the 17 stock ones
h workflow run answer --local -p task="say OK"
h runs watch <instance-id>             # progress/history from any shell
```

## Two install modes, detected not configured

- **Packaged** (this document): `uv tool install`; charts + runner come from the wheel; state
  under `~/.h/`. The CLI and its bundled runner ship together, so they cannot skew.
- **Checkout** (developing h itself): the repo's uv workspace (`uv sync`, `uv run h`), charts
  and runner resolved from the checkout (`bun install && bun run build` once), workspace as
  `../h-workspace`. Pointing a packaged CLI at a checkout runner (`H_LOCAL_BIN`) is allowed —
  the CLI↔runner protocol handshake refuses a version mismatch loudly rather than letting the
  pair skew silently.

The service substrate (Dapr engines, durable supervision/recurrence) is not part of this
install — it runs from the h checkout as before; the packaged CLI can still read and fire it
when a stack is up.
