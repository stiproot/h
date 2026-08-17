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
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from h_cli.config import DOTENV_PATH, EVENTS_URL, LOCAL_BIN


class LocalRunError(RuntimeError):
    """Raised when the runner cannot start or did not answer; str(err) is user-presentable."""


# The CLI ↔ runner wire-contract version, stamped on every job. The pair can be installed at
# different times (a packaged h-cli bundles its own runner, but H_LOCAL_BIN can point anywhere),
# and the runner's schemas ignore unknown fields — so skew would otherwise be silent. The runner
# refuses a mismatch loudly, naming both versions. Mirrored in local-runtime's
# domain/models.ts LOCAL_PROTOCOL_VERSION (test_local_protocol_sync pins the pair).
LOCAL_PROTOCOL_VERSION = 2


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


# --- the live-run registry (what makes local termination possible) --------------------------------
#
# A run executes as a CHILD of whichever process called run_job. The watcher engine lives in a
# DIFFERENT process, so terminating a budget-overrunning run means asking the process that owns the
# child to kill it — which it can only do if it remembers which child belongs to which run.
#
# The same shape agent-cli's reaper uses for its own CLIs (`liveRuns`), one level up: there the
# registry exists so a dying CLI does not orphan agents, here so a live relay can stop a run the
# engine has decided must end.

_LIVE_RUNS: dict[str, subprocess.Popen[str]] = {}
_LIVE_LOCK = threading.Lock()


def terminate_run(group: str) -> bool:
    """Kill the run executing under `group`. True when one was actually running.

    Kills the process GROUP, not just the node process: the runner spawns agent CLIs, and an
    orphaned CLI keeps working — and keeps billing — with nothing recording it. That is the same
    reason `run_job`'s KeyboardInterrupt path waits for the child to finish dying.
    """
    with _LIVE_LOCK:
        proc = _LIVE_RUNS.get(group)
    if proc is None or proc.poll() is not None:
        return False
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (OSError, ProcessLookupError):
        return False
    return True


def live_runs() -> list[str]:
    """The groups currently executing here — the introspection half of the registry."""
    with _LIVE_LOCK:
        return [g for g, p in _LIVE_RUNS.items() if p.poll() is None]


def runner_path(bin_path: Path | None = None) -> Path:
    """The local runner, or a refusal that names the fix.

    Shared by `run_job` and the engine host's launch, so the two cannot disagree about WHICH runner
    is in play — a packaged install carries its own, and H_LOCAL_BIN can point anywhere.
    """
    runner = bin_path or LOCAL_BIN
    if not runner.is_file():
        from h_cli.config import IS_CHECKOUT

        raise LocalRunError(
            f"local runner not built: {runner}\n"
            + (
                "Run `bun install && bun run build` at the repo root (its one prerequisite), "
                "or point H_LOCAL_BIN at the built bin.js."
                if IS_CHECKOUT
                else "This packaged install is missing its bundled runner — reinstall "
                "(`uv tool install --reinstall h-cli`), or point H_LOCAL_BIN at a built "
                "bin.js from an h checkout. See docs/installing-h.md in the h repo."
            )
        )
    return runner


def run_job(job: dict[str, Any], bin_path: Path | None = None) -> dict[str, Any]:
    """Run one job on the local substrate and return its result envelope.

    Interruption is deliberate and load-bearing: Ctrl-C reaches the child as SIGINT, which
    interrupts its fiber, closes the run scopes and lets agent-cli's reaper group-kill every
    agent CLI. An orphaned CLI would keep working — and keep billing — with nothing recording it,
    so the KeyboardInterrupt path waits for the child to actually finish dying.
    """
    runner = runner_path(bin_path)

    job = {**job, "protocolVersion": LOCAL_PROTOCOL_VERSION}
    group = str(job.get("group") or "")
    try:
        proc = subprocess.Popen(
            ["node", str(runner)],
            # Its own process group, so terminate_run can kill the runner AND the agent CLIs it
            # spawned in one signal rather than leaving them orphaned.
            start_new_session=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            # stderr is INHERITED, not piped: the child's progress lines then stream straight to
            # the terminal as they happen. Piping it and reading through communicate() raced —
            # communicate drains stderr itself, so a reader thread and it split the lines between
            # them and the completion line silently vanished.
            text=True,
            # NATS_URL is stamped rather than left to the shell so ONE value is authoritative:
            # the CLI's EVENTS_URL. The runner reads it for the registry adapters and falls back
            # to the same literal default; test_local_fabric_url_sync pins the pair, the way
            # test_local_protocol_sync pins the protocol version.
            env={**child_env(), "NATS_URL": EVENTS_URL},
        )
    except OSError as err:  # node missing, not executable, …
        raise LocalRunError(f"could not start the local runner ({runner}): {err}") from err

    if group:
        with _LIVE_LOCK:
            _LIVE_RUNS[group] = proc

    try:
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
    finally:
        # Deregister on EVERY exit path, including the interrupt raises above: a stale entry would
        # let a later terminate signal a pid that has since been reused.
        if group:
            with _LIVE_LOCK:
                _LIVE_RUNS.pop(group, None)

    line = next((ln for ln in reversed(stdout.splitlines()) if ln.strip()), "")
    if not line:
        raise LocalRunError(f"the local runner produced no result (exit {proc.returncode})")
    try:
        return json.loads(line)
    except json.JSONDecodeError as err:
        raise LocalRunError(f"unreadable result from the local runner: {line[:200]}") from err


def registry(op: str, **fields: Any) -> Any:
    """Query or write a local KV registry through the runner, returning its `result`.

    The CLI does NOT speak to JetStream directly, and that is the point: registry ids contain `:`,
    which NATS forbids as a key, so every read and write has to encode and decode. A second copy of
    that codec here would drift from the runner's, and the symptom would be an EMPTY listing rather
    than an error — this substrate's most likely failure. One codec, one answer.

    Raises LocalRunError with the runner's own message when the registry cannot answer (a stopped
    fabric, most often), so callers render a sentence rather than a stack trace.
    """
    envelope = run_job({"kind": "registry", "op": op, **fields})
    if not envelope.get("ok"):
        raise LocalRunError(envelope.get("error") or f"registry {op} failed")
    return envelope.get("result")
