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
