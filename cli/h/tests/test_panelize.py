"""panelize()'s contract: pure transform, shape + errors.

The transform is the single author of panel-branch prose, so these tests are also the spec of
the sync steering (the concurrency preamble) and of the seam invariant: the synthesis carries
the ORIGINAL contract under the ORIGINAL step id, so the workflow's output signature is
unchanged by panelization.
"""

import pytest

from h_cli.infrastructure.panelize import (
    JUDGE_ACTIVITY,
    PanelizeError,
    panelize,
    roster_pairs,
)

ROSTER = [("claude", "run-claude"), ("codex", "run-codex"), ("openhands", "run-openhands")]

CONTRACT = {
    "type": "object",
    "required": ["verdict"],
    "properties": {"verdict": {"enum": ["CLEAN", "FINDINGS"]}},
}


def definition(**overrides):
    base = {
        "params": {"repo": "o/r", "slug": ""},
        "steps": [
            {"id": "setup", "activity": "setup", "input": {"agentId": "claude-agent"}},
            {
                "id": "review",
                "activity": "run-claude",
                "input": {
                    "outputContract": CONTRACT,
                    "model": "opus",
                    "task": "Review PR {{params.pr}}.\n===OUTPUT CONTRACT===\nEnd with json.",
                },
            },
        ],
        "outputs": CONTRACT,
    }
    base.update(overrides)
    return base


def test_replaces_contract_step_with_panel_group_and_synthesis() -> None:
    result = panelize(definition(), ROSTER)
    ids = [step["id"] for step in result["steps"]]
    assert ids == ["setup", "panel", "review"]
    panel = result["steps"][1]
    assert [b["id"] for b in panel["parallel"]] == ["claude", "codex", "openhands"]
    assert [b["activity"] for b in panel["parallel"]] == [
        "run-claude", "run-codex", "run-openhands",
    ]  # fmt: skip


def test_branches_strip_contract_and_model_and_carry_the_preamble() -> None:
    result = panelize(definition(), ROSTER)
    for branch in result["steps"][1]["parallel"]:
        assert "outputContract" not in branch["input"]
        assert "model" not in branch["input"]
        assert branch["input"]["task"].startswith("You are one of 3 agents")
        assert "READ-ONLY" in branch["input"]["task"]
        assert "Review PR {{params.pr}}." in branch["input"]["task"]


# Attribution is per-BRANCH: several panelists post to the same PR, and an unprefixed review is
# indistinguishable from its neighbours' and from a single-agent run's.
def test_each_branch_is_told_to_attribute_what_it_posts_to_itself() -> None:
    result = panelize(definition(), ROSTER)
    branches = result["steps"][1]["parallel"]
    prefixes = set()
    for branch in branches:
        task = branch["input"]["task"]
        assert f"[panel:{branch['id']}]" in task
        assert f"the '{branch['id']}' panelist" in task
        prefixes.add(f"[panel:{branch['id']}]")
    # Distinct per branch — one shared preamble for the whole panel would defeat the purpose.
    assert len(prefixes) == len(branches)


def test_synthesis_keeps_original_id_contract_and_judge() -> None:
    result = panelize(definition(), ROSTER)
    synthesis = result["steps"][2]
    assert synthesis["id"] == "review"
    assert synthesis["activity"] == JUDGE_ACTIVITY
    assert synthesis["input"]["outputContract"] == CONTRACT
    task = synthesis["input"]["task"]
    assert "{{claude.output}}" in task and "{{openhands.output}}" in task
    assert "===OUTPUT CONTRACT===" in task
    # The quoted original task is stripped of ITS epilogue — one authoritative contract block
    # (plus its ===TASK=== quote) only.
    assert task.count("End with json.") == 0


def test_panel_synthesis_guidance_is_spliced_in() -> None:
    result = panelize(definition(panelSynthesis="Verdict rule: unanimity."), ROSTER)
    assert "Verdict rule: unanimity." in result["steps"][2]["input"]["task"]


def test_input_definition_is_not_mutated() -> None:
    original = definition()
    snapshot = repr(original)
    panelize(original, ROSTER)
    assert repr(original) == snapshot


def test_non_contract_steps_and_toplevel_keys_are_preserved() -> None:
    result = panelize(definition(), ROSTER)
    assert result["steps"][0]["id"] == "setup"
    assert result["outputs"] == CONTRACT
    assert result["params"] == {"repo": "o/r", "slug": ""}


@pytest.mark.parametrize(
    ("mutate", "fragment"),
    [
        (lambda d: d["steps"].pop(1), "exactly ONE step carrying"),
        (
            lambda d: d["steps"].append(
                {"id": "second", "activity": "run-claude", "input": {"outputContract": CONTRACT}}
            ),
            "exactly ONE step carrying",
        ),
        (lambda d: d["steps"][1]["input"].pop("task"), "no task prose"),
        (
            lambda d: d["steps"].insert(0, {"id": "claude", "activity": "setup", "input": {}}),
            "collide with an existing step id",
        ),
    ],
)
def test_shape_violations(mutate, fragment) -> None:
    subject = definition()
    mutate(subject)
    with pytest.raises(PanelizeError, match=fragment):
        panelize(subject, ROSTER)


def test_roster_of_one_and_duplicate_roster_are_rejected() -> None:
    with pytest.raises(PanelizeError, match="at least two"):
        panelize(definition(), ROSTER[:1])
    with pytest.raises(PanelizeError, match="duplicate roster agent"):
        # claude and claude-agent normalize to the same branch id — the same executor twice.
        panelize(definition(), [("claude", "run-claude"), ("claude-agent", "run-claude")])


def test_roster_pairs_resolves_and_rejects_unknown_names() -> None:
    identity = {"claude": ("run-claude", "claude-agent"), "codex": ("run-codex", "codex-agent")}
    assert roster_pairs(("claude", "codex"), identity) == [
        ("claude", "run-claude"),
        ("codex", "run-codex"),
    ]
    with pytest.raises(PanelizeError, match="unknown agent 'hal9000'"):
        roster_pairs(("claude", "hal9000"), identity)


def test_model_override_applied_to_branches() -> None:
    """When model_override is set, it appears in every branch input instead of being stripped."""
    result = panelize(definition(), ROSTER, model_override="claude-sonnet-4-6")
    for branch in result["steps"][1]["parallel"]:
        assert branch["input"]["model"] == "claude-sonnet-4-6"


def test_model_override_empty_is_absent() -> None:
    """An empty-string model_override is treated as absent — model is stripped from branches."""
    result = panelize(definition(), ROSTER, model_override="")
    for branch in result["steps"][1]["parallel"]:
        assert "model" not in branch["input"]
