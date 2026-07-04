"""h workflow — read-side views over workflow-svc (saved workflows + instance status)."""

from typing import Annotated, Any

import httpx
import typer
import yaml
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from h_cli.infrastructure import workflow_svc

app = typer.Typer(no_args_is_help=True, help="Saved workflows and instance status (workflow-svc).")
console = Console()
err_console = Console(stderr=True)


def _guarded(fn: Any) -> Any:
    try:
        return fn()
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Is workflow-svc running? (make dev-tab)")
        raise typer.Exit(1) from err


@app.command("list")
def list_() -> None:
    """List saved workflow keys."""
    keys = _guarded(workflow_svc.list_keys)
    table = Table("key", title=f"saved workflows ({len(keys)})")
    for key in sorted(keys):
        table.add_row(key)
    console.print(table)


@app.command()
def get(key: Annotated[str, typer.Argument(help="Saved workflow key.")]) -> None:
    """Show a saved workflow definition (canonical YAML view)."""
    stored = _guarded(lambda: workflow_svc.get(key))
    rendered = yaml.safe_dump(stored, sort_keys=False)
    console.print(Syntax(rendered, "yaml", background_color="default"))


@app.command()
def status(instance_id: Annotated[str, typer.Argument(help="Workflow instance id.")]) -> None:
    """Show a workflow instance's runtime status."""
    console.print_json(data=_guarded(lambda: workflow_svc.status(instance_id)))
