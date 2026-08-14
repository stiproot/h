"""The journal preflight shared by the local substrate's journaled commands.

One function, used by `h chain run --local` and `h workflow run --local`: auto-ensure the
fabric for a journaled run, framing a refusal with its outs. The BINARY stays
operator-provisioned (refused loud by name — h never installs it); the PROCESS is h-managed
from here on: the same idempotent spawn `h events up` performs.
"""

from typing import Any

import typer
from rich.console import Console
from rich.markup import escape

err_console = Console(stderr=True)


def journal_preflight(resume: str | None) -> dict[str, Any]:
    """Ensure server + streams; return the job's `journal` config. Exits 1 on refusal."""
    from h_cli.config import EVENTS_URL
    from h_cli.infrastructure import events_fabric

    try:
        report = events_fabric.ensure_journal_ready()
    except events_fabric.FabricError as err:
        err_console.print(f"[red]journal preflight failed:[/red] {escape(str(err))}")
        outs = (
            "The journal is what makes --resume possible; provision nats-server"
            + (" and retry" if resume else ", or run with --no-journal to skip it for this run")
            + "."
        )
        err_console.print(outs)
        raise typer.Exit(1) from err
    state = "started" if report.get("started") else "already running"
    err_console.print(f"journal: fabric at {report.get('url', EVENTS_URL)} ({state})")
    return {"url": report.get("url", EVENTS_URL), **({"resume": True} if resume else {})}
