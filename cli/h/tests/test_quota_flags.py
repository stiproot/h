"""The quota gate's CLI half: the two flags build ONE wire shape, and every fire surface hands
it to its substrate unchanged. The gate itself is engine-core's `decideQuota` (tested there);
what these pin is that `--on-quota`/`--ignore-quota` reach the job or the request body, and
that the observation row renders the way `h agents list` / `h doctor` promise.
"""

from typing import Any

import httpx
import pytest
import respx
import typer
from typer.testing import CliRunner

from h_cli.commands._quota import quota_cell, quota_gate, resumption_hint
from h_cli.main import app

runner = CliRunner()


# --- the wire shape -----------------------------------------------------------------------------


def test_quota_gate_is_absent_by_default() -> None:
    """No flags ⇒ nothing on the wire: the substrate's default (`fail`) applies without the CLI
    restating it, so a CLI older than the runner never pins a mode it did not ask for."""
    assert quota_gate(None, False) is None


@pytest.mark.parametrize(
    ("on_quota", "ignore", "expected"),
    [
        ("wait", False, {"onQuota": "wait"}),
        ("fail", False, {"onQuota": "fail"}),
        (None, True, {"onQuota": "fail", "ignore": True}),
        ("wait", True, {"onQuota": "wait", "ignore": True}),
    ],
)
def test_quota_gate_builds_the_QuotaGate_shape(on_quota, ignore, expected) -> None:
    assert quota_gate(on_quota, ignore) == expected


def test_quota_gate_refuses_an_unknown_mode_by_name() -> None:
    with pytest.raises(typer.BadParameter, match="fail or wait"):
        quota_gate("retry", False)


# --- the flags reach the substrate ---------------------------------------------------------------


@pytest.fixture
def local_job(monkeypatch) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []

    def fake_run_job(job: dict[str, Any], bin_path=None) -> dict[str, Any]:
        jobs.append(job)
        return {
            "ok": True,
            "group": job.get("group", "g"),
            "results": {"answer": {"output": "the answer", "structured": {"answer": "42"}}},
            "runs": [{"agent": "claude", "status": "completed", "output": "hi", "runId": "r1"}],
        }

    monkeypatch.setattr("h_cli.commands.workflow.local_runtime.run_job", fake_run_job)
    monkeypatch.setattr("h_cli.commands.delegate.local_runtime.run_job", fake_run_job)
    monkeypatch.setattr(
        "h_cli.commands.workflow._journal_preflight",
        lambda resume: {"url": "nats://stub:4222", **({"resume": True} if resume else {})},
    )
    return jobs


def test_delegate_carries_the_gate_in_its_job(local_job, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "h_cli.commands.delegate.workspace.assert_managed", lambda p, allow_external=False: p
    )
    result = runner.invoke(
        app,
        ["delegate", "say hi", "--agent", "claude", "--cwd", str(tmp_path), "--on-quota", "wait"],
    )
    assert result.exit_code == 0, result.output
    assert local_job[0]["quota"] == {"onQuota": "wait"}


def test_delegate_leaves_the_gate_off_the_job_by_default(local_job, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "h_cli.commands.delegate.workspace.assert_managed", lambda p, allow_external=False: p
    )
    result = runner.invoke(app, ["delegate", "say hi", "--agent", "claude", "--cwd", str(tmp_path)])
    assert result.exit_code == 0, result.output
    assert "quota" not in local_job[0]


@respx.mock
def test_service_run_sends_the_gate_and_wait_implies_watch() -> None:
    """`wait` on the service path is a WATCHER behaviour (the continuation is armed at finalize),
    so asking for it without --watch must still register a watch row — the flag would otherwise
    be accepted and silently do nothing."""
    route = respx.post("http://localhost:8003/workflow/run/answer").mock(
        return_value=httpx.Response(200, json={"instanceId": "answer-1"})
    )
    result = runner.invoke(
        app, ["workflow", "run", "answer", "-p", "task=q", "--on-quota", "wait", "--ignore-quota"]
    )
    assert result.exit_code == 0, result.output
    body = route.calls.last.request.read()
    import json

    sent = json.loads(body)
    assert sent["quota"] == {"onQuota": "wait", "ignore": True}
    assert sent["watch"]["onQuota"] == "wait"


def test_via_refuses_the_gate_by_name() -> None:
    result = runner.invoke(
        app, ["workflow", "run", "answer", "-p", "task=q", "--via", "claude", "--on-quota", "fail"]
    )
    assert result.exit_code == 1
    assert "drop --via" in result.output


# --- the observation row's rendering -----------------------------------------------------------

NOW = "2026-09-03T10:00:00Z"


def test_quota_cell_renders_both_windows_with_local_resets() -> None:
    row = {
        "executor": "claude",
        "status": "allowed",
        "windows": {
            "five_hour": {"utilization": 0.62, "resetsAt": "2026-09-03T12:05:00Z"},
            "seven_day": {"utilization": 0.31, "resetsAt": "2026-09-08T07:00:00Z"},
        },
    }
    cell = quota_cell(row, NOW)
    assert cell.startswith("5h 62% → ")
    assert " · 7d 31% → " in cell
    assert "!" not in cell


def test_quota_cell_marks_a_rejected_report_and_a_passed_reset() -> None:
    row = {
        "executor": "claude",
        "status": "rejected",
        "windows": {
            "five_hour": {"utilization": 1.0, "resetsAt": "2026-09-03T14:00:00Z"},
            "seven_day": {"utilization": 0.9, "resetsAt": "2026-09-03T09:00:00Z"},
        },
    }
    cell = quota_cell(row, NOW)
    assert cell.startswith("!5h 100% → ")
    assert cell.endswith(" · 7d reset"), cell


def test_quota_cell_is_a_dash_when_nothing_was_observed() -> None:
    assert quota_cell(None) == "-"
    assert quota_cell({"executor": "codex", "status": "allowed", "windows": {}}) == "-"


# --- a usage-limited run says when to come back ----------------------------------------------


def _limited(windows: dict[str, Any] | None) -> dict[str, Any]:
    run: dict[str, Any] = {"agent": "claude", "status": "failed", "stopReason": "usage-limited"}
    if windows is not None:
        run["quota"] = {"status": "rejected", "windows": windows}
    return run


def test_resumption_hint_names_the_exhausted_window_not_the_soonest() -> None:
    hint = resumption_hint(
        _limited(
            {
                "five_hour": {"utilization": 0.4, "resetsAt": "2026-09-03T12:05:00Z"},
                "seven_day": {"utilization": 1.0, "resetsAt": "2026-09-08T07:00:00Z"},
            }
        ),
        NOW,
    )
    assert hint is not None and "(7d window)" in hint and "re-run this command unchanged" in hint


def test_resumption_hint_falls_back_to_the_soonest_reset_and_skips_passed_ones() -> None:
    hint = resumption_hint(
        _limited(
            {
                "five_hour": {"utilization": 0.9, "resetsAt": "2026-09-03T09:00:00Z"},
                "seven_day": {"utilization": 0.5, "resetsAt": "2026-09-08T07:00:00Z"},
            }
        ),
        NOW,
    )
    assert hint is not None and "(7d window)" in hint


def test_resumption_hint_without_a_report_still_says_what_to_do() -> None:
    hint = resumption_hint(_limited(None), NOW)
    assert hint is not None and hint.startswith("resumes after the reset the CLI stated")


def test_resumption_hint_is_none_for_any_other_stop() -> None:
    assert resumption_hint({"stopReason": "timeout", "quota": {"windows": {}}}, NOW) is None


def test_delegate_prints_the_resumption_line_for_a_usage_limited_run(monkeypatch, tmp_path) -> None:
    def fake_run_job(job: dict[str, Any], bin_path=None) -> dict[str, Any]:
        return {
            "ok": False,
            "group": "g",
            "runs": [
                {
                    **_limited(
                        {"five_hour": {"utilization": 1.0, "resetsAt": "2999-01-01T00:00:00Z"}}
                    ),
                    "error": "You've hit your session limit",
                    "runId": "r1",
                }
            ],
        }

    monkeypatch.setattr("h_cli.commands.delegate.local_runtime.run_job", fake_run_job)
    monkeypatch.setattr(
        "h_cli.commands.delegate.workspace.assert_managed", lambda p, allow_external=False: p
    )
    result = runner.invoke(app, ["delegate", "say hi", "--agent", "claude", "--cwd", str(tmp_path)])
    assert result.exit_code == 1
    assert "usage-limited: resumes after" in result.output and "(5h window)" in result.output
