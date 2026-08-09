"""h events — the local substrate's event fabric and its relay.

`up|down|status` manage the fabric (one `nats-server -js` child, operator-provisioned binary);
`publish` seeds a fire descriptor onto `h.task.<queue>`; `serve` runs the RELAY — a durable pull
consumer that composes the named template on fire (exactly as `--local` does), executes it through
the local runner, and forwards the agent's declared `publish` hand-off as the next task until the
loop resolves or its mandatory step budget is spent; `tail` watches the subjects live.

The relay is a trigger host, not an engine: it fires jobs and forwards declared publishes. It
supervises nothing, recurs nothing, sequences nothing — those stay engine work on the service
substrate.
"""

import asyncio
import json
from pathlib import Path
from typing import Annotated, Any

import typer
import yaml
from rich.console import Console

# One agent step per relay hand-off shares the local path's per-step wall-clock budget.
from h_cli.commands.workflow import LOCAL_STEP_TIMEOUT_MS
from h_cli.config import AGENT_IDENTITY, AGENT_RUNS_DIR, LOCAL_WORKTREES_DIR
from h_cli.infrastructure import events_fabric as fabric
from h_cli.infrastructure import events_protocol as protocol
from h_cli.infrastructure import helm, local_runtime
from h_cli.infrastructure.local_runtime import LocalRunError, group_id, repo_root
from h_cli.params import parse_params

app = typer.Typer(no_args_is_help=True, help="The local substrate's event fabric (NATS JetStream).")
console = Console()
err_console = Console(stderr=True)


class RelayStepError(RuntimeError):
    """A step that cannot even be composed — reported as a failed terminal, never a crash."""


def _render(template: str) -> dict[str, Any]:
    """Publish-mode render, the relay's compose-on-fire — same artifact `--local` executes."""
    try:
        rendered = helm.render_workflow(template, values={"publish": "true"})
    except helm.HelmError as err:
        raise RelayStepError(f"template '{template}' failed to render: {err}") from err
    definition = yaml.safe_load(rendered) or {}
    if not isinstance(definition, dict) or not definition.get("steps"):
        raise RelayStepError(f"template '{template}' rendered no steps")
    return definition


def relay_step(
    descriptor: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """One relay transition: compose → execute → decide (hand off | resolve | exhaust | fail).

    Returns (next descriptor, terminal event) — at most one is set. Every failure is a published
    terminal event rather than an exception: the loop's outcome must land on `h.result.<group>`
    whatever went wrong, because the seeder may be long gone.
    """
    try:
        definition = _render(descriptor["template"])
    except RelayStepError as err:
        return None, protocol.terminal(descriptor, "failed", error=str(err))
    params = protocol.merged_params(definition.get("params") or {}, descriptor)
    try:
        envelope = local_runtime.run_job(
            {
                "kind": "workflow",
                "steps": definition["steps"],
                "params": params,
                "group": descriptor["group"],
                "runsDir": str(AGENT_RUNS_DIR),
                "timeoutMs": LOCAL_STEP_TIMEOUT_MS,
                "worktreeRoot": str(LOCAL_WORKTREES_DIR),
                "repoPath": repo_root(Path.cwd()),
            }
        )
    except LocalRunError as err:
        return None, protocol.terminal(descriptor, "failed", error=str(err))
    # Every terminal carries this step's accounting: what it spent and a runId to read it by.
    # A consumer reacting to the event should never need a second lookup to know either.
    spend = protocol.run_summary(envelope)
    if not envelope.get("ok"):
        return None, protocol.terminal(
            descriptor,
            "failed",
            error=str(envelope.get("error") or "run failed"),
            **({"failedStep": envelope["failedStep"]} if envelope.get("failedStep") else {}),
            **spend,
        )

    structured = protocol.loop_structured(envelope) or {}
    answer = structured.get("answer")
    publish = structured.get("publish")
    if publish is None:
        # No hand-off declared: the agent judged the loop done. This is the goal handshake.
        return None, protocol.terminal(descriptor, "resolved", answer=answer, **spend)
    problems = protocol.validate_publish(publish)
    if problems:
        return None, protocol.terminal(
            descriptor,
            "failed",
            error=f"invalid hand-off: {'; '.join(problems)}",
            answer=answer,
            **spend,
        )
    next_descriptor = protocol.hand_off(descriptor, publish)
    if next_descriptor is None:
        # Budget spent with work still declared — a stop, not a failure (loop-until-clean posture).
        return None, protocol.terminal(
            descriptor, "exhausted", answer=answer, pendingTask=publish["task"], **spend
        )
    return next_descriptor, None


@app.command()
def up() -> None:
    """Start the fabric (nats-server -js, detached) and ensure the h streams exist."""
    try:
        state = fabric.start_server()

        async def _ensure() -> None:
            nc = await fabric.connect()
            try:
                await fabric.ensure_streams(nc.jetstream())
            finally:
                await nc.drain()

        asyncio.run(_ensure())
    except fabric.FabricError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    verb = "started" if state.get("started") else "already up"
    console.print(f"fabric {verb}: {state['url']} (pid {state.get('pid')})")
    console.print(f"    store: {fabric.store_paths()['store']}")
    console.print("    relay: h events serve    seed: h events publish    watch: h events tail")


@app.command()
def down() -> None:
    """Stop the fabric. Streams and their messages survive on disk — `up` resumes them."""
    if fabric.stop_server():
        console.print("fabric stopped (JetStream state kept on disk)")
    else:
        console.print("[dim]fabric was not running[/dim]")


@app.command()
def status(
    as_json: Annotated[bool, typer.Option("--json", help="Machine-readable status.")] = False,
) -> None:
    """Fabric liveness, store paths, stream depths, and relay consumers."""
    paths = fabric.store_paths()
    body: dict[str, Any] = {
        "running": fabric.fabric_running(),
        "url": fabric.EVENTS_URL,
        "store": str(paths["store"]),
    }
    if body["running"]:
        try:
            body["streams"] = asyncio.run(fabric.stream_report())
        except fabric.FabricError as err:
            body["streamsError"] = str(err)
    if as_json:
        console.print_json(data=body)
        return
    state = "[green]up[/green]" if body["running"] else "[red]down[/red]"
    console.print(f"fabric {state} — {body['url']}  (store: {body['store']})")
    for row in body.get("streams", []):
        if not row.get("present"):
            console.print(f"  {row['stream']}: [dim]not created yet[/dim]")
            continue
        console.print(f"  {row['stream']}: {row['messages']} message(s)")
        for consumer in row.get("consumers", []):
            console.print(
                f"    consumer {consumer['name']}: pending={consumer['pending']} "
                f"in-flight={consumer['inFlight']}"
            )


@app.command()
def publish(
    max_steps: Annotated[
        int,
        typer.Option(
            "--max-steps",
            help="MANDATORY loop budget: total steps the relay will execute for this group. "
            "An event loop is self-amplifying, so there is no unbounded default.",
        ),
    ],
    template: Annotated[
        str, typer.Option("--template", help="Chart template the relay composes per step.")
    ] = "answer",
    param: Annotated[
        list[str] | None,
        typer.Option("--param", "-p", help="Content param key=value (@path splices a file)."),
    ] = None,
    agent: Annotated[
        str, typer.Option("--agent", help="Executor for the first step (hand-offs may switch it).")
    ] = "claude",
    model: Annotated[
        str | None, typer.Option("--model", help="Model for every step (else per-agent default).")
    ] = None,
    queue: Annotated[str, typer.Option("--queue", help="Task queue (subject suffix).")] = "default",
    group: Annotated[
        str | None, typer.Option("--group", help="Loop id (default: loop-<yymmdd>-<hhmmss>).")
    ] = None,
) -> None:
    """Seed an event loop: publish the first fire descriptor onto h.task.<queue>."""
    params = parse_params(param or [])
    if agent not in AGENT_IDENTITY:
        err_console.print(
            f"[red]unknown agent '{agent}'[/red] (known: {', '.join(sorted(AGENT_IDENTITY))})"
        )
        raise typer.Exit(1)
    try:
        _render(template)  # fail fast at the seam, not inside the relay
    except RelayStepError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    descriptor = protocol.seed_descriptor(
        template=template,
        params=params,
        agent=agent,
        max_steps=max_steps,
        group=group or group_id("loop"),
        queue=queue,
        model=model,
    )
    problems = protocol.validate_descriptor(descriptor)
    if problems:
        err_console.print(f"[red]invalid seed:[/red] {'; '.join(problems)}")
        raise typer.Exit(1)
    try:
        duplicate = asyncio.run(fabric.publish_seed(descriptor))
    except fabric.FabricError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    if duplicate:
        console.print(f"[yellow]duplicate[/yellow] — {protocol.msg_id(descriptor)} already seeded")
        return
    console.print(f"seeded {descriptor['group']} → {protocol.task_subject(queue)}")
    console.print(f"    budget: {max_steps} step(s), first agent: {agent}")
    console.print(
        f"    result lands on {protocol.result_subject(descriptor['group'])} — "
        f"watch: h events tail 'h.result.>'    runs: h runs"
    )


@app.command()
def serve(
    queue: Annotated[str, typer.Option("--queue", help="Task queue to consume.")] = "default",
) -> None:
    """Run the relay: consume h.task.<queue>, compose-on-fire, execute locally, forward."""
    console.print(f"relay consuming {protocol.task_subject(queue)} (Ctrl-C stops; an in-flight")
    console.print(
        f"task redelivers after ~{fabric.ACK_WAIT_SECONDS}s — durability is the fabric's job)"
    )
    try:
        asyncio.run(fabric.relay(queue, relay_step, lambda line: console.print(line)))
    except fabric.FabricError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    except KeyboardInterrupt:
        console.print("\nrelay stopped — unacked work redelivers to the next relay")


def _terminal_line(event: dict[str, Any]) -> str:
    """One line per terminal — the unit a driver's monitor turns into a single notification."""
    bits = [f"■ {event.get('group')} {event.get('status')}"]
    if event.get("steps") is not None:
        bits.append(f"steps={event['steps']}")
    if event.get("agent"):
        bits.append(f"agent={event['agent']}")
    cost = event.get("costUsd")
    bits.append(f"cost=${cost:.4f}" if isinstance(cost, int | float) else "cost=—")
    if event.get("runId"):
        bits.append(f"run={event['runId']}")
    if event.get("error"):
        bits.append(f"error={str(event['error'])[:160]}")
    return " ".join(bits)


# `await` is a Python keyword, so the function cannot carry the command's name — Typer takes it
# from the decorator instead. The command name is what matters at the surface.
@app.command("await")
def await_(
    group: Annotated[str, typer.Argument(help="The loop group to wait for (the seed's --group).")],
    timeout: Annotated[
        float, typer.Option(help="Seconds to wait before giving up (exit 124).")
    ] = 3600.0,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print the raw terminal envelope instead of one line.")
    ] = False,
) -> None:
    """Block until one group's loop reports its terminal, then print it and exit.

    Replays the result stream, so a loop that finished BEFORE this call still answers immediately.
    Exit code carries the outcome for scripting: 0 resolved/exhausted, 1 failed, 124 timed out.
    """
    try:
        event = asyncio.run(fabric.await_result(group, timeout))
    except fabric.FabricError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    except KeyboardInterrupt:
        raise typer.Exit(130) from None
    if event is None:
        err_console.print(f"[yellow]events:[/yellow] no terminal for '{group}' within {timeout}s")
        raise typer.Exit(124)
    console.print(json.dumps(event) if as_json else _terminal_line(event))
    if event.get("status") == "failed":
        raise typer.Exit(1)


@app.command()
def results(
    durable: Annotated[
        str, typer.Option(help="Durable consumer name — resume point across watches.")
    ] = "driver",
    group: Annotated[
        str | None, typer.Option(help="Only this group's terminals (default: every group).")
    ] = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print raw terminal envelopes instead of one line each.")
    ] = False,
) -> None:
    """Stream terminals off a DURABLE consumer — one line each, acked as they are printed.

    The driver's back-edge: unlike `tail`, this misses nothing that landed while it was not
    running, because the consumer resumes from its last ack. Run it under a monitor and every
    completed loop becomes one notification.

    Delivery is AT-LEAST-once, as it must be: a watcher killed between printing a terminal and
    acking it will see that terminal again on the next run. Terminals are idempotent to read, so
    the duplicate is noise rather than a hazard — but a consumer that ACTS on one should key off
    the group.
    """

    def emit(event: dict[str, Any]) -> None:
        console.print(json.dumps(event) if as_json else _terminal_line(event))

    try:
        asyncio.run(fabric.consume_results(durable, group, emit))
    except fabric.FabricError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    except KeyboardInterrupt:
        pass


@app.command()
def tail(
    subject: Annotated[
        str, typer.Argument(help="Subject filter (NATS wildcards; default everything under h.).")
    ] = "h.>",
) -> None:
    """Watch fabric traffic live (a plain subscription — takes nothing from the work queue)."""

    def emit(subj: str, payload: Any) -> None:
        if isinstance(payload, str):
            console.print(f"[dim]{subj}[/dim] {payload}")
        else:
            console.print(f"[dim]{subj}[/dim] {json.dumps(payload)}")

    try:
        asyncio.run(fabric.watch(subject, emit))
    except fabric.FabricError as err:
        err_console.print(f"[red]events:[/red] {err}")
        raise typer.Exit(1) from err
    except KeyboardInterrupt:
        pass
