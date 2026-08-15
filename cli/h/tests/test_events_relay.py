"""The relay's step transition: compose-on-fire → execute → decide.

The boundary is the local runner's job seam, monkeypatched exactly as in test_workflow_local.py —
these tests prove the DECISION table (hand off / resolve / exhaust / fail), not the runner.
"""

import pytest

from h_cli.commands import events
from h_cli.infrastructure import events_protocol as protocol

DEFINITION = {
    "params": {"runActivity": "run-claude", "agentId": "claude-agent"},
    "steps": [{"id": "answer", "activity": "{{params.runActivity}}", "input": {}}],
}


def _descriptor(**overrides):
    base = protocol.seed_descriptor(
        template="answer",
        params={"task": "start"},
        agent="claude",
        max_steps=3,
        group="loop-t",
    )
    return {**base, **overrides}


@pytest.fixture
def runner(monkeypatch):
    """Patch compose + execute; the test sets `runner.envelope` and reads `runner.job`."""

    class Recorder:
        envelope: dict = {"ok": True, "results": {}}
        job: dict | None = None

    rec = Recorder()
    monkeypatch.setattr(events, "_render", lambda name: DEFINITION)
    monkeypatch.setattr(events, "repo_root", lambda cwd: "/repo")
    # Workspace provisioning is real git; these tests are about the DECISION table, so the cut is
    # stubbed here and exercised explicitly by the workspace tests below.
    monkeypatch.setattr(
        events.git,
        "worktree_ensure",
        lambda repo, path, branch, base_ref="main": path,
    )

    def fake_run_job(job):
        rec.job = job
        return rec.envelope

    monkeypatch.setattr(events.local_runtime, "run_job", fake_run_job)
    return rec


def _structured(structured):
    return {"ok": True, "results": {"answer": {"structured": structured}}}


def test_a_publish_hand_off_becomes_the_next_descriptor(runner) -> None:
    runner.envelope = _structured({"answer": "a1", "publish": {"task": "next", "agent": "codex"}})
    nxt, terminal = events.relay_step(_descriptor())
    assert terminal is None
    assert nxt is not None
    assert nxt["step"] == 2
    assert nxt["agent"] == "codex"
    assert nxt["params"]["task"] == "next"
    # The job ran under the loop's group with the identity expanded from the descriptor.
    assert runner.job["group"] == "loop-t"
    assert runner.job["params"]["runActivity"] == "run-claude"


def test_no_publish_resolves_the_loop(runner) -> None:
    runner.envelope = _structured({"answer": "done"})
    nxt, terminal = events.relay_step(_descriptor(step=2))
    assert nxt is None
    assert terminal["status"] == "resolved"
    assert terminal["answer"] == "done"
    assert terminal["steps"] == 2


def test_a_spent_budget_exhausts_with_the_pending_task_recorded(runner) -> None:
    runner.envelope = _structured({"answer": "partial", "publish": {"task": "more"}})
    nxt, terminal = events.relay_step(_descriptor(step=3))
    assert nxt is None
    assert terminal["status"] == "exhausted"
    assert terminal["pendingTask"] == "more"


def test_an_invalid_hand_off_fails_the_loop_loudly(runner) -> None:
    runner.envelope = _structured({"answer": "a", "publish": {"task": "x", "agent": "gpt-99"}})
    nxt, terminal = events.relay_step(_descriptor())
    assert nxt is None
    assert terminal["status"] == "failed"
    assert "gpt-99" in terminal["error"]


def test_a_failed_run_publishes_a_failed_terminal(runner) -> None:
    runner.envelope = {"ok": False, "error": "boom", "failedStep": "answer", "results": {}}
    nxt, terminal = events.relay_step(_descriptor())
    assert nxt is None
    assert terminal["status"] == "failed"
    assert terminal["error"] == "boom"
    assert terminal["failedStep"] == "answer"


def test_a_template_that_cannot_render_fails_without_running_anything(runner, monkeypatch) -> None:
    def broken(_name):
        raise events.RelayStepError("template 'answer' failed to render: boom")

    monkeypatch.setattr(events, "_render", broken)
    nxt, terminal = events.relay_step(_descriptor())
    assert nxt is None
    assert terminal["status"] == "failed"
    assert runner.job is None  # nothing executed


def test_terminal_carries_the_step_accounting(runner, monkeypatch) -> None:
    """A consumer reacting to a terminal must not need a second lookup for cost or output."""
    monkeypatch.setattr(events, "_render", lambda template: DEFINITION)
    runner.envelope = {
        "ok": True,
        "group": "loop-t",
        "results": {"answer": {"structured": {"answer": "done"}}},
        "runs": [{"step": "answer", "agent": "claude", "runId": "loop-t:claude:9", "costUsd": 1.5}],
    }
    _, terminal = events.relay_step(_descriptor())
    assert terminal["status"] == "resolved"
    assert terminal["runId"] == "loop-t:claude:9"
    assert terminal["costUsd"] == 1.5


def test_failed_terminal_still_carries_accounting(runner, monkeypatch) -> None:
    """The failed run is the one whose cost and output a driver most needs to see."""
    monkeypatch.setattr(events, "_render", lambda template: DEFINITION)
    runner.envelope = {
        "ok": False,
        "group": "loop-t",
        "error": "agent exploded",
        "results": {},
        "runs": [{"step": "answer", "agent": "claude", "runId": "loop-t:claude:9", "costUsd": 0.2}],
    }
    _, terminal = events.relay_step(_descriptor())
    assert terminal["status"] == "failed"
    assert terminal["costUsd"] == 0.2
    assert terminal["runId"] == "loop-t:claude:9"


def test_relay_runs_in_a_worktree_of_the_pinned_repo(runner, monkeypatch, tmp_path) -> None:
    """The workspace comes from the relay's PINNED clone, never from the process's cwd.

    The failure this pins happened live 2026-08-10: a relay started with the wrong cwd handed an
    agent a workspace that did not match its task, and the agent went hunting the filesystem and
    wrote into a DIFFERENT clone of the target repo.
    """
    cut: dict = {}

    def fake_ensure(repo, worktree_path, branch, base_ref="main"):
        cut.update(repo=repo, path=worktree_path, branch=branch)
        return worktree_path

    monkeypatch.setattr(events.git, "worktree_ensure", fake_ensure)
    monkeypatch.setattr(events, "repo_root", lambda cwd: "/wherever/the/process/happened/to/start")
    runner.envelope = {"ok": True, "results": {"answer": {"structured": {"answer": "done"}}}}

    events.relay_step(_descriptor(), repo=tmp_path / "h-clone")

    assert cut["repo"] == tmp_path / "h-clone"
    assert cut["branch"] == "local/loop-t"
    assert runner.job["repoPath"] == str(cut["path"])
    assert "/wherever" not in runner.job["repoPath"]


def test_in_place_relay_runs_in_the_clone_itself(runner, monkeypatch, tmp_path) -> None:
    """`--in-place` is the read-only escape hatch: no worktree is cut at all."""
    monkeypatch.setattr(
        events.git,
        "worktree_ensure",
        lambda *a, **k: pytest.fail("in-place must not cut a worktree"),
    )
    runner.envelope = {"ok": True, "results": {"answer": {"structured": {"answer": "done"}}}}
    events.relay_step(_descriptor(), repo=tmp_path / "clone", in_place=True)
    assert runner.job["repoPath"] == str(tmp_path / "clone")


def test_unprovisionable_workspace_is_a_terminal_not_a_crash(runner, monkeypatch, tmp_path) -> None:
    """A workspace that cannot be cut must report on the stream — the seeder may be long gone."""

    def boom(*a, **k):
        raise events.git.GitError("fatal: not a git repository")

    monkeypatch.setattr(events.git, "worktree_ensure", boom)
    next_descriptor, terminal = events.relay_step(_descriptor(), repo=tmp_path / "nope")
    assert next_descriptor is None
    assert terminal["status"] == "failed"
    assert "could not provision a workspace" in terminal["error"]


def test_relay_step_journals_per_step_and_resumes_on_redelivery(monkeypatch) -> None:
    """Each step journals under its own key (the loop group is shared; the definitions are not),
    and a redelivered step RESUMES that journal instead of restarting."""
    from h_cli.infrastructure import events_fabric as fabric

    jobs: list[dict] = []

    def fake_run_job(job, bin_path=None):
        jobs.append(job)
        return {
            "ok": True,
            "group": job["group"],
            "results": {"answer": {"output": "x", "structured": {"answer": "done"}}},
        }

    monkeypatch.setattr(events, "_render", lambda template: DEFINITION)
    monkeypatch.setattr(events.local_runtime, "run_job", fake_run_job)
    monkeypatch.setattr(events, "group_workspace", lambda repo, group, in_place: "/ws")
    monkeypatch.setattr(events, "repo_root", lambda cwd: "/repo")

    events.relay_step(_descriptor(step=2))
    assert jobs[0]["journal"] == {"url": fabric.EVENTS_URL, "group": f"{jobs[0]['group']}-s2"}

    events.relay_step(_descriptor(step=2), redelivered=True)
    assert jobs[1]["journal"]["resume"] is True
    assert jobs[1]["journal"]["group"] == f"{jobs[1]['group']}-s2"
