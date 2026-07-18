"""h schedule list / rm + `h workflow run --at/--in` — the one-shot cron:sched surface (respx)."""

import json
from datetime import UTC, datetime
from typing import Any

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()


def _cron_list_payload(sched: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "heartbeat": {"at": datetime.now(UTC).isoformat(), "enabled": True},
        "crons": [],
        "discover": [],
        "sched": sched,
    }


@respx.mock
def test_schedule_list_renders_sched_rows_with_the_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(
        return_value=Response(
            200,
            json=_cron_list_payload(
                [
                    {
                        "id": "feature--at-1784000000000",
                        "status": "armed",
                        "fireAt": "2026-07-20T09:00:00.000Z",
                        "origin": "at",
                    }
                ]
            ),
        )
    )
    result = runner.invoke(app, ["schedule", "list"], env={"COLUMNS": "200"})
    assert result.exit_code == 0, result.output
    assert "scheduled fires (1)" in result.output
    assert "feature--at-1784000000000" in result.output
    assert "armed" in result.output
    assert "2026-07-20T09:00:00.000Z" in result.output


@respx.mock
def test_schedule_list_flags_a_stale_heartbeat() -> None:
    respx.get(f"{WORKFLOW_URL}/cron/list").mock(
        return_value=Response(200, json={"heartbeat": None, "crons": [], "sched": []})
    )
    result = runner.invoke(app, ["schedule", "list"], env={"COLUMNS": "200"})
    assert result.exit_code == 0
    assert "MISSING" in result.output


@respx.mock
def test_schedule_rm_disarms_by_id() -> None:
    route = respx.post(f"{WORKFLOW_URL}/cron/sched/disarm").mock(
        return_value=Response(
            200, json={"disarmed": "sched-abc", "status": "disarmed", "outcome": "disarmed"}
        )
    )
    result = runner.invoke(app, ["schedule", "rm", "sched-abc"])
    assert result.exit_code == 0, result.output
    assert route.called
    assert json.loads(route.calls.last.request.content) == {"id": "sched-abc"}
    assert "cron:sched:sched-abc" in result.output
    assert "disarmed" in result.output


@respx.mock
def test_schedule_rm_404_exits_nonzero() -> None:
    respx.post(f"{WORKFLOW_URL}/cron/sched/disarm").mock(
        return_value=Response(404, json={"error": "schedule not found"})
    )
    result = runner.invoke(app, ["schedule", "rm", "nope"])
    assert result.exit_code == 1


@respx.mock
def test_run_in_arms_a_one_shot_schedule() -> None:
    """`--in` rides the saved run as an `in` field on /workflow/run/:key (arms a cron:sched row)."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(
            202, json={"scheduled": "feature--at-123", "fireAt": "2026-07-20T09:00:00.000Z"}
        )
    )
    result = runner.invoke(
        app,
        ["workflow", "run", "feature", "-p", "repo=o/r", "-p", "slug=x", "--in", "2h"],
    )
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body["in"] == "2h"
    assert "at" not in body
    assert "scheduled: fires at" in result.output


@respx.mock
def test_run_at_arms_a_one_shot_schedule() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(
            202, json={"scheduled": "my-sched", "fireAt": "2026-07-20T09:00:00.000Z"}
        )
    )
    result = runner.invoke(
        app,
        ["workflow", "run", "feature", "--at", "2026-07-20T09:00:00Z", "--instance-id", "my-sched"],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["at"] == "2026-07-20T09:00:00Z"
    assert body["instanceId"] == "my-sched"


def test_run_at_and_in_are_mutually_exclusive() -> None:
    result = runner.invoke(
        app,
        ["workflow", "run", "feature", "--at", "2026-07-20T09:00:00Z", "--in", "2h"],
    )
    assert result.exit_code == 1
    assert "mutually exclusive" in result.output


def test_run_schedule_and_cron_conflict() -> None:
    result = runner.invoke(
        app,
        ["workflow", "run", "feature", "--in", "2h", "--cron", "*/30 * * * *"],
    )
    assert result.exit_code == 1
    assert "cannot combine" in result.output


@respx.mock
def test_pause_terminates_and_arms_a_resume() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/pause/wf-9").mock(
        return_value=Response(
            202,
            json={
                "paused": "wf-9",
                "scheduled": "wf-9--resume",
                "fireAt": "2026-07-18T14:00:00.000Z",
            },
        )
    )
    result = runner.invoke(
        app,
        ["workflow", "pause", "wf-9", "feature", "--in", "1h", "-p", "repo=o/r", "-p", "slug=x"],
    )
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body["key"] == "feature"
    assert body["in"] == "1h"
    assert body["params"]["repo"] == "o/r"
    assert "resumes at" in result.output


def test_pause_needs_exactly_one_of_at_in() -> None:
    result = runner.invoke(app, ["workflow", "pause", "wf-9", "feature"])
    assert result.exit_code == 1
    assert "exactly one" in result.output


@respx.mock
def test_run_fallback_flags_build_a_watch_fallback_policy() -> None:
    """--fallback-agent/-after/-max build a fallback block on the watch policy sent to the run."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(202, json={"instanceId": "feature-x", "watching": True})
    )
    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            "feature",
            "-p",
            "repo=o/r",
            "-p",
            "slug=x",
            "--fallback-agent",
            "openhands",
            "--fallback-after",
            "10m",
            "--fallback-max",
            "2",
        ],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    fb = body["watch"]["fallback"]
    assert fb["onOutcome"] == ["usage-limited"]
    assert fb["identity"] == {"runActivity": "run-openhands", "agentId": "openhands-agent"}
    assert fb["after"] == 10 * 60_000
    assert fb["maxHandoffs"] == 2
    # --fallback implies --watch.
    assert body["watch"]["maxDurationMs"] > 0


def test_run_fallback_needs_an_agent_or_model() -> None:
    result = runner.invoke(app, ["workflow", "run", "feature", "--fallback-after", "10m"])
    assert result.exit_code == 1
    assert "fallback needs" in result.output


@respx.mock
def test_resume_advances_the_schedule() -> None:
    route = respx.post(f"{WORKFLOW_URL}/workflow/resume/wf-9--resume").mock(
        return_value=Response(
            202, json={"resumed": "wf-9--resume", "status": "armed", "fireAt": "now"}
        )
    )
    result = runner.invoke(app, ["workflow", "resume", "wf-9--resume"])
    assert result.exit_code == 0, result.output
    assert route.called
    assert "resuming wf-9--resume" in result.output
