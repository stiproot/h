"""Which checkouts the LOCAL substrate is allowed to work in.

A local run is the operator: their shell, their credentials, their filesystem, no sandbox. The
only thing standing between "run an agent here" and "run an agent in the checkout I am mid-feature
in" is the path someone passed. So the path is checked.

The rule mirrors the service substrate rather than inventing a local one. There, agents have
always worked inside the shared workspace root (`h-workspace`) — cloning into it and cutting
worktrees off that clone — because a container has no other checkout to reach for. Locally there
are many, so the same root becomes a deliberate boundary: h works on ITS clones
(`h-workspace/<repo>`) and the worktrees it cuts from them (`h-worktrees/`), plus its own repo for
the self-building case. Anything else is the operator's, and is refused by name unless they say
otherwise.

(Bit us live 2026-08-10: an agent whose workspace contradicted its task went looking for the right
repo and found the operator's working clone, then branched and committed into it. The relay's
worktree pin stops the AGENT wandering; this stops the OPERATOR aiming wrong, which is the half
that failure actually started with.)
"""

from pathlib import Path

from h_cli.config import _REPO_DIR, H_WORKSPACE_DIR, IS_CHECKOUT, LOCAL_WORKTREES_DIR


class ExternalWorkspaceError(RuntimeError):
    """A work target outside the roots h manages, refused with the reason and the way through."""


def managed_roots() -> tuple[Path, ...]:
    """The roots a local run may work in: h's clones, the worktrees cut from them, and — in
    checkout mode only — h's own repo. A packaged (wheel) install has no checkout, so its
    third root would be site-packages nonsense; it simply isn't one."""
    if IS_CHECKOUT:
        return (H_WORKSPACE_DIR, LOCAL_WORKTREES_DIR, _REPO_DIR.resolve())
    return (H_WORKSPACE_DIR, LOCAL_WORKTREES_DIR)


def assert_managed(path: Path, *, allow_external: bool = False, flag: str = "--cwd") -> Path:
    """Return `path` resolved, or raise when it is not somewhere h manages.

    `allow_external` is the operator's explicit override — deliberately a flag they have to type,
    not a config they can forget they set.
    """
    resolved = path.resolve()
    if allow_external:
        return resolved
    roots = managed_roots()
    if any(resolved == root or resolved.is_relative_to(root) for root in roots):
        return resolved
    raise ExternalWorkspaceError(
        f"{flag} {resolved} is outside the workspace h manages.\n"
        f"  h works in its own clones ({H_WORKSPACE_DIR}/<repo>), the worktrees it cuts from them "
        f"({LOCAL_WORKTREES_DIR}), and its own repo.\n"
        "  A local agent runs as YOU, with your credentials and no sandbox — pointing it at "
        "another checkout risks the work in it.\n"
        f"  Clone the target under {H_WORKSPACE_DIR} and work there, or pass --allow-external if "
        "this really is what you want."
    )
