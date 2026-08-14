"""h chain run --local: the same chain expression, sequenced in-process.

The registration path is covered in test_chain.py; here the boundary is the local runner's
stdin, so the chain job handed to it is what these tests pin.
"""

import shutil
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
    jobs: list[dict[str, Any]] = []

    def fake_run_job(job: dict[str, Any], bin_path=None) -> dict[str, Any]:
        jobs.append(job)
        return {
            "ok": True,
            "chain": job["group"],
            "status": "completed",
            "data": {"answer": "42"},
            "runs": [{"member": "answer", "stage": 0, "group": "g", "iteration": 0}],
        }

    monkeypatch.setattr("h_cli.commands.chain.local_runtime.run_job", fake_run_job)
    # The journal preflight reaches for the fabric (a real socket) — stubbed here exactly like
    # the runner, so these tests pin the JOB the driver hands over, not the fabric's liveness.
    # The stub mirrors the real contract: {url} + resume flag when continuing.
    monkeypatch.setattr(
        "h_cli.commands.chain._journal_preflight",
        lambda resume: {"url": "nats://stub:4222", **({"resume": True} if resume else {})},
    )
    return jobs


@needs_helm
def test_local_embeds_every_member_and_seeds_the_chain_data(captured_job) -> None:
    """No store is read: each member is composed on the fly, so every member carries `steps`."""
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "task=why?", "-w", "answer"]
    )

    assert result.exit_code == 0, _all_output(result)
    job = captured_job[0]
    assert job["kind"] == "chain"
    assert job["strategy"] == "sequential"
    assert all(m.get("steps") for m in job["members"]), "every member must embed its steps"
    assert all("key" not in m for m in job["members"]), "no member may reference a saved key"
    # The chain-level -p seeds the data the first member reads its inputs from; the implicit slug
    # rides underneath it.
    assert job["data"]["task"] == "why?"
    assert job["data"]["slug"] == "demo"
    assert job["group"].startswith("chain-demo-")


@needs_helm
def test_local_resolves_a_w_member_through_its_chart_template(captured_job) -> None:
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "task=q", "-w", "answer"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["members"][0]["steps"], "-w resolved to embedded steps, not a key"


@needs_helm
def test_local_carries_stages_and_threading_mappings(captured_job) -> None:
    """A parallel stage and its namespaced captures reach the runner unchanged — the executor
    reads the SAME mappings the durable engine would have."""
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "-p",
            "task=q",
            "-w",
            "answer",
            "--id",
            "a",
            "--capture",
            "answer=answer",
            "--parallel",
            "-w",
            "answer",
            "--id",
            "b",
            "--capture",
            "answer=answer",
        ],
    )

    assert result.exit_code == 0, _all_output(result)
    members = captured_job[0]["members"]
    assert [m["stage"] for m in members] == [0, 0]
    assert [m["id"] for m in members] == ["a", "b"]
    assert all(m["captures"] == {"answer": "answer"} for m in members)


@needs_helm
def test_local_passes_the_loop_through(captured_job) -> None:
    """The canonical implement→review→revise loop. `implement-pr` is a PUBLISHED key with no
    single template, so on this substrate it composes from its atoms — which is what `-t` is for
    and what the refusal below tells you to do."""
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "--strategy",
            "loop-until-clean",
            "--max-iterations",
            "2",
            "-p",
            "spec=x",
            "-p",
            "repo=o/r",
            "-t",
            "implement",
            "create-pr",
            "-w",
            "review-pr",
            "-w",
            "revise-pr",
        ],
    )

    assert result.exit_code == 0, _all_output(result)
    # startCursor is the review member's STAGE.
    assert captured_job[0]["loop"] == {"startCursor": 1, "maxIterations": 2}


@needs_helm
def test_local_refuses_a_saved_key_with_no_template(captured_job) -> None:
    """`implement-pr` is published, not templated: there is no store to read it from here, so the
    refusal names the composition that does work rather than reaching for a service."""
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "spec=x", "-w", "implement-pr"]
    )
    assert result.exit_code == 1
    output = _all_output(result)
    assert "no chart template" in output
    assert "-t atoms" in output
    assert captured_job == []


@pytest.mark.parametrize(
    "flag", [["--after", "other"], ["--at", "2026-08-07T09:00:00Z"], ["--in", "30m"]]
)
def test_local_refuses_activation_gates(flag, captured_job) -> None:
    """Activation gates wait on a durable row — there is nothing here to wait."""
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-w", "answer", *flag]
    )
    assert result.exit_code == 1
    output = _all_output(result)
    assert flag[0] in output
    assert "engines" in output
    assert captured_job == []


@needs_helm
def test_local_refuses_a_cron_member(captured_job) -> None:
    """A cron member self-arms a recurrence; this substrate has no engine to service it."""
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "-p",
            "task=q",
            "-w",
            "answer",
            "--cron",
            "@daily",
        ],
    )
    assert result.exit_code == 1
    assert "cron engine" in _all_output(result)
    assert captured_job == []


@needs_helm
def test_an_exhausted_loop_exits_nonzero_and_says_why(monkeypatch) -> None:
    monkeypatch.setattr(
        "h_cli.commands.chain.local_runtime.run_job",
        lambda job, bin_path=None: {
            "ok": False,
            "chain": job["group"],
            "status": "exhausted",
            "note": "stopped after 2 iteration(s) (findings may remain)",
            "data": {},
            "runs": [],
        },
    )
    monkeypatch.setattr(
        "h_cli.commands.chain._journal_preflight", lambda resume: {"url": "nats://stub:4222"}
    )
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "task=q", "-w", "answer"]
    )

    assert result.exit_code == 1
    assert "findings may remain" in _all_output(result)


@needs_helm
def test_local_carries_the_chain_wide_budget_to_the_driver(captured_job) -> None:
    """A prefix --budget reaches the local driver as budgetMs — the local substrate mirrors the
    chain engine's wall clock rather than dropping it (a dropped budget reports a bound that was
    never armed). The per-MEMBER budget is refused separately: it is a watch policy."""
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "--budget",
            "30m",
            "-p",
            "task=q",
            "-w",
            "answer",
        ],
    )

    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["budgetMs"] == 30 * 60_000


@needs_helm
def test_local_defaults_the_budget_so_a_chain_is_never_unbounded(captured_job) -> None:
    """With no --budget the per-member default still rides, exactly as it does onto the chain row
    — an unbounded chain on the operator's own machine is the thing this closes."""
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "-p",
            "task=q",
            "-w",
            "answer",
            "-w",
            "answer",
        ],
    )

    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["budgetMs"] == 2 * 45 * 60_000


@needs_helm
def test_local_still_refuses_a_per_member_budget(captured_job) -> None:
    """The two positions keep their different answers: chain-wide is enforced here, per-member is
    refused because the watcher that would service it does not exist on this substrate."""
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "-p",
            "task=q",
            "-w",
            "answer",
            "--budget",
            "10m",
        ],
    )

    assert result.exit_code == 1
    out = " ".join(_all_output(result).split())
    assert "--budget" in out and "watcher engine" in out
    assert not captured_job


@needs_helm
def test_local_journals_by_default_and_no_journal_opts_out(captured_job) -> None:
    """The journal is the local substrate's durability: on unless deliberately declined."""
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "task=q", "-w", "answer"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert captured_job[0]["journal"] == {"url": "nats://stub:4222"}

    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "--no-journal",
            "-p",
            "task=q",
            "-w",
            "answer",
        ],
    )
    assert result.exit_code == 0, _all_output(result)
    assert "journal" not in captured_job[1]


@needs_helm
def test_resume_reuses_the_journaled_group_instead_of_minting_one(captured_job) -> None:
    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "--slug",
            "demo",
            "--local",
            "--resume",
            "chain-demo-260814-000000",
            "-p",
            "task=q",
            "-w",
            "answer",
        ],
    )
    assert result.exit_code == 0, _all_output(result)
    job = captured_job[0]
    assert job["group"] == "chain-demo-260814-000000"
    assert job["journal"] == {"url": "nats://stub:4222", "resume": True}


def test_resume_and_no_journal_are_local_only_and_exclusive() -> None:
    """Refusals by name: --resume/--no-journal are the local journal's surface, nothing else's."""
    result = runner.invoke(app, ["chain", "run", "--slug", "s", "--resume", "g", "-w", "answer"])
    assert result.exit_code == 1
    assert "--resume applies to --local only" in _all_output(result)

    result = runner.invoke(app, ["chain", "run", "--slug", "s", "--no-journal", "-w", "answer"])
    assert result.exit_code == 1
    assert "--no-journal applies to --local only" in _all_output(result)

    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "s", "--local", "--resume", "g", "--no-journal", "-w", "answer"],
    )
    assert result.exit_code == 1
    assert "drop --no-journal" in _all_output(result)


@needs_helm
def test_journal_preflight_refusal_names_the_outs(monkeypatch) -> None:
    """A missing nats-server refuses loud BEFORE any agent fires, and names --no-journal."""
    from h_cli.infrastructure import events_fabric

    def boom() -> dict:
        raise events_fabric.FabricError("nats-server is not installed (…)")

    monkeypatch.setattr("h_cli.infrastructure.events_fabric.ensure_journal_ready", boom)
    ran: list = []
    monkeypatch.setattr(
        "h_cli.commands.chain.local_runtime.run_job", lambda job, bin_path=None: ran.append(job)
    )
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "task=q", "-w", "answer"]
    )
    assert result.exit_code == 1
    out = _all_output(result)
    assert "journal preflight failed" in out
    assert "--no-journal" in out
    assert ran == [], "no agent work may start after a failed preflight"
