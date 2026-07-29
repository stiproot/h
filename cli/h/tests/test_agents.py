"""h agents — CLI-level tests through typer's in-process runner.

The list reads config data; the policy half (deny/allow, the policy column) talks to
workflow-svc's /exec/policy and is respx-mocked. Entries carry provenance
(docs/plans/impl/usage-limit-auto-deny.md): operator denies never expire, auto usage-limited
denies carry an expiry."""

import json

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()

OP = {"name": "codex", "reason": "operator", "deniedAt": "2026-07-29T00:00:00Z"}
AUTO = {
    "name": "kimi",
    "reason": "usage-limited",
    "deniedAt": "2026-07-29T00:00:00Z",
    "until": "2026-07-29T06:00:00Z",
}


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
def test_agents_list_marks_denied_executors_with_provenance() -> None:
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": [OP, AUTO], "updatedAt": "2026-07-29T00:00:00Z"})
    )
    result = runner.invoke(app, ["agents", "list"])
    assert result.exit_code == 0, result.output
    assert "DENIED" in result.output  # the operator entry's compact cell
    assert "auto-denied" in result.output  # the usage-limited entry's compact cell
    # Full provenance rides the summary line under the table.
    assert "kimi (usage-limited, until 2026-07-29T06:00:00Z)" in result.output


@respx.mock
def test_agents_deny_merges_and_upgrades_auto_entries() -> None:
    # Denying kimi while an AUTO entry covers it: the auto entry is dropped and a bare name is
    # posted — the route stamps it as a never-expiring OPERATOR entry (the upgrade).
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": [OP, AUTO], "updatedAt": ""})
    )
    posted = respx.post(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": [OP], "updatedAt": ""})
    )
    result = runner.invoke(app, ["agents", "deny", "kimi"])
    assert result.exit_code == 0, result.output
    assert json.loads(posted.calls.last.request.content) == {"denied": [OP, "kimi"]}


@respx.mock
def test_agents_allow_lifts_operator_and_auto_entries_alike() -> None:
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": [OP, AUTO], "updatedAt": ""})
    )
    posted = respx.post(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(200, json={"denied": [AUTO], "updatedAt": ""})
    )
    result = runner.invoke(app, ["agents", "allow", "codex"])
    assert result.exit_code == 0, result.output
    assert json.loads(posted.calls.last.request.content) == {"denied": [AUTO]}


def test_agents_deny_refuses_an_unknown_name() -> None:
    # A typo must fail loudly BEFORE any HTTP — the engine gate matches shortnames, so an
    # unknown name would silently deny nothing.
    result = runner.invoke(app, ["agents", "deny", "codexx"])
    assert result.exit_code == 1
    assert "unknown agent" in result.output
