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
bundles the JS runner; bun is build-time-only, exactly as in the h repo itself). Remove with
`uv tool uninstall h-cli`.

### Knowing and changing which h you have

`h --version` names the SOURCE COMMIT, not just the release number:

```
h-cli 0.1.0@cb97460 [packaged, 2026-08-15]
```

That matters because the version is a release series — every wheel cut from main is `0.1.0`, so
the number alone cannot tell two builds apart. `h --version-json` is the machine-readable form a
consumer's sync script compares against its pin.

**To move to a newer h**, name the revision and force the reinstall:

```sh
uv tool install --reinstall --from 'git+https://github.com/stiproot/h@main#subdirectory=cli/h' h-cli
h --version     # confirm it actually moved
```

Two traps worth knowing, both hit live on 2026-08-16:

- **`--reinstall` alone re-installs whatever requirement was RECORDED, which may not be git.**
  A tool first installed from a locally-built wheel (`uv tool install ./dist/*.whl`) has that
  path in its receipt, so a bare `--reinstall` rebuilds the same stale artifact and reports
  success. `--from` is what re-points it. Check `~/.local/share/uv/tools/h-cli/uv-receipt.toml`
  if a sync looks like a no-op.
- **`uv tool install` is ONE h per machine.** Every consumer repo shares `~/.local/bin/h`; only
  the config and charts are per-repo. If two consumers need different h revisions, they cannot
  both use the global tool — see below.

### Per-repo isolation (when consumers must not move together)

A consumer that needs its own pinned h installs into a **project-local venv** instead of the
global tool, and records the revision it is on:

```sh
uv venv .h/venv
uv pip install --python .h/venv 'h-cli @ git+https://github.com/stiproot/h@<sha>#subdirectory=cli/h'
.h/venv/bin/h --version
```

Then `.h/venv/bin/h` (or a `.h/bin/h` wrapper on PATH) is that repo's h, pinned by a committed
lock file, and upgrading one consumer cannot touch another. The trade is a venv per consumer
(~40MB) and invoking h through the wrapper. `trxy-v2` is the reference implementation — its
`scripts/h-sync.sh` does the whole cycle, including telling you when the pin and the install
have drifted apart.

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
