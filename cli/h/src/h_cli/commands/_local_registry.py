"""Refusals for registry reads whose LOCAL half does not exist yet.

`h cron list --local` could return an empty list. It must not: "no crons are registered" and "this
substrate has no cron registry" are different facts, and only the second is true. An empty table
asserts the first, which is the quiet kind of wrong this repo keeps hunting — the same reason the
executor refuses `register-cron` by name instead of skipping it.

So each read whose registry is still pending refuses, names the engine that lifts it, and points at
the substrate that can answer today. When an increment lands its registry, its entry leaves here.
"""

import typer
from rich.console import Console
from rich.markup import escape

err_console = Console(stderr=True)

# registry name -> what has to exist before `--local` can answer for it.
PENDING: dict[str, str] = {
    "cron": "the cron engine and its cron: KV registry",
    "chain": "the chain engine and its chain: KV registry",
    "watch": "the watcher engine and its watch: KV registry",
    "schedule": "the schedule engine and its cron:sched KV registry",
}


def refuse_pending_registry(name: str, local: bool) -> None:
    """Exit 1 naming what the local read is waiting for; a no-op unless `--local` was asked for.

    The flag is a PARAMETER rather than something the caller checks first, because the version that
    left it to the caller shipped with the check missing and refused every read — including the
    service ones. A guard whose correctness depends on remembering to guard it is not one.
    """
    if not local:
        return
    awaiting = PENDING.get(name)
    if awaiting is None:
        return
    err_console.print(
        f"[red]--local cannot list {escape(name)} yet[/red] — it needs {escape(awaiting)}, which "
        "the local substrate does not have. Reading it as an empty list would say 'none "
        f"registered' when the truth is 'no {escape(name)} registry here'."
    )
    err_console.print(f"Drop --local to read workflow-svc's {escape(name)} rows.")
    raise typer.Exit(1)
