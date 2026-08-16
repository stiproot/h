"""h cron — the recur engine's registry (workflow-svc's /cron surface).

The third sibling of `h watch` / `h chain list`. Every list render leads with the `cron:__tick__`
heartbeat: a missing or stale (>5 min) heartbeat means the scan engine is not running and the rows
are not truth. Crons are REGISTERED by
`h workflow run <key> --cron <cadence>` (workflow-svc is the sole writer); this surface inspects
them.
"""

from datetime import UTC, datetime
from typing import Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.commands._local_registry import refuse_pending_registry
from h_cli.infrastructure import workflow_svc
from h_cli.params import parse_params

# `--local` is ACCEPTED and then refused by name, rather than being absent: a flag that
# does not exist reads as "wrong command", while one that refuses says which engine is
# missing and what to run meanwhile. It becomes real when the cron: registry lands.
LOCAL_LIST_OPT = typer.Option(
    False,
    "--local",
    help="Read the LOCAL substrate's cron: registry (not available yet — refuses by name).",
)

app = typer.Typer(no_args_is_help=True, help="Durable cron registry (workflow-svc recur engine).")
discover_app = typer.Typer(
    no_args_is_help=True, help="Discovery/fan-out crons (a source → per-issue fires)."
)
app.add_typer(discover_app, name="discover")
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
def list_(local: bool = LOCAL_LIST_OPT) -> None:
    """List cron rows — recur registrations AND discovery/fan-out crons — with the scan
    heartbeat."""
    refuse_pending_registry("cron", local)
    data = _guarded(workflow_svc.cron_list)
    _print_heartbeat(data.get("heartbeat"))
    crons = data.get("crons") or []
    table = Table(
        "cron",
        "status",
        "cadence",
        "fires",
        "outcome",
        "lastRunAt",
        "note",
        title=f"recur crons ({len(crons)})",
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

    discover = data.get("discover") or []
    dtable = Table(
        "discover",
        "status",
        "cadence",
        "workflow",
        "fires",
        "lastFired",
        "lastRunAt",
        "note",
        title=f"discovery crons ({len(discover)})",
    )
    for row in discover:
        disc_id = f"{row.get('repo', '')}:{row.get('label', '')}"
        per_day = (row.get("gates") or {}).get("maxFiresPerDay", "")
        dtable.add_row(
            disc_id,
            row.get("status", ""),
            row.get("cadence", ""),
            # The row embeds its fire-descriptor template; the fired workflow is its key.
            (row.get("trigger") or {}).get("key", ""),
            f"{row.get('fires', 0)} (≤{per_day}/day)",
            str(row.get("lastFiredIssue") or ""),
            row.get("lastRunAt") or "",
            row.get("note") or "",
        )
    console.print(dtable)


@app.command("rm")
def rm(
    repo: str = typer.Argument(
        ..., help="owner/name — the GitHub repo coord for the cron identity."
    ),
    slug: str = typer.Argument(..., help="Slug coord (e.g. pi-agent)."),
    workflow: str = typer.Argument(..., help="Workflow coord (e.g. revise)."),
) -> None:
    """Disarm a recur cron: set inactive+disabled, keep the row for audit.

    Calls workflow-svc's POST /cron/disarm — only workflow-svc writes cron:* rows (single-writer).
    Idempotent: an already-inactive cron is a success, not an error."""
    result = _guarded(lambda: workflow_svc.cron_disarm(repo, slug, workflow))
    cron_key = f"cron:sub:{repo}:{slug}:{workflow}"
    console.print(
        f"[green]disarmed[/green] {cron_key} → {result['status']} / {result.get('outcome', '')}"
    )


@discover_app.command("add")
def discover_add(
    repo: str = typer.Argument(
        ..., help="owner/name — the GitHub repo to scan AND the fired runs' identity repo."
    ),
    label: str = typer.Option(
        ..., "--label", "-l", help="Only open issues with this label are discovered."
    ),
    cadence: str = typer.Option(
        ..., "--cadence", "-c", help="5-field cron expression (UTC) — how often to scan."
    ),
    workflow: str = typer.Option(
        "implement-pr", "--workflow", "-w", help="Saved workflow fired per discovered issue."
    ),
    max_per_day: int | None = typer.Option(
        None, "--max-per-day", help="Daily fan-out cap (backstop; server default 5)."
    ),
    run_budget_mins: int | None = typer.Option(
        None,
        "--run-budget-mins",
        help="Supervise each fired run: terminate it after this many minutes "
        "(attaches a watch policy).",
    ),
    run_retries: int | None = typer.Option(
        None,
        "--run-retries",
        help="Engine-retry a failed fired run up to N times (needs --run-budget-mins).",
    ),
    param: list[str] = typer.Option(
        [],
        "--param",
        "-p",
        help="key=value merged into every fire (e.g. identity); @path splices a file.",
    ),
) -> None:
    """Register a discovery/fan-out cron: each due tick lists open '<label>' issues on <repo> and
    fires
    ONE <workflow> per newly-discovered issue (serialized, deduped against the wf: keys). Fires a
    one-step provision workflow whose register-discover activity writes the cron:discover row (§10 —
    crons via activities); the provision run's wf: row audits the registration.

    --run-budget-mins attaches a watch policy so the watcher engine terminates a hung run (and
    retries it, with --run-retries) instead of the run stalling the discovery cron's one-in-flight
    serialize."""
    if run_retries is not None and run_budget_mins is None:
        err_console.print(
            "[red]--run-retries[/red] needs --run-budget-mins (a watch needs a budget)."
        )
        raise typer.Exit(1)
    watch: dict[str, Any] | None = None
    if run_budget_mins is not None:
        watch = {"maxDurationMs": run_budget_mins * 60_000}
        if run_retries is not None:
            watch["retry"] = {"maxAttempts": run_retries, "fresh": True}
    fire_params = parse_params(param) or None
    data = _guarded(
        lambda: workflow_svc.provision_discover(
            repo, label, workflow, cadence, max_per_day, fire_params, watch
        )
    )
    supervised = f", supervised ≤{run_budget_mins}m" if run_budget_mins else ""
    console.print(
        f"[green]provisioned[/green] discovery cron for open '{label}' issues on {repo} "
        f"→ fires [cyan]{workflow}[/cyan]{supervised} "
        f"(provision run [bold]{data.get('instanceId')}[/bold])"
    )
