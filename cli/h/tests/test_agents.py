"""h agents — CLI-level tests through typer's in-process runner.

The list reads config data; the policy half (deny/allow, the policy column) talks to
workflow-svc's /exec/policy and is respx-mocked. Entries carry provenance
: operator denies never expire, auto usage-limited
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


@respx.mock
def test_agents_budget_set_posts_the_shortname_and_amount() -> None:
    posted = respx.post(f"{WORKFLOW_URL}/exec/budget").mock(
        return_value=Response(200, json={"budgets": {"kimi": 5.0}, "updatedAt": ""})
    )
    result = runner.invoke(app, ["agents", "budget", "kimi", "5"])
    assert result.exit_code == 0, result.output
    assert json.loads(posted.calls.last.request.content) == {
        "name": "kimi",
        "dailyBudgetUsd": 5.0,
    }
    assert "kimi $5/day" in result.output


@respx.mock
def test_agents_budget_clear_posts_null() -> None:
    posted = respx.post(f"{WORKFLOW_URL}/exec/budget").mock(
        return_value=Response(200, json={"budgets": {}, "updatedAt": ""})
    )
    result = runner.invoke(app, ["agents", "budget", "kimi", "--clear"])
    assert result.exit_code == 0, result.output
    assert json.loads(posted.calls.last.request.content) == {
        "name": "kimi",
        "dailyBudgetUsd": None,
    }
    assert "(none)" in result.output


def test_agents_budget_refuses_a_missing_amount() -> None:
    # No amount and no --clear: fail loudly before any HTTP.
    result = runner.invoke(app, ["agents", "budget", "kimi"])
    assert result.exit_code == 1
    assert "positive USD/day" in result.output


@respx.mock
def test_agents_list_shows_budget_and_today_spend_columns() -> None:
    # The A1 surface: budget vs tallied day spend at a glance,
    # plus the gap warning when runs finalized with no usable cost.
    respx.get(f"{WORKFLOW_URL}/exec/policy").mock(
        return_value=Response(
            200,
            json={
                "denied": [],
                "updatedAt": "",
                "budgets": {"kimi": 5.0},
                "todaySpend": {"kimi": 3.1, "claude": 0.42},
                "todayCostGapRuns": 2,
            },
        )
    )
    result = runner.invoke(app, ["agents", "list"])
    assert result.exit_code == 0, result.output
    assert "$5/day" in result.output
    assert "$3.10" in result.output
    assert "$0.42" in result.output
    assert "2 run(s) finalized with NO usable cost" in result.output
