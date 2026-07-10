"""The --via routing path (submit to an agent's POST /workflow) and the --agent/--model identity
flags that mirror `h chain run` — respx-mocked."""

import json

import pytest
import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.config import WORKFLOW_URL, resolve_agent_url
from h_cli.infrastructure.agent_service import submit_workflow
from h_cli.main import app

runner = CliRunner()


def test_resolve_agent_url_registry_and_passthrough() -> None:
    assert resolve_agent_url("claude-agent") == "http://localhost:8002"
    assert resolve_agent_url("http://otherhost:9999") == "http://otherhost:9999"
    assert resolve_agent_url("nope") is None


@respx.mock
def test_submit_workflow_posts_the_body() -> None:
    route = respx.post("http://localhost:8002/workflow").mock(
        return_value=Response(202, json={"instanceId": "wf-1", "watching": True})
    )
    result = submit_workflow("http://localhost:8002", {"key": "feature", "params": {"slug": "x"}})
    assert result == {"instanceId": "wf-1", "watching": True}
    assert json.loads(route.calls[0].request.content) == {
        "key": "feature",
        "params": {"slug": "x"},
    }


@respx.mock
def test_workflow_run_via_flag_targets_the_babysitter() -> None:
    route = respx.post("http://localhost:8002/workflow").mock(
        return_value=Response(202, json={"instanceId": "wf-2", "watching": True})
    )
    result = runner.invoke(
        app, ["workflow", "run", "feature", "-p", "slug=dark-mode", "--via", "claude-agent"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == {
        "key": "feature",
        "params": {"slug": "dark-mode"},
    }
    assert "wf-2" in result.output


def test_workflow_run_unknown_via_lists_the_registry() -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "--via", "nope"])
    assert result.exit_code == 1
    combined = result.output + getattr(result, "stderr", "")
    assert "Unknown --via agent" in combined


@respx.mock
def test_workflow_run_agent_and_model_are_machinery_p_carries_content() -> None:
    """--agent + --model are execution machinery (expand to identity/model params); template
    CONTENT values ride -p key=value. Goes straight to workflow-svc (not a --via babysitter)."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature-pr").mock(
        return_value=Response(200, json={"instanceId": "feature-x", "watching": False})
    )
    result = runner.invoke(
        app,
        ["workflow", "run", "feature-pr", "-p", "slug=x", "--agent", "openhands", "--model", "m1"],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    assert body["params"]["runActivity"] == "run-openhands"  # --agent machinery
    assert body["params"]["agentId"] == "openhands-agent"
    assert body["params"]["modelImplement"] == "m1"  # --model machinery → all model slots
    assert body["params"]["modelPlan"] == "m1"
    assert body["params"]["slug"] == "x"  # content value via -p


def test_workflow_run_unknown_agent_identity_exits_1() -> None:
    result = runner.invoke(app, ["workflow", "run", "feature-pr", "--agent", "nope"])
    assert result.exit_code == 1
    assert "unknown --agent" in (result.output + getattr(result, "stderr", ""))


@respx.mock
def test_workflow_run_agent_on_frozen_executor_is_ignored() -> None:
    """The pr-review executor is frozen — --agent warns and applies no identity params."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/pr-review").mock(
        return_value=Response(200, json={"instanceId": "pr-review-x", "watching": False})
    )
    result = runner.invoke(app, ["workflow", "run", "pr-review", "--agent", "openhands"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    # frozen: no identity params leaked in
    assert "runActivity" not in body.get("params", {})
    assert "frozen" in (result.output + getattr(result, "stderr", ""))


@pytest.mark.parametrize("flag", [[], ["--via", "claude-agent"]])
def test_workflow_run_requires_valid_params(flag: list[str]) -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "-p", "not-a-pair", *flag])
    assert result.exit_code == 1
