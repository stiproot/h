"""h cron list / h cron rm — the recur registry's inspection surface (respx-mocked wire)."""

import json
from datetime import UTC, datetime
from typing import Any

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()


def _cron_list_payload(
    crons: list[dict[str, Any]], discover: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return {
        "heartbeat": {"at": datetime.now(UTC).isoformat(), "enabled": True},
        "crons": crons,
        "discover": discover or [],
    }


@respx.mock
def test_cron_list_renders_rows_with_the_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(
        return_value=Response(
            200,
            json=_cron_list_payload(
                [
                    {
                        "repo": "stiproot/h",
                        "slug": "pi-agent",
                        "workflow": "revise-pr",
                        "status": "active",
                        "cadence": "*/30 * * * *",
                        "fires": 2,
                        "budget": {"maxFires": 100},
                    }
                ]
            ),
        )
    )
    result = runner.invoke(app, ["cron", "list"], env={"COLUMNS": "200"})
    assert result.exit_code == 0, result.output
    assert "stiproot/h:pi-agent:revise-pr" in result.output
    assert "*/30 * * * *" in result.output
    assert "2/100" in result.output
    assert "crons (1)" in result.output


@respx.mock
def test_cron_list_flags_a_missing_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(
        return_value=Response(200, json={"heartbeat": None, "crons": []})
    )
    result = runner.invoke(app, ["cron", "list"], env={"COLUMNS": "200"})
    assert result.exit_code == 0
    assert "MISSING" in result.output


@respx.mock
def test_cron_list_renders_discovery_rows() -> None:
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(
        return_value=Response(
            200,
            json=_cron_list_payload(
                [],
                discover=[
                    {
                        "repo": "stiproot/h",
                        "label": "agent-approved",
                        "workflow": "implement-pr",
                        "status": "active",
                        "cadence": "0 * * * *",
                        "fires": 3,
                        "gates": {"maxFiresPerDay": 5},
                        "lastFiredIssue": 42,
                    }
                ],
            ),
        )
    )
    result = runner.invoke(app, ["cron", "list"], env={"COLUMNS": "200"})
    assert result.exit_code == 0, result.output
    assert "discovery crons (1)" in result.output
    assert "stiproot/h:agent-approved" in result.output
    assert "42" in result.output


@respx.mock
def test_cron_discover_add_fires_a_provision_workflow() -> None:
    # §10: `h cron discover add` fires a one-step provision workflow (register-discover activity),
    # NOT a POST /cron/discover — registration is an activity, not an HTTP handler.
    route = respx.post(f"{WORKFLOW_URL}/workflow/run").mock(
        return_value=Response(202, json={"instanceId": "provision-discover-agent-approved"})
    )
    result = runner.invoke(
        app,
        # fmt: off
        [
            "cron",
            "discover",
            "add",
            "stiproot/h",
            "-l",
            "agent-approved",
            "-c",
            "0 * * * *",
            "--max-per-day",
            "3",
        ],
        # fmt: on
        env={"COLUMNS": "200"},
    )
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(route.calls.last.request.content)
    # One register-discover step carrying the discovery params; a wf: identity audits the
    # provision.
    assert body["steps"] == [
        {
            "activity": "register-discover",
            "input": {
                "repo": "stiproot/h",
                "label": "agent-approved",
                "workflow": "implement-pr",  # defaulted
                "cadence": "0 * * * *",
                "maxFiresPerDay": 3,
            },
        }
    ]
    assert body["wf"] == {
        "repo": "stiproot/h",
        "slug": "discover-agent-approved",
        "workflow": "provision-discover",
    }
    # No watch flags → the fired runs carry no watch policy.
    assert "watch" not in body["steps"][0]["input"]
    assert "provisioned" in result.output


@respx.mock
def test_cron_discover_add_attaches_a_watch_policy() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/run").mock(
        return_value=Response(202, json={"instanceId": "provision-discover-agent-approved"})
    )
    result = runner.invoke(
        app,
        [
            "cron",
            "discover",
            "add",
            "stiproot/h",
            "-l",
            "agent-approved",
            "-c",
            "0 * * * *",
            "--run-budget-mins",
            "40",
            "--run-retries",
            "2",
        ],
        env={"COLUMNS": "200"},
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["steps"][0]["input"]["watch"] == {
        "maxDurationMs": 40 * 60_000,
        "retry": {"maxAttempts": 2, "fresh": True},
    }
    assert "supervised" in result.output


def test_cron_discover_add_run_retries_needs_a_budget() -> None:
    result = runner.invoke(
        app,
        # fmt: off
        [
            "cron",
            "discover",
            "add",
            "stiproot/h",
            "-l",
            "agent-approved",
            "-c",
            "0 * * * *",
            "--run-retries",
            "2",
        ],
        # fmt: on
        env={"COLUMNS": "200"},
    )
    assert result.exit_code == 1
    assert "needs --run-budget-mins" in result.output


@respx.mock
def test_cron_rm_disarms_an_active_cron() -> None:
    route = respx.post(f"{WORKFLOW_URL}/cron/disarm").mock(
        return_value=Response(
            200,
            json={
                "disarmed": "stiproot/h:dark-mode:revise-pr",
                "status": "inactive",
                "outcome": "disabled",
            },
        )
    )
    result = runner.invoke(app, ["cron", "rm", "stiproot/h", "dark-mode", "revise-pr"])
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body == {"repo": "stiproot/h", "slug": "dark-mode", "workflow": "revise-pr"}
    assert "cron:sub:stiproot/h:dark-mode:revise-pr" in result.output
    assert "inactive" in result.output


@respx.mock
def test_cron_rm_404_exits_nonzero() -> None:
    respx.post(f"{WORKFLOW_URL}/cron/disarm").mock(
        return_value=Response(404, json={"error": "cron not found"})
    )
    result = runner.invoke(app, ["cron", "rm", "stiproot/h", "no-such", "workflow"])
    assert result.exit_code == 1
