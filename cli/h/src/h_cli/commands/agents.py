"""h agents — list the workflow-invokable agents and maintain the executor policy.

The list reads from the existing config tables (no new data source); deny/allow maintain the
engine-enforced `exec:config` row on workflow-svc (docs/plans/live-state-containment.md §2.3) —
the activity-registry gate refuses a denied executor at fire time, on every path."""

import typer
from rich.console import Console
from rich.table import Table

from h_cli.config import AGENT_IDENTITY, AGENT_URLS
from h_cli.infrastructure import workflow_svc

app = typer.Typer(
    no_args_is_help=True,
    help="List the workflow-invokable agents and maintain the executor policy.",
)
console = Console()


def _executor_shortname(name: str) -> str:
    """Resolve a user-given agent name to its policy shortname (the run activity minus `run-`).

    Unknown names are refused loudly — the engine gate matches shortnames, so a typo would
    silently deny nothing."""
    identity = AGENT_IDENTITY.get(name)
    if identity is None:
        known = ", ".join(sorted({a for a, _ in AGENT_IDENTITY.values()}))
        console.print(f"[red]unknown agent '{name}'[/red] — known run activities: {known}")
        raise typer.Exit(code=1)
    run_activity, _ = identity
    return run_activity.removeprefix("run-")


@app.command("list")
def list_() -> None:
    """List all workflow-invokable agents, their identities, and the denied set."""
    try:
        denied = set(workflow_svc.exec_policy_get().get("denied", []))
    except Exception:
        denied = set()  # workflow-svc down: the table still lists; policy column shows unknown
        console.print("[yellow]workflow-svc unreachable — policy column unavailable[/yellow]")

    seen: set[str] = set()
    rows: list[tuple[str, str, str, str, str]] = []
    for name in sorted(AGENT_IDENTITY.keys()):
        run_activity, agent_id = AGENT_IDENTITY[name]
        if agent_id in seen:
            continue
        seen.add(agent_id)
        url = AGENT_URLS.get(agent_id, "-")
        policy = "DENIED" if run_activity.removeprefix("run-") in denied else "allowed"
        rows.append((name, run_activity, agent_id, url, policy))

    table = Table("agent", "runActivity", "agentId", "url", "policy", title=f"agents ({len(rows)})")
    for row in rows:
        table.add_row(*row)
    console.print(table)


@app.command("deny")
def deny(names: list[str] = typer.Argument(..., help="Agent names to deny (e.g. codex).")) -> None:
    """Deny executors engine-wide: every fire path refuses them until allowed again."""
    shortnames = [_executor_shortname(n) for n in names]
    current = set(workflow_svc.exec_policy_get().get("denied", []))
    updated = sorted(current | set(shortnames))
    policy = workflow_svc.exec_policy_set(updated)
    console.print(f"denied: {', '.join(policy['denied']) or '(none)'}")


@app.command("allow")
def allow(
    names: list[str] = typer.Argument(..., help="Agent names to re-allow (e.g. codex)."),
) -> None:
    """Remove executors from the denied set."""
    shortnames = {_executor_shortname(n) for n in names}
    current = set(workflow_svc.exec_policy_get().get("denied", []))
    updated = sorted(current - shortnames)
    policy = workflow_svc.exec_policy_set(updated)
    console.print(f"denied: {', '.join(policy['denied']) or '(none)'}")
