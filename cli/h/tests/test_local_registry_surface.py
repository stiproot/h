"""`--local` on the registry read commands: what answers, and what refuses.

The interesting assertions here are the REFUSALS. A `--local` read whose registry does not exist
yet could answer with an empty table, and that would assert "none registered" when the truth is
"no registry here" — the quiet kind of wrong. So each one must exit non-zero and name the engine
it waits for.
"""

from typer.testing import CliRunner

from h_cli.main import app

runner = CliRunner()


def _output(result) -> str:
    return result.stdout + (result.stderr or "")


def test_cron_list_local_ANSWERS_now_that_the_engine_exists(monkeypatch) -> None:
    """`h cron list --local` moved from refusing to answering when the cron engine landed.

    The refusal it replaced named the engine it was waiting for. That naming is what makes this
    transition checkable at all — a `pending` refusal whose machinery has arrived is a capability
    nobody knows they have.
    """
    from h_cli.commands import cron as cron_cmd

    monkeypatch.setattr(cron_cmd.local_runtime, "registry", lambda op, **_: [])
    result = runner.invoke(app, ["cron", "list", "--local"])
    assert result.exit_code == 0, _output(result)
    # The DISCOVERY half is still service-only, and says so rather than showing an empty table —
    # "none registered" and "not here yet" are different facts.
    assert "service-substrate only" in _output(result)


def test_chain_list_local_still_refuses() -> None:
    # The last pending registry: local chains are DRIVER-sequenced today (they work, journaled),
    # so chain:sub has no local counterpart until increment 3 hosts them on the engine.
    result = runner.invoke(app, ["chain", "list", "--local"])
    assert result.exit_code == 1
    assert "chain engine" in _output(result)


def test_watch_list_local_ANSWERS_now_that_the_watcher_exists(monkeypatch) -> None:
    from h_cli.commands import watch as watch_cmd

    monkeypatch.setattr(watch_cmd.local_runtime, "registry", lambda op, **_: [])
    result = runner.invoke(app, ["watch", "list", "--local"])
    assert result.exit_code == 0, _output(result)


def test_agents_budget_local_refuses_because_no_watcher_enforces_it() -> None:
    # A budget is a watcher BEHAVIOUR, not a stored number. Storing one with no watcher would arm
    # a fence nobody enforces.
    result = runner.invoke(app, ["agents", "budget", "codex", "5", "--local"])
    assert result.exit_code == 1
    out = _output(result)
    assert "WATCHER" in out
    assert "h agents deny --local" in out


def test_agents_deny_local_is_offered() -> None:
    # The fence that DOES work locally must be reachable — the refusal above points at it.
    result = runner.invoke(app, ["agents", "deny", "--help"])
    assert result.exit_code == 0
    assert "--local" in _output(result)
