"""h watch — the durable watcher engine's registry (workflow-svc's /watch surface).

Every list render leads with the `watch:__tick__` heartbeat: a missing or stale (>5 min)
heartbeat means the scan engine is not running and the rows are not truth — the same
staleness guard the sweep applies (docs/plans/impl/watcher-primitive.md).
"""

from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.infrastructure import workflow_svc

app = typer.Typer(no_args_is_help=True, help="Durable watch registry (workflow-svc watcher).")
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
    """ISO timestamp → age in seconds; None when absent or unparseable (treat as stale)."""
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
    """The staleness signal: red when the scan has never ticked or is older than 5 minutes."""
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


def _format_cost(row: dict[str, Any]) -> str:
    cost = row.get("costUsd")
    rendered = "" if cost is None else f"{cost:.2f}"
    if row.get("costGap"):
        rendered = f"{rendered} GAP".strip()
    return rendered


@app.command("list")
def list_() -> None:
    """List watch rows, with the scan heartbeat (the staleness signal) above the table."""
    data = _guarded(workflow_svc.watch_list)
    _print_heartbeat(data.get("heartbeat"))
    watches = data.get("watches") or []
    table = Table(
        "instanceId",
        "status",
        "outcome",
        "attempts",
        "startedAt",
        "costUsd",
        "note",
        title=f"watches ({len(watches)})",
    )
    for row in watches:
        table.add_row(
            row.get("instanceId", ""),
            row.get("status", ""),
            row.get("outcome") or "",
            str(row.get("attempts", "")),
            row.get("startedAt", ""),
            _format_cost(row),
            row.get("note") or "",
        )
    console.print(table)


@app.command()
def get(instance_id: Annotated[str, typer.Argument(help="Watched workflow instance id.")]) -> None:
    """Show one watch row in full (policy, epoch, streaks, outcome, meta)."""

    def fetch() -> Any:
        try:
            return workflow_svc.watch_get(instance_id)
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 404:
                err_console.print(f"[red]Watch not found[/red] '{instance_id}'")
                raise typer.Exit(1) from err
            raise

    console.print_json(data=_guarded(fetch))


@app.command()
def rm(instance_id: Annotated[str, typer.Argument(help="Watched workflow instance id.")]) -> None:
    """Delete a watch row (stop supervising; the workflow instance itself is untouched)."""
    result = _guarded(lambda: workflow_svc.watch_delete(instance_id))
    console.print(f"==> Deleted watch '{result['deleted']}'")
