"""Pure subprocess adapter for git worktree inspection and removal.

Style mirrors local_runtime.py's `repo_root()`: bare `subprocess.run(..., capture_output=True,
text=True, check=True)`; OSError/CalledProcessError become a GitError the command layer
renders loudly.
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitError(RuntimeError):
    """Raised when a git invocation fails; str(err) is user-presentable."""


@dataclass
class Dirt:
    """Uncommitted state in a worktree, split into the two classes that differ in cost."""

    tracked: bool  # modifications to files git tracks — losing them loses real edits
    untracked: list[str]  # files git neither tracks nor ignores — typically agent scratch

    @property
    def untracked_only(self) -> bool:
        """Nothing but scratch: the case a sweep can discard behind its own narrow flag."""
        return bool(self.untracked) and not self.tracked

    @property
    def any(self) -> bool:
        return self.tracked or bool(self.untracked)


@dataclass
class WorktreeEntry:
    path: Path
    head: str  # full SHA
    branch: str | None  # "refs/heads/local/..." or None (detached HEAD)

    @property
    def branch_short(self) -> str | None:
        """The branch without its `refs/heads/` prefix; None for a detached HEAD."""
        if self.branch is None:
            return None
        return self.branch.removeprefix("refs/heads/")


def _run(repo_path: Path, *args: str) -> str:
    """git -C <repo> <args…> with captured output; a failure raises GitError."""
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_path), *args],
            capture_output=True,
            text=True,
            check=True,
        )
    except OSError as err:
        raise GitError(str(err)) from err
    except subprocess.CalledProcessError as err:
        raise GitError(err.stderr.strip() or str(err)) from err
    return out.stdout


def is_repo(path: Path) -> bool:
    """True when `path` is inside a git working tree — the guard before anything is run there."""
    try:
        return _run(path, "rev-parse", "--is-inside-work-tree").strip() == "true"
    except GitError:
        return False


def worktree_ensure(
    repo_path: Path,
    worktree_path: Path,
    branch: str,
    base_ref: str = "main",
) -> Path:
    """Idempotently give `branch` a worktree at `worktree_path`, cut from `repo_path`.

    The Python sibling of the local runtime's `create-worktree`, for callers that provision a
    workspace BEFORE composing a job (the relay: an event-fired loop must land in a worktree of
    h's own clone, never in whatever directory the process happened to start in).

    Existing worktree → reused as-is, which is what makes a multi-step loop share one workspace.
    Fetches `origin/<base_ref>` first so a new branch starts at the remote tip, falling back to
    the local ref when there is no remote to reach.
    """
    if worktree_path.exists():
        return worktree_path
    start: str = base_ref
    try:
        _run(repo_path, "fetch", "origin", base_ref)
        start = f"origin/{base_ref}"
    except GitError:
        pass  # offline or no remote: branch from the local ref instead of failing the loop
    existing = _run(repo_path, "branch", "--list", branch).strip()
    args = (
        ["worktree", "add", str(worktree_path), branch]
        if existing
        else ["worktree", "add", "-b", branch, str(worktree_path), start]
    )
    _run(repo_path, *args)
    return worktree_path


def worktree_list(repo_path: Path) -> list[WorktreeEntry]:
    """All worktrees known to <repo>, main worktree first.

    Parses `git worktree list --porcelain`, a blank-line-separated stream of blocks. Each
    block starts with `worktree <abs-path>`, has `HEAD <sha>`, then either
    `branch refs/heads/<name>` or the literal word `detached`. Bare repositories emit a
    `worktree <abs-path>` + `bare` block with no HEAD — skipped.
    """
    stdout = _run(repo_path, "worktree", "list", "--porcelain")
    entries: list[WorktreeEntry] = []
    for block in stdout.split("\n\n"):
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines or not lines[0].startswith("worktree "):
            continue
        # A bare block has no HEAD entry; there is no worktree at that path.
        if "bare" in lines[1:]:
            continue
        head = ""
        branch: str | None = None
        for ln in lines[1:]:
            if ln.startswith("HEAD "):
                head = ln[len("HEAD ") :]
            elif ln.startswith("branch "):
                branch = ln[len("branch ") :]
            elif ln == "detached":
                branch = None
        if not head:
            continue
        entries.append(
            WorktreeEntry(
                path=Path(lines[0][len("worktree ") :]),
                head=head,
                branch=branch,
            )
        )
    return entries


def worktree_dirt(path: Path) -> Dirt:
    """What kind of uncommitted state a worktree holds, split by how bad losing it would be.

    `git status --porcelain` lumps two very different things together, and the sweep needs them
    apart: a `??` line is a file git neither tracks nor ignores (an agent's leftover scratch —
    ignored paths like `node_modules` never appear), while every other line is a modification to
    a file git DOES track. Losing the first class costs a file nobody ever committed; losing the
    second costs edits to real work. Unpushed COMMITS are a third question, answered separately
    by `worktree_has_unpushed`.

    Any error (path missing, git failing) reports tracked dirt — the safe default that never lets
    unknown state be auto-removed.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return Dirt(tracked=True, untracked=[])
    # These paths are for DISPLAY only — git quotes unusual ones, so never feed them to a command.
    tracked = False
    untracked: list[str] = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        if line.startswith("?? "):
            untracked.append(line[3:].strip())
        else:
            tracked = True
    return Dirt(tracked=tracked, untracked=untracked)


def worktree_has_unpushed(path: Path) -> bool:
    """True when HEAD has commits not reachable from any remote.

    A checkout with no remote configured shows every commit, so it reports True — correct,
    because local-only work is exactly the unsafe case. Any error → True (safe default).
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "log", "HEAD", "--not", "--remotes", "--oneline"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return True
    return bool(out.stdout.strip())


def worktree_remove(repo_path: Path, worktree_path: Path, *, force: bool = False) -> None:
    """git worktree remove [--force] <worktree_path>; a failure raises GitError."""
    cmd = ["worktree", "remove"]
    if force:
        cmd.append("--force")
    cmd.append(str(worktree_path))
    _run(repo_path, *cmd)


def branch_delete(repo_path: Path, branch: str) -> None:
    """git branch -D <branch> — always force-deletes.

    The caller is responsible for the data-safety check (worktree_has_unpushed); the
    git -d merge-check is redundant with that upstream gate and actively rejects branches
    that are pushed to a remote but whose PR is still open.
    """
    _run(repo_path, "branch", "-D", branch)


def worktree_prune(repo_path: Path) -> None:
    """Clear stale worktree admin entries before listing (git worktree prune)."""
    _run(repo_path, "worktree", "prune")
