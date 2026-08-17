"""h schedule — the one-shot scheduled-fire registry (workflow-svc's cron:sched:* rows).

A thin view over the cron system's third sibling: fire a workflow ONCE at an absolute time. The
rows ride the same `cron:__tick__` heartbeat as the recur/discovery crons, so a stale heartbeat
means the scan is not running and the rows are not truth.
Schedules are
ARMED by `h workflow run <key> --at <iso>` / `--in <dur>` (and by pause/resume + the usage-limit
fallback); workflow-svc is the sole writer. This surface inspects and cancels them.
"""

from datetime import UTC, datetime
from typing import Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.infrastructure import local_runtime, workflow_svc

app = typer.Typer(no_args_is_help=True, help="One-shot scheduled fires (workflow-svc cron:sched).")
console = Console()
err_console = Console(stderr=True)

STALE_AFTER_SECONDS = 5 * 60


def _guarded(fn: Any) -> Any:
    try:
        return fn()
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Is workflow-svc running? (make dev-tab)")
        raise typer.Exit(1) from err


def _heartbeat_age_seconds(at: Any) -> float | None:
    if not isinstance(at, str):
        return None
    try:
        ts = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    return (datetime.now(UTC) - ts).total_seconds()


def _format_age(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m"
    return f"{seconds / 3600:.1f}h"


def _print_heartbeat(heartbeat: dict[str, Any] | None) -> None:
    """The staleness signal (shared cron:__tick__): red when the scan has never ticked or is
    older than 5 minutes — the sched rows are not truth then."""
    if heartbeat is None:
        err_console.print("[red]heartbeat: MISSING — the scan engine has never ticked[/red]")
        return
    state = "enabled" if heartbeat.get("enabled") else "DISARMED"
    age = _heartbeat_age_seconds(heartbeat.get("at"))
    if age is None or age > STALE_AFTER_SECONDS:
        shown = "unparseable" if age is None else f"{_format_age(age)} ago"
        err_console.print(f"[red]heartbeat: STALE ({shown}, {state}) — rows may not be truth[/red]")
    elif state == "DISARMED":
        console.print(f"[yellow]heartbeat: {_format_age(age)} ago (DISARMED)[/yellow]")
    else:
        console.print(f"heartbeat: {_format_age(age)} ago ({state})")


LOCAL_OPT = typer.Option(
    False,
    "--local",
    help="Read the LOCAL substrate's cron:sched rows (JetStream KV) instead of workflow-svc.",
)


@app.command("list")
def list_(local: bool = LOCAL_OPT) -> None:
    """List one-shot scheduled fires (cron:sched:* rows) with the scan heartbeat."""
    if local:
        # No heartbeat line: the local engine host's liveness is `h events status`, which reports
        # the PROCESS rather than a row it last stamped. One truth, in the place that owns it.
        sched = local_runtime.registry("scheds.list") or []
    else:
        data = _guarded(workflow_svc.cron_list)
        _print_heartbeat(data.get("heartbeat"))
        sched = data.get("sched") or []
    table = Table(
        "id",
        "status",
        "fireAt",
        "origin",
        "outcome",
        "firedAt",
        "note",
        title=f"scheduled fires ({len(sched)})",
    )
    for row in sched:
        table.add_row(
            row.get("id", ""),
            row.get("status", ""),
            row.get("fireAt", ""),
            row.get("origin") or "",
            row.get("outcome") or "",
            row.get("firedAt") or "",
            row.get("note") or "",
        )
    console.print(table)


@app.command("rm")
def rm(
    sched_id: str = typer.Argument(..., help="The scheduled-fire row id (from `h schedule list`)."),
    local: bool = LOCAL_OPT,
) -> None:
    """Disarm a one-shot scheduled fire before it fires: set disarmed, keep the row for audit.

    On the service substrate this calls POST /cron/sched/disarm, because only workflow-svc writes
    cron:* rows; with --local it goes through the runner, which owns the local registry's key
    encoding. Idempotent either way: an already-terminal schedule is a success, not an error."""
    if local:
        result = local_runtime.registry("sched.disarm", key=sched_id)
    else:
        result = _guarded(lambda: workflow_svc.sched_disarm(sched_id))
    console.print(
        f"[green]disarmed[/green] cron:sched:{sched_id} → "
        f"{result['status']} / {result.get('outcome', '')}"
    )
