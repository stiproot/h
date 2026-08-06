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
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--local", "-p", "task=q", "-w", "answer"]
    )

    assert result.exit_code == 1
    assert "findings may remain" in _all_output(result)
