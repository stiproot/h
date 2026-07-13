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
    names = sorted(AGENT_IDENTITY.keys())
    table = Table("agent", "runActivity", "agentId", "url", title=f"agents ({len(names)})")
    for name in names:
        run_activity, agent_id = AGENT_IDENTITY[name]
        url = AGENT_URLS.get(agent_id, "-")
        table.add_row(name, run_activity, agent_id, url)
    console.print(table)
