"""h template drift — saved definitions vs a fresh render of their template (respx-mocked wire).

The comparison itself is pure, so most of this exercises `_diff_sections` directly; the command
tests cover the wiring and the exit code that lets it gate.
"""

import json

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.commands.template import _diff_sections, _template_for_saved_key
from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()

STEPS = [{"id": "a", "activity": "run-claude", "input": {"task": "t"}}]


# --- what counts as drift ------------------------------------------------------------------------


def test_identical_definitions_do_not_drift() -> None:
    stored = {"steps": STEPS, "params": {"x": "1"}, "outputs": {"type": "object"}}
    assert _diff_sections(stored, dict(stored)) == []


def test_a_changed_step_is_drift() -> None:
    stored = {"steps": STEPS}
    fresh = {"steps": [{**STEPS[0], "input": {"task": "CHANGED"}}]}
    assert _diff_sections(stored, fresh) == ["steps"]


def test_each_compared_section_is_reported_by_name() -> None:
    stored = {"steps": STEPS, "params": {"x": "1"}, "outputs": {"type": "object"}}
    fresh = {"steps": STEPS, "params": {"x": "2"}, "outputs": {"type": "string"}}
    assert _diff_sections(stored, fresh) == ["params", "outputs"]


# Absent and empty are the same thing: a template rendering no outputs and a stored record simply
# omitting the key are not in conflict, and reporting them as drift would make the check cry wolf
# on most saved workflows.
def test_absent_and_empty_are_not_drift() -> None:
    assert _diff_sections({"steps": STEPS}, {"steps": STEPS, "outputs": None}) == []
    assert _diff_sections({"steps": STEPS, "params": {}}, {"steps": STEPS}) == []


# Publish-time operational choices are not template content — re-publishing does not change them
# and a schedule differing is not a reason to alarm.
def test_operational_fields_are_not_compared() -> None:
    stored = {"steps": STEPS, "schedule": "*/5 * * * *", "savedAt": "2026-01-01", "disabled": True}
    assert _diff_sections(stored, {"steps": STEPS}) == []


# --- which keys are checkable ---------------------------------------------------------------------


def test_a_chain_published_key_has_no_template_to_compare() -> None:
    # Chain members publish as <slug>-w<N>; there is no such chart template, so it is unchecked
    # rather than drifted.
    assert _template_for_saved_key("my-feature-w0") is None


def test_a_real_template_key_resolves() -> None:
    assert _template_for_saved_key("review-pr") == "review-pr"


# --- the command ---------------------------------------------------------------------------------


@respx.mock
def test_a_key_with_no_template_is_reported_unchecked_and_exits_0() -> None:
    respx.get(f"{WORKFLOW_URL}/workflow/list").mock(
        return_value=Response(200, json={"keys": ["my-feature-w0"]})
    )
    result = runner.invoke(app, ["template", "drift", "--json"])
    assert result.exit_code == 0
    rows = json.loads(result.stdout)
    assert rows == [
        {"key": "my-feature-w0", "template": None, "status": "unchecked", "sections": []}
    ]


@respx.mock
def test_an_unreachable_service_fails_loudly() -> None:
    respx.get(f"{WORKFLOW_URL}/workflow/list").mock(return_value=Response(500))
    result = runner.invoke(app, ["template", "drift"])
    assert result.exit_code == 1


@respx.mock
def test_drift_exits_1_so_it_can_gate(monkeypatch) -> None:
    respx.get(f"{WORKFLOW_URL}/workflow/list").mock(
        return_value=Response(200, json={"keys": ["answer"]})
    )
    respx.get(f"{WORKFLOW_URL}/workflow/get/answer").mock(
        return_value=Response(200, json={"steps": STEPS})
    )
    # Render a DIFFERENT shape than what is stored, without invoking helm.
    monkeypatch.setattr(
        "h_cli.commands.template._render_published",
        lambda template: {"steps": [{"id": "a", "activity": "run-codex"}]},
    )
    monkeypatch.setattr("h_cli.commands.template._template_for_saved_key", lambda key: "answer")
    result = runner.invoke(app, ["template", "drift", "--json"])
    assert result.exit_code == 1
    rows = json.loads(result.stdout)
    assert rows[0]["status"] == "drifted"
    assert rows[0]["sections"] == ["steps"]


@respx.mock
def test_matching_definitions_exit_0(monkeypatch) -> None:
    respx.get(f"{WORKFLOW_URL}/workflow/get/answer").mock(
        return_value=Response(200, json={"steps": STEPS, "params": {"task": ""}})
    )
    monkeypatch.setattr(
        "h_cli.commands.template._render_published",
        lambda template: {"steps": STEPS, "params": {"task": ""}},
    )
    monkeypatch.setattr("h_cli.commands.template._template_for_saved_key", lambda key: "answer")
    result = runner.invoke(app, ["template", "drift", "answer", "--json"])
    assert result.exit_code == 0
    assert json.loads(result.stdout)[0]["status"] == "ok"
