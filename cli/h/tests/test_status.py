"""h status — one-screen driver check-in (respx-mocked wire)."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()


def _all_output(result: Any) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass
    return out


def _heartbeat(seconds_ago: float = 30.0, enabled: bool = True) -> dict[str, Any]:
    at = datetime.now(UTC) - timedelta(seconds=seconds_ago)
    return {"at": at.isoformat().replace("+00:00", "Z"), "enabled": enabled}


def _chain_payload(chains: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"heartbeat": _heartbeat(), "chains": chains or []}


def _watch_payload(watches: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"heartbeat": _heartbeat(), "watches": watches or []}


def _cron_payload(
    crons: list[dict[str, Any]] | None = None,
    sched: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "heartbeat": _heartbeat(),
        "crons": crons or [],
        "discover": [],
        "sched": sched or [],
    }


@respx.mock
def test_status_ok_all_quiet() -> None:
    """All heartbeats fresh, no rows → verdict OK, exit 0."""
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "OK" in out
    assert "ATTENTION" not in out


@respx.mock
def test_status_failed_chain_flag() -> None:
    """A chain finalized 'failed' within 24h → ATTENTION flag with 'failed' in output."""
    ended = (datetime.now(UTC) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    chains = [
        {
            "chainId": "fix-x",
            "status": "finalized",
            "outcome": "failed",
            "members": [],
            "cursor": 0,
            "endedAt": ended,
            "startedAt": ended,
        }
    ]
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(
        return_value=Response(200, json=_chain_payload(chains))
    )
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "ATTENTION" in out
    assert "fix-x" in out
    assert "failed" in out


@respx.mock
def test_status_stale_heartbeat_flag() -> None:
    """One heartbeat 600s old → ATTENTION flag mentioning stale."""
    stale_cron_payload = {
        "heartbeat": _heartbeat(600),
        "crons": [],
        "discover": [],
        "sched": [],
    }
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(
        return_value=Response(200, json=stale_cron_payload)
    )

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "ATTENTION" in out
    assert "stale" in out.lower()


@respx.mock
def test_status_unreachable_svc() -> None:
    """All three endpoints unreachable → exit 0, ATTENTION in output."""
    err = httpx.ConnectError("Connection refused")
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(side_effect=err)
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(side_effect=err)
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(side_effect=err)

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "ATTENTION" in out


@respx.mock
def test_status_json_flag() -> None:
    """--json emits valid JSON with a 'verdict' key equal to 'OK' when all quiet."""
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))

    result = runner.invoke(app, ["status", "--json"])
    assert result.exit_code == 0, _all_output(result)
    # The output should contain a valid JSON object
    out = result.output.strip()
    parsed = json.loads(out)
    assert parsed["verdict"] == "OK"
    assert "chains" in parsed
    assert "engines" in parsed
    assert "flags" in parsed
