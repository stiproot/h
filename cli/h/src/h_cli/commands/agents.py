"""h agents — list the workflow-invokable agents.

One row per agent, reading from the existing config tables (no new data source)."""

import typer
from rich.console import Console
from rich.table import Table

from h_cli.config import AGENT_IDENTITY, AGENT_URLS

app = typer.Typer(no_args_is_help=True, help="List the workflow-invokable agents.")
console = Console()


@app.command("list")
def list_() -> None:
    """List all workflow-invokable agents and their identities."""
    seen: set[str] = set()
    rows: list[tuple[str, str, str, str]] = []
    for name in sorted(AGENT_IDENTITY.keys()):
        run_activity, agent_id = AGENT_IDENTITY[name]
        if agent_id in seen:
            continue
        seen.add(agent_id)
        url = AGENT_URLS.get(agent_id, "-")
        rows.append((name, run_activity, agent_id, url))

    table = Table("agent", "runActivity", "agentId", "url", title=f"agents ({len(rows)})")
    for row in rows:
        table.add_row(*row)
    console.print(table)
