"""h workspaces — clone-level admin for the shared workspace root, the sibling of
`h worktrees`' worktree admin.

One command so far: `trust` — stamp Claude Code's per-project workspace trust for an
h-managed checkout. The claude CLI ignores a repo's `permissions.allow` entries until its
path is trusted, and h's clones are never opened interactively, so the dialog that grants
trust never appears there. Under the local substrate's `--dangerously-skip-permissions`
runs the ignored entries are INERT (bypass never prompts), so nothing is broken — this
command exists for the operator who wants the warning gone and the allow-lists in effect,
as an explicit act rather than something h does to `~/.claude.json` on its own.
"""

import json
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from h_cli.infrastructure.local_runtime import repo_root
from h_cli.infrastructure.workspace import ExternalWorkspaceError, assert_managed

app = typer.Typer(no_args_is_help=True, help="Workspace clones: trust.")
console = Console()
err_console = Console(stderr=True)

CLAUDE_CONFIG = Path.home() / ".claude.json"


def stamp_trust(config_path: Path, project_path: Path) -> bool:
    """Set `projects[<path>].hasTrustDialogAccepted: true` in the claude CLI's config.

    Read-modify-write that touches ONLY that key — the file is the claude CLI's own state
    and everything else in it must survive byte-for-byte in value terms. Returns False when
    the entry was already trusted (idempotent). A missing file is created with just this
    entry; the claude CLI fills its own defaults on next run.
    """
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    projects = config.setdefault("projects", {})
    entry = projects.setdefault(str(project_path), {})
    if entry.get("hasTrustDialogAccepted") is True:
        return False
    entry["hasTrustDialogAccepted"] = True
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    return True


@app.command()
def trust(
    path: Annotated[
        Path | None,
        typer.Argument(
            help="An h-managed checkout (a workspace clone or an h worktree); "
            "default: the cwd's repository root.",
        ),
    ] = None,
) -> None:
    """Trust an h-managed checkout for Claude Code (its permissions.allow takes effect).

    Deliberately scoped to the managed workspace boundary: h vouches only for checkouts it
    owns, and only when the operator asks. An external repo is trusted the normal way —
    run claude there interactively and accept the dialog.
    """
    target = Path(path) if path is not None else Path(repo_root(Path.cwd()))
    try:
        resolved = assert_managed(target, flag="path")
    except ExternalWorkspaceError as err:
        err_console.print(f"[red]{err}[/red]")
        raise typer.Exit(1) from err
    if not resolved.is_dir():
        err_console.print(f"[red]not a directory:[/red] {resolved}")
        raise typer.Exit(1)
    if stamp_trust(CLAUDE_CONFIG, resolved):
        console.print(f"[green]trusted[/green] {resolved} — permissions.allow now applies here")
    else:
        console.print(f"already trusted: {resolved}")
