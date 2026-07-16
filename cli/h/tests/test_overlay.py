"""The overlay operator: merge-by-step-id with task-prose extension (no helm, no network)."""

import pytest

from h_cli.infrastructure.overlay import overlay


def test_new_step_ids_append_in_first_seen_order() -> None:
    base = {"instanceId": "x", "steps": [{"id": "a", "activity": "run-openhands"}]}
    layer = {"steps": [{"id": "b", "activity": "run-openhands"}]}
    merged = overlay(base, layer)
    assert [s["id"] for s in merged["steps"]] == ["a", "b"]
    assert merged["instanceId"] == "x"


def test_existing_step_id_extends_task_prose() -> None:
    base = {"steps": [{"id": "implement", "input": {"task": "do the work"}}]}
    create_pr = {"steps": [{"id": "implement", "input": {"task": "then open a PR"}}]}
    merged = overlay(base, create_pr)
    assert len(merged["steps"]) == 1  # no extra step — create-pr extended implement
    assert merged["steps"][0]["input"]["task"] == "do the work\nthen open a PR"


def test_non_task_input_fields_are_later_wins() -> None:
    base = {"steps": [{"id": "impl", "input": {"model": "deepseek-v4-flash", "cwd": "{{w}}"}}]}
    layer = {"steps": [{"id": "impl", "input": {"model": "deepseek-v4-pro"}}]}
    merged = overlay(base, layer)
    assert merged["steps"][0]["input"]["model"] == "deepseek-v4-pro"  # overridden
    assert merged["steps"][0]["input"]["cwd"] == "{{w}}"  # preserved


def test_setup_lists_concatenate_base_first() -> None:
    # A setup-contributing atom (e.g. a plugins-install fragment) EXTENDS the base step's setup
    # command list instead of clobbering it — the list sibling of the task-prose append.
    base = {
        "steps": [{"id": "setup", "input": {"setup": ["cp -r $H_SKILLS_DIR/. ~/.claude/skills"]}}]
    }
    layer = {
        "steps": [
            {
                "id": "setup",
                "input": {"setup": ["claude plugin install foo", "claude plugin install bar"]},
            }
        ]
    }
    merged = overlay(base, layer)
    assert merged["steps"][0]["input"]["setup"] == [
        "cp -r $H_SKILLS_DIR/. ~/.claude/skills",
        "claude plugin install foo",
        "claude plugin install bar",
    ]


def test_setup_on_one_side_only_is_unchanged() -> None:
    base_only = overlay(
        {"steps": [{"id": "s", "input": {"setup": ["a"]}}]},
        {"steps": [{"id": "s", "input": {"task": "t"}}]},
    )
    assert base_only["steps"][0]["input"]["setup"] == ["a"]
    layer_only = overlay(
        {"steps": [{"id": "s", "input": {"task": "t"}}]},
        {"steps": [{"id": "s", "input": {"setup": ["b"]}}]},
    )
    assert layer_only["steps"][0]["input"]["setup"] == ["b"]


def test_non_list_setup_values_keep_later_wins() -> None:
    # Only list⊕list concatenates; any non-list side falls back to plain later-wins.
    merged = overlay(
        {"steps": [{"id": "s", "input": {"setup": ["a"]}}]},
        {"steps": [{"id": "s", "input": {"setup": "echo scalar"}}]},
    )
    assert merged["steps"][0]["input"]["setup"] == "echo scalar"
    merged = overlay(
        {"steps": [{"id": "s", "input": {"setup": "echo scalar"}}]},
        {"steps": [{"id": "s", "input": {"setup": ["b"]}}]},
    )
    assert merged["steps"][0]["input"]["setup"] == ["b"]


def test_concatenated_setup_is_deep_copied_not_aliased() -> None:
    base = {"steps": [{"id": "s", "input": {"setup": [{"cmd": "base"}]}}]}
    layer = {"steps": [{"id": "s", "input": {"setup": [{"cmd": "layer"}]}}]}
    merged = overlay(base, layer)
    merged["steps"][0]["input"]["setup"][0]["cmd"] = "mutated-base"
    merged["steps"][0]["input"]["setup"][1]["cmd"] = "mutated-layer"
    merged["steps"][0]["input"]["setup"].append({"cmd": "extra"})
    assert base["steps"][0]["input"]["setup"] == [{"cmd": "base"}]  # sources untouched
    assert layer["steps"][0]["input"]["setup"] == [{"cmd": "layer"}]


def test_top_level_keys_are_later_wins() -> None:
    merged = overlay({"instanceId": "a", "steps": []}, {"instanceId": "b", "steps": []})
    assert merged["instanceId"] == "b"


def test_three_way_overlay_left_to_right() -> None:
    a = {"steps": [{"id": "s", "input": {"task": "one"}}]}
    b = {"steps": [{"id": "s", "input": {"task": "two"}}]}
    c = {"steps": [{"id": "s", "input": {"task": "three"}}]}
    assert overlay(a, b, c)["steps"][0]["input"]["task"] == "one\ntwo\nthree"


def test_inputs_are_deep_copied_not_aliased() -> None:
    base = {"steps": [{"id": "s", "input": {"task": "base"}}]}
    merged = overlay(base)
    merged["steps"][0]["input"]["task"] = "mutated"
    assert base["steps"][0]["input"]["task"] == "base"  # source untouched


def test_step_without_id_is_rejected() -> None:
    with pytest.raises(ValueError, match="every step needs an `id`"):
        overlay({"steps": [{"activity": "run-openhands"}]})


def test_no_definitions_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one definition"):
        overlay()


def test_params_merge_key_wise_not_clobbered() -> None:
    # Each atom contributes its stored param DEFAULTS (fire-time identity, §1.9 of the
    # chain-composition-surface plan); a later atom's block must union in, not replace.
    a = {"params": {"runActivity": "run-claude", "agentId": "claude-agent"}, "steps": [{"id": "s"}]}
    b = {"params": {"modelReview": "opus", "agentId": "openhands-agent"}, "steps": [{"id": "s"}]}
    merged = overlay(a, b)
    assert merged["params"] == {
        "runActivity": "run-claude",
        "agentId": "openhands-agent",  # later wins per key
        "modelReview": "opus",
    }
    assert a["params"]["agentId"] == "claude-agent"  # source untouched


def test_single_outputs_declaration_flows_through() -> None:
    # The declared output schema (structured-workflow-outputs plan) is a top-level key like any
    # other: the one declaring atom's schema lands on the composed definition.
    contract = {"type": "object", "required": ["pr"], "properties": {"pr": {"type": "integer"}}}
    a = {"steps": [{"id": "implement", "input": {"task": "do it"}}]}
    b = {"outputs": contract, "steps": [{"id": "implement", "input": {"task": "open the PR"}}]}
    assert overlay(a, b)["outputs"] == contract


def test_two_outputs_declarations_fail_loud() -> None:
    # Two declaring atoms would append two conflicting ===OUTPUT CONTRACT=== epilogues into the
    # merged step's task — exactly one template owns the composed contract.
    a = {"outputs": {"type": "object"}, "steps": [{"id": "s"}]}
    b = {"outputs": {"type": "object"}, "steps": [{"id": "s"}]}
    with pytest.raises(ValueError, match="exactly one template"):
        overlay(a, b)
