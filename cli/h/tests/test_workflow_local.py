"""h workflow run --local: the same composition, executed on the local substrate.

The service path is respx-mocked in test_workflow_run.py; here the boundary is the local
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

    monkeypatch.setattr("h_cli.commands.workflow.local_runtime.run_job", fake_run_job)
    # The journal preflight reaches for the fabric (a real socket) — stubbed like the runner,
    # so these tests pin the JOB the driver hands over, not the fabric's liveness.
    monkeypatch.setattr(
        "h_cli.commands.workflow._journal_preflight",
        lambda resume: {"url": "nats://stub:4222", **({"resume": True} if resume else {})},
    )
    return jobs


@needs_helm
def test_local_renders_the_template_and_sends_its_steps(captured_job) -> None:
    """No saved-workflow store is read: the argument names a TEMPLATE and the rendered definition
    IS the artifact — the same one the service path would have POSTed."""
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=why?"])

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
def test_local_uses_the_invoking_checkout_and_honours_instance_id(captured_job) -> None:
    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--instance-id", "my-run"]
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
def test_local_with_setup_opts_in(captured_job) -> None:
    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--with-setup"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["withSetup"] is True


@needs_helm
def test_local_expands_an_agent_roster_into_a_panel(captured_job) -> None:
    """A roster panelizes the definition CLI-side, exactly as on the service substrate — the
    executor gains nothing: it just sees a parallel group."""
    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            "answer",
            "--local",
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
        ["--retry", "2"],
        ["--fallback-agent", "codex"],
        ["--fresh"],
        ["--via", "claude-agent"],
    ],
)
def test_local_refuses_flags_that_need_an_engine(flag, captured_job) -> None:
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=q", *flag])

    assert result.exit_code == 1
    output = _all_output(result)
    assert flag[0] in output
    assert "engines" in output
    assert captured_job == [], "nothing may run when a flag was refused"


def test_local_budget_is_enforced_by_the_DRIVER_not_refused(captured_job) -> None:
    """--budget on a foreground --local run bounds it between steps rather than being refused.

    The guarantee is weaker than the watcher's by one step and says so: the driver declines to
    START more work past the deadline but cannot kill a running agent (the per-step timeout bounds
    that). It is the same rule the chain-wide budget already applies between stages — one rule in
    two places, rather than a flag that means different things depending on where you type it.
    """
    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--budget", "10m"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["budgetMs"] == 600_000


def test_local_still_refuses_retry_and_fallback(captured_job) -> None:
    # Both RE-FIRE, which needs an engine that outlives the run. Nothing outlives a foreground
    # shell, so these stay refused even though the watcher now exists.
    for flag in (["--retry", "2"], ["--fallback-agent", "codex"]):
        result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=q", *flag])
        assert result.exit_code == 1, flag
        assert flag[0] in _all_output(result)
    assert captured_job == []


def test_local_cron_arms_via_the_RUN_not_the_edge(captured_job) -> None:
    """--cron --local passes armCron to the run rather than writing a cron row here.

    §10 is the invariant under test: a workflow never recurs itself, and the EDGE does not write
    cron rows — the run registers its own recurrence in its closing bracket. Arming from the CLI
    would be the same shortcut the service substrate deliberately does not take.
    """
    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            "answer",
            "--local",
            "-p",
            "task=q",
            "-p",
            "repo=o/r",
            "-p",
            "slug=x",
            "--cron",
            "*/30 * * * *",
        ],
    )
    assert result.exit_code == 0, _all_output(result)
    assert captured_job, "the run must still execute — the cron is armed by its closing bracket"
    assert captured_job[0]["armCron"]["cadence"] == "*/30 * * * *"
    # And it must write a wf:run row, or the engine re-firing it cannot observe the run it fired.
    assert captured_job[0]["wf"] == {"repo": "o/r", "slug": "x", "workflow": "answer"}


def test_local_cron_without_repo_slug_is_refused_before_any_work(captured_job) -> None:
    # A recur cron is keyed <repo>:<slug>:<workflow>. Refusing up front beats running the work and
    # failing at the closing bracket, having spent an agent run.
    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--cron", "*/30 * * * *"]
    )
    assert result.exit_code == 1
    assert "needs repo and slug" in _all_output(result)
    assert captured_job == []


def test_local_at_and_in_ARM_a_schedule_rather_than_being_refused(
    monkeypatch, captured_job
) -> None:
    """--at/--in moved from refused to available when the local schedule engine landed.

    They used to sit in the list above. The move is the point of the plan's refusal
    re-classification: a `pending` refusal names the machinery it waits for, and when that
    machinery arrives the refusal has to go — a flag still refused after its engine exists is a
    capability nobody knows they have.
    """
    from h_cli.commands import workflow as workflow_cmd

    armed: list[dict] = []
    monkeypatch.setattr(workflow_cmd, "_fabric_preflight", lambda: None)
    monkeypatch.setattr(workflow_cmd, "_relay_attached", lambda: True)
    monkeypatch.setattr(
        workflow_cmd.local_runtime,
        "registry",
        lambda op, **fields: (armed.append({"op": op, **fields}), {"schedId": fields.get("id")})[1],
    )

    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--in", "30m"]
    )

    assert result.exit_code == 0, _all_output(result)
    assert armed and armed[0]["op"] == "sched.arm"
    # The duration rides through UNRESOLVED: `resolveFireAt` in engine-core owns what "in 30m"
    # means, so both substrates answer with the same instant.
    assert armed[0]["in"] == "30m"
    # A scheduled fire ARMS; it must not also run now.
    assert captured_job == []


def test_local_schedule_warns_when_no_relay_will_drain_it(monkeypatch, captured_job) -> None:
    from h_cli.commands import workflow as workflow_cmd

    monkeypatch.setattr(workflow_cmd, "_fabric_preflight", lambda: None)
    monkeypatch.setattr(workflow_cmd, "_relay_attached", lambda: False)
    monkeypatch.setattr(
        workflow_cmd.local_runtime, "registry", lambda op, **fields: {"schedId": fields.get("id")}
    )

    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--in", "30m"]
    )
    # Arming into a queue nobody drains is a silent no-op — the one failure mode a scheduled fire
    # has that an immediate run does not.
    assert "no relay attached" in _all_output(result)


def test_with_setup_without_local_is_refused(captured_job) -> None:
    result = runner.invoke(app, ["workflow", "run", "answer", "--with-setup", "-p", "task=q"])
    assert result.exit_code == 1
    assert "--local" in _all_output(result)


@needs_helm
def test_a_failed_step_exits_nonzero_and_names_the_step(monkeypatch) -> None:
    monkeypatch.setattr(
        "h_cli.commands.workflow.local_runtime.run_job",
        lambda job, bin_path=None: {
            "ok": False,
            "group": job["group"],
            "results": {},
            "failedStep": "answer",
            "error": "output contract declared but the agent output has no fenced ```json block",
        },
    )
    monkeypatch.setattr(
        "h_cli.commands.workflow._journal_preflight", lambda resume: {"url": "nats://stub:4222"}
    )
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=q"])

    assert result.exit_code == 1
    output = _all_output(result)
    assert "answer" in output
    assert "fenced" in output


@needs_helm
def test_local_composes_several_templates_without_a_registry(captured_job) -> None:
    """The point of composing inline: the local substrate has NO saved-workflow store, so before
    --inline took several operands an `implement ⊕ verify` composition was unreachable here — it
    could only be run by first publishing it to a registry the substrate does not have."""
    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            "implement",
            "create-pr",
            "--inline",
            "--local",
            "-p",
            "slug=x",
            "-p",
            "spec=a spec",
        ],
    )

    assert result.exit_code == 0, _all_output(result)
    job = captured_job[0]
    step_ids = [s["id"] for s in job["steps"]]
    assert "implement" in step_ids
    # Both atoms reached the runner as ONE definition, base first.
    assert "create-pr" in step_ids
    assert step_ids.index("implement") < step_ids.index("create-pr")


@needs_helm
def test_local_composition_still_refuses_a_bare_overlay(captured_job) -> None:
    """Only the FIRST operand must stand alone; leading with an overlay has no base to extend."""
    result = runner.invoke(
        app, ["workflow", "run", "verify", "implement", "--inline", "--local", "-p", "slug=x"]
    )

    assert result.exit_code == 1
    assert "overlay" in _all_output(result)
    assert not captured_job


@needs_helm
def test_local_journals_by_default_and_no_journal_opts_out(captured_job) -> None:
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=q"])
    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["journal"] == {"url": "nats://stub:4222"}

    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "--no-journal", "-p", "task=q"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert "journal" not in captured_job[1]


@needs_helm
def test_resume_reuses_the_journaled_instance(captured_job) -> None:
    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            "answer",
            "--local",
            "--resume",
            "answer-260814-000000",
            "-p",
            "task=q",
        ],
    )
    assert result.exit_code == 0, _all_output(result)
    job = captured_job[0]
    assert job["group"] == "answer-260814-000000"
    assert job["journal"] == {"url": "nats://stub:4222", "resume": True}


def test_workflow_resume_and_no_journal_refusals() -> None:
    """Refusals by name — the journal flags are the local substrate's surface, nothing else's."""
    result = runner.invoke(app, ["workflow", "run", "answer", "--resume", "g"])
    assert result.exit_code == 1
    assert "--resume applies to --local only" in _all_output(result)

    result = runner.invoke(app, ["workflow", "run", "answer", "--no-journal"])
    assert result.exit_code == 1
    assert "--no-journal applies to --local only" in _all_output(result)

    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "--resume", "g", "--no-journal"]
    )
    assert result.exit_code == 1
    assert "drop --no-journal" in _all_output(result)

    result = runner.invoke(
        app, ["workflow", "run", "answer", "--local", "--resume", "g", "--instance-id", "x"]
    )
    assert result.exit_code == 1
    assert "drop --instance-id" in _all_output(result)


# --- h workflow publish --local -------------------------------------------------


@pytest.fixture
def captured_registry(monkeypatch) -> list[dict[str, Any]]:
    """Intercept the registry op the local publish issues, and answer as the runner would."""
    calls: list[dict[str, Any]] = []

    def fake_registry(op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"op": op, **kwargs})
        return {"saved": kwargs["key"]}

    monkeypatch.setattr("h_cli.commands.workflow.local_runtime.registry", fake_registry)
    return calls


@needs_helm
def test_publish_local_saves_the_rendered_definition_into_the_local_store(
    captured_registry,
) -> None:
    """The local store is what gives a local cron or trigger a KEY to fire: publish renders the
    template in publish mode and saves the definition, exactly as the service path does."""
    result = runner.invoke(app, ["workflow", "publish", "answer", "--local"])

    assert result.exit_code == 0, _all_output(result)
    assert captured_registry[0]["op"] == "workflows.save"
    assert captured_registry[0]["key"] == "answer"
    saved = captured_registry[0]["workflow"]
    assert saved["key"] == "answer"
    assert [s["id"] for s in saved["steps"]] == ["answer"]
    # Publish mode leaves the fire-time identity open as params, so --agent works at fire time.
    assert saved["params"]["runActivity"] == "run-claude"
    assert saved["outputs"]  # the contract rides with the definition


@needs_helm
def test_publish_local_refuses_workflow_svcs_row_machinery(captured_registry) -> None:
    """--schedule/--workspace-id/--disabled are fields of workflow-svc's saved-workflow ROW, read
    by its cron tick. The local store holds definitions; a local recurrence is armed by the RUN."""
    for flag in (["--schedule", "*/5 * * * *"], ["--workspace-id", "w"], ["--disabled"]):
        result = runner.invoke(app, ["workflow", "publish", "answer", "--local", *flag])
        assert result.exit_code == 1, _all_output(result)
        out = " ".join(_all_output(result).split())
        assert f"{flag[0]} applies to workflow-svc's store, not --local" in out
        assert "h workflow run <key> --local --cron" in out
    assert captured_registry == []


def _envelope_with_two_checked_steps(ok: bool) -> dict[str, Any]:
    return {
        "ok": ok,
        "group": "g",
        "results": {
            "params": {"slug": "x"},
            "worktree": {"worktreePath": "/wt"},
            "implement": {
                "output": "did the work\n```json\n{}\n```",
                "structured": {
                    "gate": "passed",
                    "baseline": {"failures": 3},
                    "final": {"failures": 3},
                },
            },
            "create-pr": {
                "output": "opened\n```json\n{}\n```",
                "structured": {"pr": "https://github.com/o/r/pull/9", "base": "beta"},
            },
        },
        **({} if ok else {"failedStep": "create-pr", "error": "boom"}),
    }


@pytest.mark.parametrize("ok", [True, False])
def test_local_prints_every_step_s_validated_block_not_only_the_final_one(
    monkeypatch, captured_job, ok: bool
) -> None:
    """A composition's contract-carrying steps each end with a CHECKED block — verify's gate and
    counts on the implement step, the PR's base as GitHub holds it on create-pr. A driver deciding
    whether to merge needs all of them, and before this only the final step's transcript printed,
    so verify's gate lived only in the ledger. One line per step, in order; still printed when the
    run failed, because the steps that completed still reported."""
    monkeypatch.setattr(
        "h_cli.commands.workflow.local_runtime.run_job",
        lambda job, bin_path=None: _envelope_with_two_checked_steps(ok),
    )
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=q"])

    assert result.exit_code == (0 if ok else 1), _all_output(result)
    output = _all_output(result)
    implement_line = next(line for line in output.splitlines() if line.startswith("implement ▸"))
    create_pr_line = next(line for line in output.splitlines() if line.startswith("create-pr ▸"))
    assert '"gate":"passed"' in implement_line and '"failures":3' in implement_line
    assert '"base":"beta"' in create_pr_line
    assert output.index("implement ▸") < output.index("create-pr ▸")
    assert "worktree ▸" not in output, "a step without a contract has nothing checked to print"


def test_local_json_prints_the_envelope_and_nothing_else_on_stdout(monkeypatch, captured_job):
    """--json is the machine-readable form: the full result envelope on stdout, so a shepherding
    session reads every step's `structured` field without parsing rich output."""
    import json

    monkeypatch.setattr(
        "h_cli.commands.workflow.local_runtime.run_job",
        lambda job, bin_path=None: _envelope_with_two_checked_steps(True),
    )
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=q", "--json"])

    assert result.exit_code == 0, _all_output(result)
    envelope = json.loads(result.stdout)  # the WHOLE of stdout parses: nothing else is on it
    assert envelope["results"]["implement"]["structured"]["gate"] == "passed"
    assert envelope["results"]["create-pr"]["structured"]["base"] == "beta"


def test_json_without_local_is_refused(captured_job) -> None:
    result = runner.invoke(app, ["workflow", "run", "answer", "--json", "-p", "task=q"])

    assert result.exit_code == 1
    assert "--json applies to --local only" in _all_output(result)
    assert captured_job == []
