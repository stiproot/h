"""Workspace path containment for LLM-invoked tools.

The agent tools (`write_file`, `read_skill`, …) take a path argument that comes from the MODEL,
not from us. Resolving it the obvious way does not keep it inside the workspace, because
``Path.__truediv__`` lets an absolute right-hand side replace the left entirely::

    Path("/workspace/agent") / "notes.md"      -> /workspace/agent/notes.md
    Path("/workspace/agent") / "/etc/passwd"   -> /etc/passwd            # escaped
    Path("/workspace/agent") / "../../etc/x"   -> /workspace/agent/../../etc/x

So `cwd / path` alone is not containment — it is a suggestion the model can decline. The repo
already knows the discipline: langgraph-agent's ``PresetStore._path`` rejects ``/``, ``\\`` and
``..`` in keys for exactly this reason. These helpers put that discipline where every agent's
tools can share it, since the tool implementations are deliberately duplicated across thin apps.

Both helpers FAIL LOUD (``ValueError``) rather than silently clamping into the workspace: a tool
call that tried to leave is a fact the caller should see, not one to paper over.
"""

from pathlib import Path

__all__ = ["contained_path", "safe_name"]


def contained_path(cwd: Path | str, path: str) -> Path:
    """Resolve ``path`` under ``cwd`` and prove it stayed inside.

    Returns the resolved absolute path. Raises ``ValueError`` when the result would land outside
    ``cwd`` — whether by an absolute path, ``..`` segments, or a symlink pointing out (``resolve()``
    follows links, so the check sees where the write would REALLY go, not where it appears to).

    ``cwd`` itself is resolved first so a symlinked workspace root does not make every legitimate
    path look like an escape.
    """
    root = Path(cwd).resolve()
    target = (root / path).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"path escapes the workspace: {path!r}")
    return target


def safe_name(name: str, *, kind: str = "name") -> str:
    """Return ``name`` if it is a single path segment, else raise ``ValueError``.

    For arguments interpolated INTO a path rather than resolved against it (a skill name, a preset
    key). Mirrors ``PresetStore._path``: no separators, no ``..``, not empty — so the caller can
    build a path around it without the segment steering the result elsewhere.
    """
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"invalid {kind}: {name!r}")
    return name
