"""h runs — the run journal's read surface (local substrate).

`watch` is the driver-side window onto a journaled run: replay everything the journal holds,
then follow live until the terminal record lands. Reading is an EPHEMERAL consumer (the
`h events await` pattern) — watching a run leaves nothing durable behind, and a run that
finished before you asked still answers from the stream's retained history.
"""

import asyncio
import json
from typing import Annotated, Any

import typer
from rich.console import Console

from h_cli.infrastructure import events_fabric

app = typer.Typer(no_args_is_help=True, help="Journaled local runs (the h-journal stream).")

console = Console()
err_console = Console(stderr=True)


def _describe(record: dict[str, Any]) -> str:
    kind = record.get("type")
    if kind == "meta":
        return f"● {record.get('kind', '?')} '{record.get('group', '?')}' journaled (seq 0)"
    if kind == "stage":
        data = record.get("data")
        keys = ", ".join(sorted(k for k in data)) if isinstance(data, dict) else "?"
        return (
            f"▸ stage {record.get('cursor', '?')} done"
            f" (iteration {record.get('iteration', 0)}) — data: {keys}"
        )
    if kind == "step":
        return f"▸ step '{record.get('stepId', '?')}' done"
    if kind == "terminal":
        return f"■ {record.get('status', '?')}"
    return f"? {json.dumps(record)[:120]}"


@app.command()
def watch(
    group: Annotated[str, typer.Argument(help="The run's group/instance id (h.journal.<group>).")],
    json_out: Annotated[
        bool, typer.Option("--json", help="Raw journal records, one JSON line each.")
    ] = False,
) -> None:
    """Replay a run's journal, then follow it live until its terminal record (Ctrl-C to stop).

    Progress for a run that is still going; history for one that finished — either way off the
    stream, so it works from any shell, not just the one driving the run.
    """

    def emit(record: dict[str, Any]) -> None:
        if json_out:
            console.print_json(data=record)
        else:
            console.print(_describe(record))

    try:
        terminal = asyncio.run(events_fabric.watch_journal(group, emit))
    except events_fabric.FabricError as err:
        err_console.print(f"[red]fabric:[/red] {err}")
        raise typer.Exit(1) from err
    except KeyboardInterrupt:
        err_console.print("stopped watching (the run, if live, continues)")
        raise typer.Exit(130) from None
    if terminal is None:
        raise typer.Exit(1)
