"""Guard: the CLI's --agent registry stays in sync with the engine's run-* activities.

Catches the failure mode the hardening-audit found live (codex): a new agent whose run-*
activity takes the shared {task, cwd, model} input is added engine-side but NOT wired into
AGENT_IDENTITY / AGENT_URLS, so `h workflow run --agent X` / `h chain run --agent X` fail with
"unknown --agent" even though the runtime fully supports it.

Classification is automatic (no manual excluded list): an activity is "shared-input" iff its
run-*.activity.ts declares BOTH a `cwd` and a `model` field in its Input — the same criterion the
config.py comment states for AGENT_IDENTITY membership. Non-shared agents (dapr-agent, langgraph,
claude-managed, dapr-claude-loop — task-only input) are excluded by that test, not by a hardcoded
list, so a future shared-input agent can't silently drift out.
"""

import re
from pathlib import Path

import pytest

from h_cli.config import AGENT_IDENTITY, AGENT_URLS, agent_identity_params

# cli/h/tests/ → cli/h/ → cli/ → repo root
_REPO_ROOT = Path(__file__).parents[3]
_REGISTRY = _REPO_ROOT / "apps/workflow-svc/src/infrastructure/activity-registry.ts"
_ACTIVITIES = _REPO_ROOT / "apps/workflow-svc/src/infrastructure/activities"

_skip_no_ts = pytest.mark.skipif(
    not _REGISTRY.exists(), reason="TS engine sources absent — Python-only checkout"
)


def _run_activities() -> set[str]:
    """Every `run-*` activity name registered in the engine."""
    return set(re.findall(r'case\s+"(run-[a-z0-9-]+)"', _REGISTRY.read_text()))


def _is_shared_input(activity: str) -> bool:
    """True iff the activity's Input declares BOTH a cwd and a model field (the shared
    {task, cwd, model} runner contract). Missing file ⇒ not shared."""
    path = _ACTIVITIES / f"{activity}.activity.ts"
    if not path.exists():
        return False
    text = path.read_text()
    has_cwd = re.search(r"\bcwd\??\s*:", text) is not None
    has_model = re.search(r"\bmodel\??\s*:", text) is not None
    return has_cwd and has_model


@_skip_no_ts
def test_shared_input_activities_have_agent_identity() -> None:
    """Every shared-input run-* activity must be reachable via a --agent name whose runActivity
    matches. This is what makes `h ... --agent X` work; codex drifted out of it before this guard."""
    shared = {a for a in _run_activities() if _is_shared_input(a)}
    assert shared, "no shared-input run-* activities found — regex/paths likely broke"

    run_activities_in_identity = {run_activity for run_activity, _ in AGENT_IDENTITY.values()}
    missing = shared - run_activities_in_identity
    assert not missing, (
        f"shared-input run-* activities with no AGENT_IDENTITY entry: {sorted(missing)}. "
        "Add a --agent name → (runActivity, agentId) to AGENT_IDENTITY in cli/h/src/h_cli/config.py "
        "(and its agentId to AGENT_URLS), or, if it is not a shared-input agent, it should not "
        "declare both cwd and model in its Input."
    )


@_skip_no_ts
def test_no_identity_points_at_a_nonexistent_activity() -> None:
    """Every runActivity referenced by AGENT_IDENTITY must actually be registered in the engine."""
    registered = _run_activities()
    stray = {ra for ra, _ in AGENT_IDENTITY.values()} - registered
    assert not stray, f"AGENT_IDENTITY references unregistered run activities: {sorted(stray)}"


def test_every_identity_agentid_has_a_url() -> None:
    """Each agentId a --agent name expands to must have an AGENT_URLS entry, so submit-and-babysit
    can reach it. (Pure-Python — no TS sources needed.)"""
    for name, (_run_activity, agent_id) in AGENT_IDENTITY.items():
        assert agent_id in AGENT_URLS, (
            f"AGENT_IDENTITY[{name!r}] → agentId {agent_id!r} has no AGENT_URLS entry"
        )


def test_codex_agent_is_wired() -> None:
    """Regression pin for the specific drift this guard was created for."""
    assert agent_identity_params("codex") == {"runActivity": "run-codex", "agentId": "codex-agent"}
    assert AGENT_URLS["codex-agent"].endswith(":8016")
