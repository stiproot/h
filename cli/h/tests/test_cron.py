"""h cron list — the recur registry's inspection surface (respx-mocked wire)."""

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
                        "workflow": "revise",
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
    assert "stiproot/h:pi-agent:revise" in result.output
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
                        "workflow": "feature-pr",
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
def test_cron_discover_add_posts_body_and_defaults_workflow() -> None:
    route = respx.post(f"{WORKFLOW_URL}/cron/discover").mock(
        return_value=Response(202, json={"discoverId": "stiproot/h:agent-approved", "active": True})
    )
    result = runner.invoke(
        app,
        ["cron", "discover", "add", "stiproot/h", "-l", "agent-approved", "-c", "0 * * * *", "--max-per-day", "3"],
        env={"COLUMNS": "200"},
    )
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body == {
        "repo": "stiproot/h",
        "label": "agent-approved",
        "cadence": "0 * * * *",
        "workflow": "feature-pr",  # defaulted
        "gates": {"maxFiresPerDay": 3},
    }
    assert "registered" in result.output
