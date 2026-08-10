"""The local substrate's work-target boundary: h works in its OWN clones, not the operator's.

The guard exists because of a live incident (2026-08-10): a local agent ended up in the
operator's working checkout of the target repo and committed into it. Two halves failed — the
agent wandered (fixed by the relay's worktree pin) and the operator aimed wrong (this).
"""

from pathlib import Path

import pytest

from h_cli.config import H_WORKSPACE_DIR, LOCAL_WORKTREES_DIR
from h_cli.infrastructure import workspace


def test_h_s_own_clones_are_allowed() -> None:
    """`h-workspace/<repo>` is where h clones the repos it works on — the normal path."""
    assert workspace.assert_managed(H_WORKSPACE_DIR / "trxy-v2") == H_WORKSPACE_DIR / "trxy-v2"


def test_worktrees_cut_from_those_clones_are_allowed() -> None:
    """A worktree is h-managed too — a follow-up delegate targets one directly."""
    target = LOCAL_WORKTREES_DIR / "local-some-task"
    assert workspace.assert_managed(target) == target


def test_h_s_own_repo_is_allowed() -> None:
    """h building h: the self case must not need an override flag."""
    here = Path(__file__).resolve().parents[3]
    assert workspace.assert_managed(here) == here


def test_an_operator_checkout_elsewhere_is_refused_by_name() -> None:
    """The live failure: a second clone of the target repo, outside anything h manages."""
    with pytest.raises(workspace.ExternalWorkspaceError) as caught:
        workspace.assert_managed(Path("/home/someone/code/trxy/trxy-v2"))
    message = str(caught.value)
    # The refusal has to teach, not just deny: where to work, why, and the way through.
    assert str(H_WORKSPACE_DIR) in message
    assert "--allow-external" in message
    assert "runs as YOU" in message


def test_the_override_is_explicit_and_works() -> None:
    """Deliberate external work stays possible — it just cannot happen by accident."""
    external = Path("/home/someone/code/trxy/trxy-v2")
    assert workspace.assert_managed(external, allow_external=True) == external


def test_a_sibling_of_a_managed_root_is_not_managed() -> None:
    """Prefix similarity is not containment: `h-workspace-scratch` is somebody else's directory."""
    with pytest.raises(workspace.ExternalWorkspaceError):
        workspace.assert_managed(Path(f"{H_WORKSPACE_DIR}-scratch"))
