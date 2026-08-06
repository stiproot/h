"""h worktrees — list and remove direct-substrate worktrees.

The sweep surface for `h delegate --worktree` and `--direct` runs of worktree-cutting
templates. Worktrees land under DIRECT_WORKTREES_DIR with `direct/*` branches; until this
sub-app there was no removal path in the CLI or the runtime. Like `h cron` / `h chain` /
`h watch`, it is a `list` + `rm` Typer sub-app registered in main.py — and `sweep`, the
batch form the `list`-then-remove preview makes natural.

Safety is the point: `rm` and `sweep` refuse to remove a worktree with uncommitted
changes or unpushed commits unless --force says otherwise, and every git check defaults to
"unsafe" on any error rather than auto-removing unknown state.
"""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from h_cli.config import DIRECT_WORKTREES_DIR
from h_cli.infrastructure import direct, git

app = typer.Typer(no_args_is_help=True, help="List and remove direct-substrate worktrees.")
console = Console()
err_console = Console(stderr=True)


def _resolve_repo(cwd: Path) -> str:
    """The checkout worktrees are cut from; not a git repo is a loud refusal."""
    try:
        return direct.repo_root(cwd)
    except direct.DirectRunError as err:
        err_console.print(f"[red]worktrees:[/red] {err}")
        raise typer.Exit(1) from err


def _direct_entries(repo: str) -> list[git.WorktreeEntry]:
    """The direct-substrate worktrees: pruned, minus the main checkout, filtered by path.

    The filter is `is_relative_to`, never a bare string prefix — a startswith on
    `/h-worktrees` would falsely match `/h-worktrees-extra/foo`.
    """
    git.worktree_prune(repo)
    entries = git.worktree_list(repo)
    return [e for e in entries[1:] if e.path.is_relative_to(DIRECT_WORKTREES_DIR)]


def _match_entry(entries: list[git.WorktreeEntry], branch: str) -> git.WorktreeEntry | None:
    """Match by branch name, then by path — the path fallback lets a detached-HEAD
    worktree (whose branch_short is None) be targeted by its directory name."""
    for e in entries:
        if e.branch_short == branch or str(e.path) == branch or e.path.name == branch:
            return e
    return None


def _reasons(dirty: bool, unpushed: bool) -> str:
    parts = []
    if dirty:
        parts.append("uncommitted changes")
    if unpushed:
        parts.append("unpushed commits")
    return ", ".join(parts)


def _status_text(dirty: bool, unpushed: bool) -> str:
    if dirty and unpushed:
        return "[bold red]dirty + unpushed[/bold red]"
    if dirty:
        return "[red]dirty[/red]"
    if unpushed:
        return "[yellow]unpushed[/yellow]"
    return "[green]clean[/green]"


@app.command("list")
def list_(
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Print machine-readable rows instead of the table."),
    ] = False,
) -> None:
    """List direct-substrate worktrees and their safety status (dirty / unpushed)."""
    repo = _resolve_repo(Path.cwd())
    entries = _direct_entries(repo)
    rows = []
    for e in entries:
        dirty = git.worktree_is_dirty(e.path)
        unpushed = git.worktree_has_unpushed(e.path)
        rows.append(
            {
                "branch": e.branch_short or "(detached)",
                "path": str(e.path),
                "dirty": dirty,
                "unpushed": unpushed,
            }
        )
    if as_json:
        console.print_json(data=rows)
        return
    if not rows:
        console.print("[dim]no direct-substrate worktrees found[/dim]")
        return
    table = Table("branch", "path", "status", title="direct worktrees", title_justify="left")
    for row in rows:
        table.add_row(row["branch"], row["path"], _status_text(row["dirty"], row["unpushed"]))
    console.print(table)


@app.command("rm")
def rm(
    branch: str = typer.Argument(
        ..., help="Branch (or worktree path) of the direct-substrate worktree to remove."
    ),
    force: Annotated[
        bool,
        typer.Option("--force", help="Remove even with uncommitted/unpushed work (dangerous)."),
    ] = False,
) -> None:
    """Remove one direct-substrate worktree and its branch."""
    repo = _resolve_repo(Path.cwd())
    entries = _direct_entries(repo)
    entry = _match_entry(entries, branch)
    if entry is None:
        err_console.print(
            f"[bold red]no direct-substrate worktree[/bold red] '{branch}'. "
            "Run `h worktrees list` to see what is here."
        )
        raise typer.Exit(1)

    dirty = git.worktree_is_dirty(entry.path)
    unpushed = git.worktree_has_unpushed(entry.path)
    if (dirty or unpushed) and not force:
        err_console.print(
            f"[bold red]refused:[/bold red] '{branch}' has {_reasons(dirty, unpushed)}. "
            "Commit, push, or stash your work first. Use --force to override (dangerous)."
        )
        raise typer.Exit(1)
    if dirty or unpushed:
        err_console.print(
            f"[yellow]warning:[/yellow] removing '{branch}' despite {_reasons(dirty, unpushed)} "
            "— work may be lost."
        )

    try:
        git.worktree_remove(repo, entry.path, force=force)
        if entry.branch_short is not None:
            git.branch_delete(repo, entry.branch_short, force=force)
    except git.GitError as err:
        err_console.print(f"[red]error:[/red] {err}")
        raise typer.Exit(1) from err
    console.print(f"removed worktree '{branch}'")


@app.command("sweep")
def sweep(
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Show what would be removed or kept; make no changes."),
    ] = False,
    force: Annotated[
        bool,
        typer.Option("--force", help="Also remove dirty/unpushed worktrees (dangerous)."),
    ] = False,
) -> None:
    """Remove all clean direct-substrate worktrees; keep and report in-progress ones."""
    repo = _resolve_repo(Path.cwd())
    entries = _direct_entries(repo)
    if not entries:
        console.print("[dim]no direct-substrate worktrees found[/dim]")
        return

    to_remove: list[tuple[git.WorktreeEntry, bool, bool]] = []
    to_skip: list[tuple[git.WorktreeEntry, str]] = []
    for e in entries:
        dirty = git.worktree_is_dirty(e.path)
        unpushed = git.worktree_has_unpushed(e.path)
        if (dirty or unpushed) and not force:
            to_skip.append((e, _reasons(dirty, unpushed)))
        else:
            to_remove.append((e, dirty, unpushed))

    if dry_run:
        for e, _, _ in to_remove:
            console.print(f"would remove: {e.branch_short or e.path.name}")
        for e, reasons in to_skip:
            console.print(f"[dim]would skip: {e.branch_short or e.path.name} ({reasons})[/dim]")
        return

    removed = 0
    errors = 0
    for e, dirty, unpushed in to_remove:
        if dirty or unpushed:
            err_console.print(
                f"[yellow]warning:[/yellow] removing '{e.branch_short or e.path.name}' "
                f"despite {_reasons(dirty, unpushed)} — work may be lost."
            )
        try:
            git.worktree_remove(repo, e.path, force=force)
            if e.branch_short is not None:
                git.branch_delete(repo, e.branch_short, force=force)
            removed += 1
        except git.GitError as err:
            err_console.print(f"[red]error:[/red] {e.branch_short or e.path.name}: {err}")
            errors += 1

    for e, reasons in to_skip:
        console.print(f"[dim]skipped: {e.branch_short or e.path.name} ({reasons})[/dim]")

    summary = f"removed {removed}, skipped {len(to_skip)}"
    if errors:
        summary += f", {errors} failed"
    console.print(summary)
    if errors:
        raise typer.Exit(1)
