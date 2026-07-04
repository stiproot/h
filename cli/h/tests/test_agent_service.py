"""The --agent path: submit to an agent service's standard POST /workflow (respx-mocked)."""

import json

import pytest
import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.config import resolve_agent_url
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
def test_workflow_run_agent_flag_targets_the_babysitter() -> None:
    route = respx.post("http://localhost:8002/workflow").mock(
        return_value=Response(202, json={"instanceId": "wf-2", "watching": True})
    )
    result = runner.invoke(
        app, ["workflow", "run", "feature", "-p", "slug=dark-mode", "--agent", "claude-agent"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == {
        "key": "feature",
        "params": {"slug": "dark-mode"},
    }
    assert "wf-2" in result.output


def test_workflow_run_unknown_agent_lists_the_registry() -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "--agent", "nope"])
    assert result.exit_code == 1
    combined = result.output + getattr(result, "stderr", "")
    assert "Unknown agent" in combined


@pytest.mark.parametrize("flag", [[], ["--agent", "claude-agent"]])
def test_workflow_run_requires_valid_params(flag: list[str]) -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "-p", "not-a-pair", *flag])
    assert result.exit_code == 1
