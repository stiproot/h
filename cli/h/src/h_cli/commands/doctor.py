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

from h_cli.config import (
    _REPO_DIR,
    CONSUMER_CONFIG_ROOT,
    DOTENV_PATH,
    EVENTS_STORE_DIR,
    H_WORKSPACE_DIR,
    LOCAL_BIN,
    LOCAL_BIN_BUILDABLE,
    LOCAL_WORKTREES_DIR,
    charts_roots,
)

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


def doctor() -> None:
    """Report the local-substrate toolchain: binaries, the built runner, charts, and which
    consumer config (.h/config.toml) is in effect. Informational — nothing is installed."""
    tools = Table("tool", "status", "detail", title="tools")
    for name, purpose in _REQUIRED:
        tools.add_row(*_tool_row(name, f"REQUIRED — {purpose}"))
    agent_rows = [_tool_row(name, "agent CLI") for name in _AGENT_CLIS]
    for row in agent_rows:
        tools.add_row(*row)
    for name, purpose in _OPTIONAL:
        tools.add_row(*_tool_row(name, f"optional — {purpose}"))
    console.print(tools)
    if not any("ok" in status for _, status, _ in agent_rows):
        console.print(
            "[yellow]no agent CLI on PATH[/yellow] — a --local run needs at least one of: "
            + ", ".join(_AGENT_CLIS)
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
