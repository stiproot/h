"""h cron — the recur engine's registry (workflow-svc's /cron surface).

The third sibling of `h watch` / `h chain list`. Every list render leads with the `cron:__tick__`
heartbeat: a missing or stale (>5 min) heartbeat means the scan engine is not running and the rows
are not truth (docs/plans/workflow-watcher-registry.md §5). Crons are REGISTERED by
`h workflow run <key> --cron <cadence>` (workflow-svc is the sole writer); this surface inspects them.
"""

from datetime import UTC, datetime
from typing import Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.infrastructure import workflow_svc

app = typer.Typer(no_args_is_help=True, help="Durable cron registry (workflow-svc recur engine).")
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


@app.command("list")
def list_() -> None:
    """List cron rows (recur registrations), with the scan heartbeat above the table."""
    data = _guarded(workflow_svc.cron_list)
    _print_heartbeat(data.get("heartbeat"))
    crons = data.get("crons") or []
    table = Table(
        "cron", "status", "cadence", "fires", "outcome", "lastRunAt", "note",
        title=f"crons ({len(crons)})",
    )
    for row in crons:
        cron_id = f"{row.get('repo', '')}:{row.get('slug', '')}:{row.get('workflow', '')}"
        max_fires = (row.get("budget") or {}).get("maxFires", "")
        table.add_row(
            cron_id,
            row.get("status", ""),
            row.get("cadence", ""),
            f"{row.get('fires', '')}/{max_fires}",
            row.get("outcome") or "",
            row.get("lastRunAt") or "",
            row.get("note") or "",
        )
    console.print(table)
