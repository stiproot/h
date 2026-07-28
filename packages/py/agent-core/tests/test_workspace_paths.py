"""The containment guard only earns its place if it actually refuses an escape.

Each case here is a way a MODEL-supplied path leaves the workspace — the argument to these tools
is model-controlled, so every one is reachable from a tool call.
"""

import pytest

from agent_core.workspace_paths import contained_path, safe_name


def test_relative_path_inside_the_workspace_is_allowed(tmp_path):
    assert contained_path(tmp_path, "notes.md") == (tmp_path / "notes.md").resolve()
    nested = contained_path(tmp_path, "a/b/c.txt")
    assert nested == (tmp_path / "a/b/c.txt").resolve()


def test_the_workspace_root_itself_is_allowed(tmp_path):
    assert contained_path(tmp_path, ".") == tmp_path.resolve()


def test_absolute_path_is_rejected(tmp_path):
    # The trap: Path("/w") / "/etc/passwd" == Path("/etc/passwd") — the left side vanishes.
    with pytest.raises(ValueError, match="escapes the workspace"):
        contained_path(tmp_path, "/etc/passwd")


def test_parent_traversal_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="escapes the workspace"):
        contained_path(tmp_path, "../outside.txt")
    with pytest.raises(ValueError, match="escapes the workspace"):
        contained_path(tmp_path, "a/../../outside.txt")


def test_traversal_that_returns_inside_is_allowed(tmp_path):
    """`a/../b` never leaves — containment is about the RESOLVED destination, not the spelling."""
    assert contained_path(tmp_path, "a/../b.txt") == (tmp_path / "b.txt").resolve()


def test_symlink_pointing_out_of_the_workspace_is_rejected(tmp_path):
    """resolve() follows links, so the check sees where a write would REALLY land."""
    outside = tmp_path.parent / "outside-target"
    outside.mkdir(exist_ok=True)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="escapes the workspace"):
        contained_path(workspace, "escape/pwned.txt")


def test_symlinked_workspace_root_does_not_break_legitimate_paths(tmp_path):
    """cwd is resolved too — else a symlinked workspace makes every path look like an escape."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    assert contained_path(link, "notes.md") == (real / "notes.md").resolve()


@pytest.mark.parametrize("bad", ["", "a/b", "a\\b", "..", "../x"])
def test_safe_name_rejects_anything_that_is_not_one_segment(bad):
    with pytest.raises(ValueError, match="invalid"):
        safe_name(bad, kind="skill name")


def test_safe_name_passes_a_plain_segment():
    assert safe_name("linear") == "linear"
