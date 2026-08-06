"""h workflow run --direct: the same composition, executed on the direct substrate.

The service path is respx-mocked in test_workflow_run.py; here the boundary is the direct
runner's stdin, so the job dict handed to it is what these tests pin.
"""

import shutil
import subprocess
from typing import Any

import pytest
from typer.testing import CliRunner

from h_cli.main import app

runner = CliRunner()

needs_helm = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm not on PATH (renders cli/charts)"
)


def _all_output(result) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass
    return out


@pytest.fixture
def captured_job(monkeypatch) -> list[dict[str, Any]]:
    """Intercept the job at the runner boundary and answer with a successful envelope."""
    jobs: list[dict[str, Any]] = []

    def fake_run_job(job: dict[str, Any], bin_path=None) -> dict[str, Any]:
        jobs.append(job)
        return {
            "ok": True,
            "group": job["group"],
            "results": {"answer": {"output": "the answer", "structured": {"answer": "42"}}},
        }

    monkeypatch.setattr("h_cli.commands.workflow.direct_runtime.run_job", fake_run_job)
    return jobs


@needs_helm
def test_direct_renders_the_template_and_sends_its_steps(captured_job) -> None:
    """No saved-workflow store is read: the argument names a TEMPLATE and the rendered definition
    IS the artifact — the same one the service path would have POSTed."""
    result = runner.invoke(app, ["workflow", "run", "answer", "--direct", "-p", "task=why?"])

    assert result.exit_code == 0, _all_output(result)
    job = captured_job[0]
    assert job["kind"] == "workflow"
    assert job["steps"], "the rendered definition's steps must reach the runner"
    assert job["params"]["task"] == "why?"
    # Fire-time identity rides as params exactly as it does on the service substrate.
    assert job["params"]["runActivity"] == "run-claude"
    assert job["group"].startswith("answer-")
    assert "the answer" in _all_output(result)


@needs_helm
def test_direct_uses_the_invoking_checkout_and_honours_instance_id(captured_job) -> None:
    result = runner.invoke(
        app, ["workflow", "run", "answer", "--direct", "-p", "task=q", "--instance-id", "my-run"]
    )
    assert result.exit_code == 0, _all_output(result)
    job = captured_job[0]
    assert job["group"] == "my-run"
    # The git TOPLEVEL of the invoking directory — asserted structurally, not by directory NAME:
    # the suite legitimately runs from a worktree (a chain member's checkout is named after the
    # run, not after the repo), and a name-based assertion failed there while the code was correct.
    assert (
        job["repoPath"]
        == subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
        ).stdout.strip()
    )
    assert "withSetup" not in job


@needs_helm
def test_direct_with_setup_opts_in(captured_job) -> None:
    result = runner.invoke(
        app, ["workflow", "run", "answer", "--direct", "-p", "task=q", "--with-setup"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["withSetup"] is True


@needs_helm
def test_direct_expands_an_agent_roster_into_a_panel(captured_job) -> None:
    """A roster panelizes the definition CLI-side, exactly as on the service substrate — the
    executor gains nothing: it just sees a parallel group."""
    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            "answer",
            "--direct",
            "-p",
            "task=q",
            "--agent",
            "claude",
            "--agent",
            "codex",
        ],
    )
    assert result.exit_code == 0, _all_output(result)
    steps = captured_job[0]["steps"]
    group = next((s for s in steps if "parallel" in s), None)
    assert group, f"a roster must produce a parallel group, got {steps}"
    assert len(group["parallel"]) == 2


# Refusing by NAME is the boundary between the substrates. Silently ignoring --cron would report a
# recurrence that was never armed; the message must say which engine the flag needs.
@pytest.mark.parametrize(
    "flag",
    [
        ["--cron", "@daily"],
        ["--watch"],
        ["--budget", "10m"],
        ["--retry", "2"],
        ["--at", "2026-08-07T09:00:00Z"],
        ["--in", "30m"],
        ["--fallback-agent", "codex"],
        ["--fresh"],
        ["--via", "claude-agent"],
    ],
)
def test_direct_refuses_flags_that_need_an_engine(flag, captured_job) -> None:
    result = runner.invoke(app, ["workflow", "run", "answer", "--direct", "-p", "task=q", *flag])

    assert result.exit_code == 1
    output = _all_output(result)
    assert flag[0] in output
    assert "engines" in output
    assert captured_job == [], "nothing may run when a flag was refused"


def test_with_setup_without_direct_is_refused(captured_job) -> None:
    result = runner.invoke(app, ["workflow", "run", "answer", "--with-setup", "-p", "task=q"])
    assert result.exit_code == 1
    assert "--direct" in _all_output(result)


@needs_helm
def test_a_failed_step_exits_nonzero_and_names_the_step(monkeypatch) -> None:
    monkeypatch.setattr(
        "h_cli.commands.workflow.direct_runtime.run_job",
        lambda job, bin_path=None: {
            "ok": False,
            "group": job["group"],
            "results": {},
            "failedStep": "answer",
            "error": "output contract declared but the agent output has no fenced ```json block",
        },
    )
    result = runner.invoke(app, ["workflow", "run", "answer", "--direct", "-p", "task=q"])

    assert result.exit_code == 1
    output = _all_output(result)
    assert "answer" in output
    assert "fenced" in output
