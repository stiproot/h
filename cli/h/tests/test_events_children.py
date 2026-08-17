"""`h events up` supervises the local substrate's THREE processes, and says what each absence costs.

The split under test is decision 1 of the local-engine-parity plan: nats-server and the ENGINE HOST
are infrastructure and come up together, while the relay is work and is opt-in. What makes that
worth a test is the failure it prevents — a fabric with no engine host accepts cron registrations
that nothing ever fires, which is silent.
"""

from typer.testing import CliRunner

from h_cli.main import app

runner = CliRunner()


def _output(result) -> str:
    return result.stdout + (result.stderr or "")


def test_status_names_what_each_absence_costs(monkeypatch) -> None:
    from h_cli.infrastructure import events_fabric as fabric

    monkeypatch.setattr(fabric, "fabric_running", lambda timeout=0.5: False)
    monkeypatch.setattr(fabric, "child_status", lambda name: {"running": False, "log": "/tmp/x"})

    result = runner.invoke(app, ["events", "status"])
    assert result.exit_code == 0
    out = _output(result)
    # "down" alone does not tell an operator whether what they registered will happen.
    assert "registered crons and schedules will not fire" in out
    assert "fires will queue with nothing to run them" in out


def test_up_without_relay_warns_that_fires_will_queue(monkeypatch) -> None:
    from h_cli.commands import events as events_cmd
    from h_cli.infrastructure import events_fabric as fabric

    monkeypatch.setattr(
        fabric,
        "start_server",
        lambda: {"running": True, "url": "nats://x", "pid": 1, "started": True},
    )
    monkeypatch.setattr(events_cmd.asyncio, "run", lambda coro: coro.close())
    started: list[str] = []
    monkeypatch.setattr(
        fabric,
        "start_child",
        lambda name, argv, env=None: (
            started.append(name),
            {"running": True, "pid": 2, "started": True},
        )[1],
    )

    result = runner.invoke(app, ["events", "up"])
    assert result.exit_code == 0
    # The engine host comes up WITH the fabric; the relay does not.
    assert started == ["engines"]
    assert "cron fires QUEUE until one drains them" in _output(result)


def test_up_with_relay_supervises_one(monkeypatch) -> None:
    from h_cli.commands import events as events_cmd
    from h_cli.infrastructure import events_fabric as fabric

    monkeypatch.setattr(
        fabric,
        "start_server",
        lambda: {"running": True, "url": "nats://x", "pid": 1, "started": True},
    )
    monkeypatch.setattr(events_cmd.asyncio, "run", lambda coro: coro.close())
    started: list[str] = []
    monkeypatch.setattr(
        fabric,
        "start_child",
        lambda name, argv, env=None: (
            started.append(name),
            {"running": True, "pid": 2, "started": True},
        )[1],
    )

    result = runner.invoke(app, ["events", "up", "--with-relay"])
    assert result.exit_code == 0
    assert started == ["engines", "relay"]


def test_down_stops_children_before_the_server(monkeypatch) -> None:
    from h_cli.infrastructure import events_fabric as fabric

    order: list[str] = []
    monkeypatch.setattr(fabric, "stop_child", lambda name: (order.append(name), True)[1])
    monkeypatch.setattr(fabric, "stop_server", lambda: (order.append("server"), True)[1])

    result = runner.invoke(app, ["events", "down"])
    assert result.exit_code == 0
    # An engine host that outlived its fabric would spend every tick failing to reach it, and its
    # lease would keep a replacement out until the TTL lapsed.
    assert order == ["relay", "engines", "server"]
