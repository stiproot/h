"""h worktrees — list and remove the worktrees h cuts, on either substrate.

The sweep surface for both substrates: the LOCAL one lands worktrees under LOCAL_WORKTREES_DIR
with `local/*` branches, and the SERVICE one's agents cut theirs under `<workspace>/worktrees/`
with `feature/*` branches. Until this sub-app there was no removal path in the CLI or the
runtime, and a finalized chain still removes nothing — so both roots accumulate (a single merged
feature worktree was found holding 803MB). Like `h cron` / `h chain` /
`h watch`, it is a `list` + `rm` Typer sub-app registered in main.py — and `sweep`, the
batch form the `list`-then-remove preview makes natural.

Safety is the point, and it is graded rather than binary: `rm` and `sweep` refuse to remove a
worktree holding work, but uncommitted state comes in two classes that cost different amounts to
lose. Tracked modifications and unpushed commits need --force. Files git merely does not track —
SCRATCH, typically the plan doc an agent left behind — need only --prune-untracked, which lists
them before discarding them. Splitting the two is what makes the sweep usable on exactly the
worktrees it was built for: one stray scratch file used to mark a finished 803MB worktree dirty
and push the operator to the blunt instrument. Every git check still defaults to "unsafe" on any
error rather than auto-removing unknown state.
"""

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from h_cli.config import H_WORKSPACE_DIR, LOCAL_WORKTREES_DIR
from h_cli.infrastructure import git, local_runtime

app = typer.Typer(no_args_is_help=True, help="List and remove the worktrees h cuts.")
console = Console()
err_console = Console(stderr=True)


def _resolve_repo(cwd: Path) -> str:
    """The checkout worktrees are cut from; not a git repo is a loud refusal."""
    try:
        return local_runtime.repo_root(cwd)
    except local_runtime.LocalRunError as err:
        err_console.print(f"[red]worktrees:[/red] {err}")
        raise typer.Exit(1) from err


def _repo_for(repo_opt: Path | None) -> str:
    """The checkout to operate on: --repo when given, else the cwd's.

    `--repo` exists because worktree admin lives in the CLONE, so a command scoped to the cwd can
    only ever see one substrate's worktrees. Run from h's own checkout, `list` truthfully reported
    "none" while a merged 803MB feature worktree sat on disk under the h-workspace clone — the
    leak was real and simply unreachable from the obvious place to look.
    """
    return _resolve_repo(repo_opt.resolve() if repo_opt else Path.cwd())


def _managed_roots() -> list[Path]:
    """Every root h cuts worktrees into — both substrates.

    The LOCAL substrate uses `h-worktrees/` (branches `local/*`); the SERVICE substrate's agents
    cut theirs under the shared workspace (`<workspace>/worktrees/`, branches `feature/*`). Both
    are h-managed and both leak, so both are sweepable; a worktree anywhere else is somebody's own
    and is left strictly alone.
    """
    return [LOCAL_WORKTREES_DIR.resolve(), (H_WORKSPACE_DIR / "worktrees").resolve()]


def _local_entries(repo: str) -> list[git.WorktreeEntry]:
    """The h-managed worktrees: pruned, minus the main checkout, filtered by path.

    The filter is `is_relative_to`, never a bare string prefix — a startswith on
    `/h-worktrees` would falsely match `/h-worktrees-extra/foo`.

    BOTH sides are resolved first. `is_relative_to` is purely lexical, so a root carrying `..`
    or a symlink never matches the absolute paths git reports — which made this command a silent
    no-op in its default configuration. Config resolves the roots; this resolves the entries, so
    an operator-set H_LOCAL_WORKTREES_DIR or a symlinked checkout cannot reintroduce the bug.
    """
    git.worktree_prune(repo)
    entries = git.worktree_list(repo)
    roots = _managed_roots()
    return [e for e in entries[1:] if any(e.path.resolve().is_relative_to(r) for r in roots)]


def _match_entry(entries: list[git.WorktreeEntry], branch: str) -> git.WorktreeEntry | None:
    """Match by branch name, then by path — the path fallback lets a detached-HEAD
    worktree (whose branch_short is None) be targeted by its directory name."""
    for e in entries:
        if e.branch_short == branch or str(e.path) == branch or e.path.name == branch:
            return e
    return None


def _reasons(dirt: git.Dirt, unpushed: bool) -> str:
    parts = []
    if dirt.tracked:
        parts.append("uncommitted changes")
    if dirt.untracked:
        n = len(dirt.untracked)
        parts.append(f"{n} untracked file{'s' if n != 1 else ''}")
    if unpushed:
        parts.append("unpushed commits")
    return ", ".join(parts)


def _status_text(dirt: git.Dirt, unpushed: bool) -> str:
    parts = []
    if dirt.tracked:
        parts.append("[red]dirty[/red]")
    elif dirt.untracked:
        parts.append("[cyan]scratch[/cyan]")
    if unpushed:
        parts.append("[yellow]unpushed[/yellow]")
    return " + ".join(parts) if parts else "[green]clean[/green]"


def _blocked(dirt: git.Dirt, unpushed: bool, *, force: bool, prune_untracked: bool) -> str | None:
    """Why this worktree must not be removed, or None when it may be.

    The two flags accept DIFFERENT classes of loss, which is why they are two flags:
    `--prune-untracked` discards files nobody ever committed, `--force` additionally discards
    tracked edits and commits that exist nowhere else. Scratch is the only class the narrow flag
    unlocks — an unpushed worktree stays blocked whatever its untracked state.
    """
    if force:
        return None
    if dirt.tracked or unpushed:
        return _reasons(git.Dirt(tracked=dirt.tracked, untracked=[]), unpushed)
    if dirt.untracked and not prune_untracked:
        return _reasons(dirt, unpushed)
    return None


def _announce_discard(name: str, dirt: git.Dirt) -> None:
    """Name every untracked file about to be destroyed — the list IS the safety check.

    A leftover plan doc and a new source file nobody staged are indistinguishable to git, so the
    operator, not the tool, is the one who can tell them apart. Printing the paths before the
    removal is what makes `src/newthing.ts` stop somebody.
    """
    if not dirt.untracked:
        return
    n = len(dirt.untracked)
    err_console.print(
        f"[yellow]discarding[/yellow] {n} untracked file{'s' if n != 1 else ''} in '{name}':"
    )
    for path in dirt.untracked:
        err_console.print(f"    {path}")


@app.command("list")
def list_(
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Print machine-readable rows instead of the table."),
    ] = False,
    repo_path: Annotated[
        Path | None,
        typer.Option(
            "--repo",
            help="Checkout to operate on (default: the current directory's). Worktree admin "
            "lives in the clone, so this is how you reach another substrate's worktrees.",
        ),
    ] = None,
) -> None:
    """List h-managed worktrees (both substrates) and their status (dirty / scratch / unpushed)."""
    repo = _repo_for(repo_path)
    entries = _local_entries(repo)
    rows = []
    for e in entries:
        dirt = git.worktree_dirt(e.path)
        unpushed = git.worktree_has_unpushed(e.path)
        rows.append(
            {
                "branch": e.branch_short or "(detached)",
                "path": str(e.path),
                "dirty": dirt.tracked,
                "untracked": dirt.untracked,
                "unpushed": unpushed,
                "_status": _status_text(dirt, unpushed),
            }
        )
    if as_json:
        console.print_json(data=[{k: v for k, v in r.items() if k != "_status"} for r in rows])
        return
    if not rows:
        console.print("[dim]no h-managed worktrees found[/dim]")
        return
    table = Table("branch", "path", "status", title="h-managed worktrees", title_justify="left")
    for row in rows:
        table.add_row(row["branch"], row["path"], row["_status"])
    console.print(table)


@app.command("rm")
def rm(
    branch: str = typer.Argument(
        ..., help="Branch (or worktree path) of the h-managed worktree to remove."
    ),
    force: Annotated[
        bool,
        typer.Option("--force", help="Remove even with uncommitted/unpushed work (dangerous)."),
    ] = False,
    prune_untracked: Annotated[
        bool,
        typer.Option(
            "--prune-untracked",
            help="Also remove a worktree whose only dirt is untracked files, discarding them "
            "(they are listed first). Narrower than --force, which also discards tracked "
            "edits and unpushed commits.",
        ),
    ] = False,
    repo_path: Annotated[
        Path | None,
        typer.Option(
            "--repo",
            help="Checkout to operate on (default: the current directory's). Worktree admin "
            "lives in the clone, so this is how you reach another substrate's worktrees.",
        ),
    ] = None,
) -> None:
    """Remove one h-managed worktree and its branch."""
    repo = _repo_for(repo_path)
    entries = _local_entries(repo)
    entry = _match_entry(entries, branch)
    if entry is None:
        err_console.print(
            f"[bold red]no h-managed worktree[/bold red] '{branch}'. "
            "Run `h worktrees list` to see what is here."
        )
        raise typer.Exit(1)

    dirt = git.worktree_dirt(entry.path)
    unpushed = git.worktree_has_unpushed(entry.path)
    blocked = _blocked(dirt, unpushed, force=force, prune_untracked=prune_untracked)
    if blocked is not None:
        override = (
            "Use --prune-untracked to discard them (they are listed first)."
            if dirt.untracked_only
            else "Commit, push, or stash your work first. Use --force to override (dangerous)."
        )
        err_console.print(f"[bold red]refused:[/bold red] '{branch}' has {blocked}. {override}")
        raise typer.Exit(1)
    _announce_discard(branch, dirt)
    if dirt.tracked or unpushed:
        err_console.print(
            f"[yellow]warning:[/yellow] removing '{branch}' despite "
            f"{_reasons(git.Dirt(tracked=dirt.tracked, untracked=[]), unpushed)} — "
            "work may be lost."
        )

    try:
        # git refuses to remove a worktree holding untracked files without --force of its own,
        # so a --prune-untracked removal must still hand git the flag we withheld from the user.
        git.worktree_remove(repo, entry.path, force=force or dirt.any)
        if entry.branch_short is not None:
            git.branch_delete(repo, entry.branch_short)
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
    prune_untracked: Annotated[
        bool,
        typer.Option(
            "--prune-untracked",
            help="Also remove worktrees whose only dirt is untracked files, discarding them "
            "(they are listed first). The flag for reclaiming a finished agent worktree that "
            "one leftover scratch file is holding open.",
        ),
    ] = False,
    repo_path: Annotated[
        Path | None,
        typer.Option(
            "--repo",
            help="Checkout to operate on (default: the current directory's). Worktree admin "
            "lives in the clone, so this is how you reach another substrate's worktrees.",
        ),
    ] = None,
) -> None:
    """Remove clean h-managed worktrees; keep and report the ones holding work."""
    repo = _repo_for(repo_path)
    entries = _local_entries(repo)
    if not entries:
        console.print("[dim]no h-managed worktrees found[/dim]")
        return

    to_remove: list[tuple[git.WorktreeEntry, git.Dirt, bool]] = []
    to_skip: list[tuple[git.WorktreeEntry, str]] = []
    for e in entries:
        dirt = git.worktree_dirt(e.path)
        unpushed = git.worktree_has_unpushed(e.path)
        blocked = _blocked(dirt, unpushed, force=force, prune_untracked=prune_untracked)
        if blocked is not None:
            to_skip.append((e, blocked))
        else:
            to_remove.append((e, dirt, unpushed))

    if dry_run:
        for e, dirt, _ in to_remove:
            name = e.branch_short or e.path.name
            n = len(dirt.untracked)
            suffix = f" (discarding {n} untracked file{'s' if n != 1 else ''})" if n else ""
            console.print(f"would remove: {name}{suffix}")
            for path in dirt.untracked:
                console.print(f"[dim]    {path}[/dim]")
        for e, reasons in to_skip:
            console.print(f"[dim]would skip: {e.branch_short or e.path.name} ({reasons})[/dim]")
        return

    removed = 0
    errors = 0
    for e, dirt, unpushed in to_remove:
        name = e.branch_short or e.path.name
        _announce_discard(name, dirt)
        if dirt.tracked or unpushed:
            err_console.print(
                f"[yellow]warning:[/yellow] removing '{name}' despite "
                f"{_reasons(git.Dirt(tracked=dirt.tracked, untracked=[]), unpushed)} — "
                "work may be lost."
            )
        try:
            # See rm: git's own --force is required for a worktree holding untracked files.
            git.worktree_remove(repo, e.path, force=force or dirt.any)
            if e.branch_short is not None:
                git.branch_delete(repo, e.branch_short)
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
