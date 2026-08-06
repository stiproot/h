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
