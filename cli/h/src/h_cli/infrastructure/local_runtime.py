"""Client for the local execution substrate — the sibling of workflow_svc.py.

Where workflow_svc.py POSTs a composed workflow to a running service, this spawns the
local-runtime binary and pipes the job in on stdin. The CLI composes identically either way;
only which of these two modules receives the result changes.

The child writes human progress to stderr — inherited, so it appears live rather than after the
job — and the result envelope as one JSON line on stdout.
"""

import json
import os
import signal
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from h_cli.config import DOTENV_PATH, LOCAL_BIN


class LocalRunError(RuntimeError):
    """Raised when the runner cannot start or did not answer; str(err) is user-presentable."""


def group_id(base: str) -> str:
    """`<base>-<yymmdd>-<hhmmss>` — the readable derived-id convention h uses for instance ids.

    On this substrate it names the run everywhere it can be named: the run-ledger group, the
    workspace key, and the worktree directory.
    """
    return f"{base}-{datetime.now().strftime('%y%m%d-%H%M%S')}"


def repo_root(cwd: Path) -> str:
    """The checkout a worktree is cut from — the one the operator is standing in.

    Local execution has no pre-cloned shared workspace to default to, which is the point: you
    already have a checkout. Not being in a git repo is a loud refusal, never a silent fallback
    to some other directory.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as err:
        raise LocalRunError(f"not a git checkout: {cwd}") from err
    return out.stdout.strip()


def _parse_dotenv(path: Path) -> dict[str, str]:
    """KEY=VALUE lines from a .env file. Deliberately not a shell parser — no expansion, no
    substitution: just the flat assignments compose reads."""
    values: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.removeprefix("export ").strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def child_env(dotenv_path: Path | None = None) -> dict[str, str]:
    """The environment the agent CLIs inherit: this shell, with the repo's .env filling the gaps.

    Local execution's premise is that the operator's OWN credentials are the setup — but in this
    repo those live in .env, which only compose and the run scripts load. Reading it here is what
    makes `h delegate` work without a bring-up, using exactly the keys the agent services get.

    Precedence is SHELL-WINS, the opposite of `cli/scripts/compose.sh`, which strips .env keys
    from the process env so the file is authoritative for containers. The two answer different
    questions: compose recreates long-lived services from a declared file (a stale shell export
    silently shadowing it caused two bad recreates on 2026-07-16), while an interactive `h
    delegate` must honour a key the operator just exported for this one command. Stated here
    because the difference is deliberate, not an oversight.
    """
    env = dict(os.environ)
    for key, value in _parse_dotenv(dotenv_path or DOTENV_PATH).items():
        env.setdefault(key, value)
    return env


def run_job(job: dict[str, Any], bin_path: Path | None = None) -> dict[str, Any]:
    """Run one job on the local substrate and return its result envelope.

    Interruption is deliberate and load-bearing: Ctrl-C reaches the child as SIGINT, which
    interrupts its fiber, closes the run scopes and lets agent-cli's reaper group-kill every
    agent CLI. An orphaned CLI would keep working — and keep billing — with nothing recording it,
    so the KeyboardInterrupt path waits for the child to actually finish dying.
    """
    runner = bin_path or LOCAL_BIN
    if not runner.is_file():
        raise LocalRunError(
            f"local runner not built: {runner}\n"
            "Run `bun install && bun run build` at the repo root (its one prerequisite), "
            "or point H_LOCAL_BIN at the built bin.js."
        )

    try:
        proc = subprocess.Popen(
            ["node", str(runner)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            # stderr is INHERITED, not piped: the child's progress lines then stream straight to
            # the terminal as they happen. Piping it and reading through communicate() raced —
            # communicate drains stderr itself, so a reader thread and it split the lines between
            # them and the completion line silently vanished.
            text=True,
            env=child_env(),
        )
    except OSError as err:  # node missing, not executable, …
        raise LocalRunError(f"could not start the local runner ({runner}): {err}") from err

    try:
        stdout, _ = proc.communicate(json.dumps(job))
    except KeyboardInterrupt:
        proc.send_signal(signal.SIGINT)
        try:
            stdout, _ = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise LocalRunError("interrupted; the runner did not shut down in 30s") from None
        raise LocalRunError("interrupted") from None

    line = next((ln for ln in reversed(stdout.splitlines()) if ln.strip()), "")
    if not line:
        raise LocalRunError(f"the local runner produced no result (exit {proc.returncode})")
    try:
        return json.loads(line)
    except json.JSONDecodeError as err:
        raise LocalRunError(f"unreadable result from the local runner: {line[:200]}") from err
