"""`h doctor`'s agent rows — presence is necessary, readiness is what the operator asked about.

Doctor answered "can this agent run?" with `shutil.which` and printed `ok` for a binary that could
not authenticate. On 2026-09-01 that cost a two-agent review half its roster: codex reported ok,
the run started, codex died immediately for want of CODEX_AUTH_MODE=chatgpt, and the credentials
had been on disk the whole time. These tests pin the three states that replaced the guess — and
the fourth, UNKNOWN, which must never be collapsed into either of the others.
"""

import pytest

from h_cli.commands.doctor import _agent_row


@pytest.fixture(autouse=True)
def _on_path(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("h_cli.commands.doctor.shutil.which", lambda name: f"/usr/bin/{name}")


def test_a_binary_that_cannot_authenticate_is_not_ok() -> None:
    """THE regression. `ok` here is what sent a run to its death."""
    name, status, detail = _agent_row(
        "codex",
        {"codex": {"ready": False, "detail": "Missing OPENAI_API_KEY or CODEX_AUTH_MODE=chatgpt"}},
    )
    assert "no auth" in status
    assert "ok" not in status
    assert "CODEX_AUTH_MODE=chatgpt" in detail


def test_a_ready_agent_is_ok_and_shows_its_path() -> None:
    _, status, detail = _agent_row("claude", {"claude": {"ready": True, "detail": None}})
    assert "ok" in status
    assert detail == "/usr/bin/claude"


def test_a_missing_binary_is_missing_not_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """A binary that is not there cannot be an auth problem — the two need different fixes."""
    monkeypatch.setattr("h_cli.commands.doctor.shutil.which", lambda name: None)
    _, status, _ = _agent_row("pi", {"pi": {"ready": True, "detail": None}})
    assert "missing" in status


def test_an_unreachable_probe_reports_UNKNOWN_not_ok() -> None:
    """Answering from ignorance is the bug being fixed, not a milder form of it. An unbuilt runner
    must not resurrect the old `ok`."""
    _, status, detail = _agent_row("codex", None)
    assert "on PATH" in status
    assert "ok" not in status
    assert "no auth" not in status
    assert "auth unknown" in detail


def test_an_agent_the_probe_did_not_cover_is_UNKNOWN_too() -> None:
    """A probe from an older runner that knows fewer agents must not imply anything about the
    ones it did not answer for."""
    _, status, detail = _agent_row("codex", {"claude": {"ready": True, "detail": None}})
    assert "on PATH" in status
    assert "auth unknown" in detail


def test_a_ready_agent_never_leaks_the_detail_field() -> None:
    """The path is the useful detail when there is nothing to fix."""
    _, _, detail = _agent_row("openhands", {"openhands": {"ready": True, "detail": "stale"}})
    assert detail == "/usr/bin/openhands"
