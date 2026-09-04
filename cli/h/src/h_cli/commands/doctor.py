"""h doctor — what the local substrate can reach from HERE: tools, charts, config.

A presence report, deliberately not a gate: every surface still refuses loud by name at its own
point of use (the operator-provisioned posture — h never auto-installs). Doctor exists so a
consumer setting up a repo can see the whole toolchain on one screen instead of discovering each
missing piece one refusal at a time.
"""

import json
import shutil
import subprocess
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from h_cli.commands._quota import quota_cell
from h_cli.config import (
    _CHECKOUT_ANCHOR,
    _MAIN_CHECKOUT_DIR,
    _REPO_DIR,
    CONSUMER_CONFIG_ROOT,
    DOTENV_PATH,
    EVENTS_STORE_DIR,
    H_WORKSPACE_DIR,
    IS_CHECKOUT,
    LOCAL_BIN,
    LOCAL_BIN_BUILDABLE,
    LOCAL_WORKTREES_DIR,
    charts_roots,
)
from h_cli.infrastructure.local_runtime import LocalRunError, probe_agents, registry

console = Console()

# The local substrate's binaries, split by when they matter. Required: a --local run refuses
# without them. Agent CLIs: at least one is needed, whichever the roster names. nats-server sits
# between the tiers: journaled `--local` chain runs (the default) refuse loud without it, and
# `--no-journal` is the per-run out — so it is listed with the required set but named for what
# actually needs it. The binary stays operator-provisioned; h only manages the process.
_REQUIRED = (
    ("node", "spawns the h-local runner"),
    ("git", "clones and worktrees"),
    ("helm", "renders workflow charts"),
    ("nats-server", "the run journal (--local chains; --no-journal opts out) + h events"),
)
_AGENT_CLIS = ("claude", "codex", "openhands", "pi")
_OPTIONAL = (
    ("nats", "fabric inspection (optional tooling)"),
    ("bun", "build-time only (bun run build in the h checkout)"),
)


def _tool_row(name: str, purpose: str) -> tuple[str, str, str]:
    path = shutil.which(name)
    return (name, "[green]ok[/green]" if path else "[yellow]missing[/yellow]", path or purpose)


def _agent_row(name: str, readiness: dict[str, dict] | None) -> tuple[str, str, str]:
    """An agent CLI's row: on PATH is necessary, being able to AUTHENTICATE is what matters.

    Doctor used to answer this with `shutil.which` alone and print `ok` for a binary that could not
    run. On 2026-09-01 that cost a two-agent review half its roster: codex was reported ok, the run
    started, and codex died on its first breath because nothing set CODEX_AUTH_MODE=chatgpt. The
    credentials were on disk the whole time.

    So a row now carries three distinct states, and the third is the one that did not exist:
    `missing` (no binary), `no auth` (binary present, its own validateEnvironment unsatisfied,
    naming the variables), and `ok`. A fourth, `on PATH`, is UNKNOWN — the probe could not be
    reached — and is deliberately not rendered as either ok or no auth, because answering from
    ignorance is the failure being fixed, not a milder version of it.
    """
    path = shutil.which(name)
    if not path:
        return (name, "[yellow]missing[/yellow]", "agent CLI")
    if readiness is None:
        return (name, "[dim]on PATH[/dim]", f"{path} (auth unknown — runner probe unavailable)")
    state = readiness.get(name)
    if state is None:
        return (name, "[dim]on PATH[/dim]", f"{path} (auth unknown — agent not probed)")
    if state.get("ready"):
        return (name, "[green]ok[/green]", path)
    return (name, "[yellow]no auth[/yellow]", state.get("detail") or "cannot authenticate")


def _count_templates(root: Path) -> int:
    return len(list((root / "workflows" / "templates").glob("*.tmpl.yaml")))


def _runner_stale_packages(limit: int = 3) -> list[str]:
    """Packages turbo would rebuild before the next `--local` run — empty when the runner is
    current.

    Asks TURBO rather than comparing mtimes. Turbo hashes content, so a `touch` or a branch switch
    that changed nothing reports fresh, where an mtime comparison cries stale — and a column that
    cries wolf is one the reader learns to skip. Costs one dry run and only in a checkout, the one
    place the answer is h's to give; anything unreadable (missing or hollow turbo) reports nothing
    rather than guessing, since the run itself refuses loudly on a broken toolchain.
    """
    turbo = _REPO_DIR / "node_modules/.bin/turbo"
    if not LOCAL_BIN_BUILDABLE or not turbo.is_file():
        return []
    try:
        done = subprocess.run(
            [str(turbo), "build", "--filter=local-runtime", "--dry-run=json"],
            cwd=_REPO_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        tasks = json.loads(done.stdout).get("tasks", []) if done.returncode == 0 else []
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []
    stale = [t["package"] for t in tasks if t.get("cache", {}).get("status") != "HIT"]
    return stale[:limit]


def _print_quota() -> None:
    """Each agent's rate-limit headroom as its CLI last reported it — the `quota:` registry the
    pre-fire gate reads. Authenticated is not the same as able to run: an exhausted five-hour
    window refuses every step until it resets, and the reset time is what a shepherd schedules
    around. Best-effort: the registry lives on the local fabric, which may be down."""
    try:
        rows = registry("quota.list") or []
    except LocalRunError as err:
        console.print(f"[dim]quota: local fabric unreachable — no headroom report ({err})[/dim]")
        return
    if not rows:
        console.print("[dim]quota: no agent has reported its rate-limit windows yet[/dim]")
        return
    for row in rows:
        console.print(
            f"quota: {row['executor']} {quota_cell(row)}  "
            f"[dim](observed {row.get('observedAt', '?')} by {row.get('runId', '?')})[/dim]"
        )


def doctor() -> None:
    """Report the local-substrate toolchain: binaries, the built runner, charts, and which
    consumer config (.h/config.toml) is in effect. Informational — nothing is installed."""
    tools = Table("tool", "status", "detail", title="tools")
    for name, purpose in _REQUIRED:
        tools.add_row(*_tool_row(name, f"REQUIRED — {purpose}"))
    probed = probe_agents()
    readiness = {a["agent"]: a for a in probed} if probed else None
    agent_rows = [_agent_row(name, readiness) for name in _AGENT_CLIS]
    for row in agent_rows:
        tools.add_row(*row)
    for name, purpose in _OPTIONAL:
        tools.add_row(*_tool_row(name, f"optional — {purpose}"))
    console.print(tools)
    _print_quota()
    # The aggregate is about READINESS, not presence: a box full of binaries that cannot
    # authenticate runs exactly as much work as a box with none.
    if not any("ok" in status for _, status, _ in agent_rows):
        console.print(
            "[yellow]no agent can run here[/yellow] — a --local run needs at least one of "
            + ", ".join(_AGENT_CLIS)
            + " both installed AND authenticated."
        )

    paths = Table("piece", "status", "path", title="local substrate")
    runner_ok = LOCAL_BIN.is_file()
    stale_pkgs = _runner_stale_packages() if runner_ok else []
    if not runner_ok:
        runner_status = "[yellow]not built[/yellow]"
        runner_detail = (
            f"{LOCAL_BIN} — run `bun install && bun run build` in the h checkout, "
            "or point H_LOCAL_BIN / local_bin at a built bin.js"
        )
    elif stale_pkgs:
        runner_status = "[yellow]stale[/yellow]"
        runner_detail = (
            f"{LOCAL_BIN} — {', '.join(stale_pkgs)} would rebuild; "
            "a --local run does that automatically before it runs"
        )
    else:
        runner_status = "[green]built[/green]"
        runner_detail = str(LOCAL_BIN)
    paths.add_row("h-local runner", runner_status, runner_detail)
    for label, root in zip(("charts (primary)", "charts (stock)"), charts_roots()):
        count = _count_templates(root)
        paths.add_row(
            label,
            f"[green]{count} templates[/green]" if count else "[yellow]empty[/yellow]",
            str(root),
        )
    paths.add_row(
        "workspace boundary",
        "[green]exists[/green]" if H_WORKSPACE_DIR.is_dir() else "[yellow]absent[/yellow]",
        str(H_WORKSPACE_DIR),
    )
    paths.add_row(
        "worktrees root",
        "[green]exists[/green]" if LOCAL_WORKTREES_DIR.is_dir() else "[dim]not yet cut[/dim]",
        str(LOCAL_WORKTREES_DIR),
    )
    paths.add_row(
        ".env",
        "[green]found[/green]" if DOTENV_PATH.is_file() else "[dim]none (shell env only)[/dim]",
        str(DOTENV_PATH),
    )
    paths.add_row(
        "events store",
        "[green]exists[/green]" if EVENTS_STORE_DIR.is_dir() else "[dim]not provisioned[/dim]",
        str(EVENTS_STORE_DIR),
    )
    console.print(paths)

    if IS_CHECKOUT:
        console.print(f"anchor   {_CHECKOUT_ANCHOR}  (main checkout {_MAIN_CHECKOUT_DIR})")

    if CONSUMER_CONFIG_ROOT is not None:
        console.print(
            f"consumer config: [green]{CONSUMER_CONFIG_ROOT / '.h' / 'config.toml'}[/green]"
        )
    else:
        console.print(
            "[dim]consumer config: none discovered (h-checkout defaults; a consumer repo "
            "declares its paths in <repo>/.h/config.toml)[/dim]"
        )


if __name__ == "__main__":  # pragma: no cover
    typer.run(doctor)
