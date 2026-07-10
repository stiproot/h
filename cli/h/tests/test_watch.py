"""The watch surface: h watch list/get/rm and h workflow run --watch (respx-mocked wire)."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.commands.workflow import _parse_budget
from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()


def _all_output(result) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass  # click merged stderr into output
    return out


def _heartbeat(seconds_ago: float, enabled: bool = True) -> dict[str, Any]:
    at = datetime.now(UTC) - timedelta(seconds=seconds_ago)
    return {"at": at.isoformat().replace("+00:00", "Z"), "enabled": enabled}


ROW = {
    "instanceId": "wf-1",
    "epoch": 1,
    "attempts": 2,
    "startedAt": "2026-07-05T09:00:00Z",
    "policy": {"maxDurationMs": 2700000},
    "status": "watching",
    "lastStatus": "RUNNING",
    "unknownStreak": 0,
    "costUsd": 1.25,
    "note": "retrying",
    "updatedAt": "2026-07-05T09:05:00Z",
}


# --- h watch list ---


@respx.mock
def test_watch_list_renders_rows_and_fresh_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(
        return_value=Response(200, json={"heartbeat": _heartbeat(30), "watches": [ROW]})
    )
    result = runner.invoke(app, ["watch", "list"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "wf-1" in out
    assert "watching" in out
    assert "heartbeat" in out
    assert "STALE" not in out
    assert "MISSING" not in out


@respx.mock
def test_watch_list_warns_on_stale_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(
        return_value=Response(200, json={"heartbeat": _heartbeat(600), "watches": []})
    )
    result = runner.invoke(app, ["watch", "list"])
    assert result.exit_code == 0, _all_output(result)
    assert "STALE" in _all_output(result)


@respx.mock
def test_watch_list_warns_on_missing_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(
        return_value=Response(200, json={"heartbeat": None, "watches": []})
    )
    result = runner.invoke(app, ["watch", "list"])
    assert result.exit_code == 0, _all_output(result)
    assert "MISSING" in _all_output(result)


# --- h watch get / rm ---


@respx.mock
def test_watch_get_prints_the_row() -> None:
    respx.get(f"{WORKFLOW_URL}/watch/wf-1").mock(return_value=Response(200, json=ROW))
    result = runner.invoke(app, ["watch", "get", "wf-1"])
    assert result.exit_code == 0, _all_output(result)
    assert "wf-1" in result.output
    assert "maxDurationMs" in result.output


@respx.mock
def test_watch_get_404_exits_1() -> None:
    respx.get(f"{WORKFLOW_URL}/watch/nope").mock(
        return_value=Response(404, json={"error": "Watch not found"})
    )
    result = runner.invoke(app, ["watch", "get", "nope"])
    assert result.exit_code == 1
    assert "Watch not found" in _all_output(result)


@respx.mock
def test_watch_rm_deletes_and_confirms() -> None:
    route = respx.delete(f"{WORKFLOW_URL}/watch/wf-1").mock(
        return_value=Response(200, json={"deleted": "wf-1"})
    )
    result = runner.invoke(app, ["watch", "rm", "wf-1"])
    assert result.exit_code == 0, _all_output(result)
    assert route.called
    assert "Deleted watch 'wf-1'" in result.output


# --- h workflow run --watch/--budget/--retry ---


@respx.mock
def test_workflow_run_watch_budget_sets_max_duration_ms() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(202, json={"instanceId": "wf-9", "watching": True})
    )
    result = runner.invoke(app, ["workflow", "run", "feature", "--watch", "--budget", "30m"])
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert body["watch"] == {"maxDurationMs": 1800000}
    assert "watching" in result.output


@respx.mock
def test_workflow_run_watch_retry_adds_fresh_retry_policy() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(202, json={"instanceId": "wf-9", "watching": True})
    )
    result = runner.invoke(app, ["workflow", "run", "feature", "--watch", "--retry", "2"])
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert body["watch"] == {
        "maxDurationMs": 2700000,  # default 45m when --watch without --budget
        "retry": {"maxAttempts": 2, "fresh": True},
    }


@respx.mock
def test_workflow_run_without_watch_sends_no_watch_field() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(202, json={"instanceId": "wf-9"})
    )
    result = runner.invoke(app, ["workflow", "run", "feature"])
    assert result.exit_code == 0, _all_output(result)
    assert "watch" not in json.loads(route.calls[0].request.content)


def test_workflow_run_watch_with_via_exits_1() -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "--watch", "--via", "claude-agent"])
    assert result.exit_code == 1
    assert "drop --via" in _all_output(result)


def test_workflow_run_bad_budget_exits_1() -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "--budget", "soon"])
    assert result.exit_code == 1
    assert "Bad --budget" in _all_output(result)


def test_parse_budget_units() -> None:
    assert _parse_budget("2400000") == 2400000  # plain milliseconds
    assert _parse_budget("45m") == 2700000
    assert _parse_budget("2h") == 7200000
