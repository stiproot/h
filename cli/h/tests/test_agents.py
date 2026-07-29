"""h agents — CLI-level tests through typer's in-process runner.

The list reads config data; the policy half (deny/allow, the policy column) talks to
workflow-svc's /exec/policy and is respx-mocked."""

import json

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()


def test_agents_list() -> None:
    # Unmocked: the policy read fails closed (socket disabled) and the list still renders.
    result = runner.invoke(app, ["agents", "list"])
    assert result.exit_code == 0, result.output
    # Each agent name and its agentId should appear in the table.
    for name, agent_id in (
        ("claude", "claude-agent"),
        ("openhands", "openhands-agent"),
        ("pi", "pi-agent"),
    ):
        assert name in result.output
        assert agent_id in result.output
    assert "unreachable" in result.output  # the fallback was taken, visibly


@respx.mock
def test_agents_list_marks_denied_executors() -> None:
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": ["codex"], "updatedAt": "2026-07-29T00:00:00Z"})
    )
    result = runner.invoke(app, ["agents", "list"])
    assert result.exit_code == 0, result.output
    assert "DENIED" in result.output


@respx.mock
def test_agents_deny_merges_into_the_denied_set() -> None:
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": ["pi"], "updatedAt": ""})
    )
    posted = respx.post(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": ["codex", "pi"], "updatedAt": ""})
    )
    result = runner.invoke(app, ["agents", "deny", "codex"])
    assert result.exit_code == 0, result.output
    assert json.loads(posted.calls.last.request.content) == {"denied": ["codex", "pi"]}


@respx.mock
def test_agents_allow_removes_from_the_denied_set() -> None:
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": ["codex", "pi"], "updatedAt": ""})
    )
    posted = respx.post(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": ["pi"], "updatedAt": ""})
    )
    result = runner.invoke(app, ["agents", "allow", "codex"])
    assert result.exit_code == 0, result.output
    assert json.loads(posted.calls.last.request.content) == {"denied": ["pi"]}


def test_agents_deny_refuses_an_unknown_name() -> None:
    # A typo must fail loudly BEFORE any HTTP — the engine gate matches shortnames, so an
    # unknown name would silently deny nothing.
    result = runner.invoke(app, ["agents", "deny", "codexx"])
    assert result.exit_code == 1
    assert "unknown agent" in result.output
