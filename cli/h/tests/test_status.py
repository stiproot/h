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

GITHUB_API_URL = "https://api.github.com/repos/stiproot/h/pulls"


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
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(return_value=Response(200, json=[]))

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
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(return_value=Response(200, json=[]))

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
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(return_value=Response(200, json=[]))

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "ATTENTION" in out
    assert "stale" in out.lower()


@respx.mock
def test_status_unreachable_svc() -> None:
    """All four endpoints unreachable → exit 0, ATTENTION in output."""
    err = httpx.ConnectError("Connection refused")
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(side_effect=err)
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(side_effect=err)
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(side_effect=err)
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(side_effect=err)

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
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(return_value=Response(200, json=[]))

    result = runner.invoke(app, ["status", "--json"])
    assert result.exit_code == 0, _all_output(result)
    # The output should contain a valid JSON object
    out = result.output.strip()
    parsed = json.loads(out)
    assert parsed["verdict"] == "OK"
    assert "chains" in parsed
    assert "engines" in parsed
    assert "prs" in parsed
    assert "flags" in parsed


@respx.mock
def test_status_active_watches_excludes_finalized() -> None:
    """Only watches in 'scheduling' or 'watching' status count as active; finalized rows are excluded."""
    watches = [
        {"instanceId": "run-1", "status": "watching"},
        {"instanceId": "run-2", "status": "scheduling"},
        {"instanceId": "run-3", "status": "finalized"},  # Should NOT count
    ]
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(
        return_value=Response(200, json=_watch_payload(watches))
    )
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(return_value=Response(200, json=[]))

    result = runner.invoke(app, ["status", "--json"])
    assert result.exit_code == 0, _all_output(result)
    parsed = json.loads(result.output.strip())
    assert parsed["engines"]["active_watches"] == 2


@respx.mock
def test_status_open_prs() -> None:
    """Open PRs are fetched and displayed; unavailable PR source produces ATTENTION flag."""
    prs_data = [
        {"number": 42, "title": "Fix issue X", "user": {"login": "alice"}},
        {"number": 41, "title": "Feature Y", "user": {"login": "bob"}},
    ]
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(return_value=Response(200, json=prs_data))

    result = runner.invoke(app, ["status", "--json"])
    assert result.exit_code == 0, _all_output(result)
    parsed = json.loads(result.output.strip())
    assert len(parsed["prs"]["open"]) == 2
    assert parsed["prs"]["open"][0]["number"] == 42
    assert parsed["prs"]["open"][0]["title"] == "Fix issue X"
    assert parsed["prs"]["open"][0]["author"] == "alice"
    assert parsed["verdict"] == "OK"


@respx.mock
def test_status_open_prs_fetch_failure() -> None:
    """PR fetch failure (network error) produces ATTENTION flag without nonzero exit."""
    err = httpx.ConnectError("GitHub API unavailable")
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
    respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))
    respx.get(f"{GITHUB_API_URL}?state=open&per_page=50").mock(side_effect=err)

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, _all_output(result)
    out = _all_output(result)
    assert "ATTENTION" in out
    assert "open_prs" in out


@respx.mock
def test_status_open_prs_missing_token() -> None:
    """Missing GH_TOKEN produces ATTENTION flag without nonzero exit."""
    import os
    # Save and clear GH_TOKEN
    original_token = os.environ.get("GH_TOKEN")
    if "GH_TOKEN" in os.environ:
        del os.environ["GH_TOKEN"]

    try:
        respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(200, json=_chain_payload()))
        respx.get(f"{WORKFLOW_URL}/watch/list").mock(return_value=Response(200, json=_watch_payload()))
        respx.get(f"{WORKFLOW_URL}/cron/list").mock(return_value=Response(200, json=_cron_payload()))

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0, _all_output(result)
        out = _all_output(result)
        assert "ATTENTION" in out
        assert "open_prs" in out
    finally:
        # Restore GH_TOKEN
        if original_token:
            os.environ["GH_TOKEN"] = original_token
