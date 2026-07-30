"""h template — the template primitive's surface: the spatial (overlay) composition level.

The composition stack: templates —(compose)→ workflow
definitions —(run)→ workflows —(chain run)→ chains. `compose` is the arrow out of this level:
it renders each named template in publish+composable mode and overlays them (merge by step id)
into ONE workflow definition — one run, one worktree, one agent context. `-t` means template
everywhere in the CLI; operands here are space-separated (`rm`-style), never `+`-joined.
"""

from typing import Annotated, Any

import httpx
import typer
import yaml
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from h_cli.config import CHARTS_DIR
from h_cli.infrastructure import helm, workflow_svc
from h_cli.infrastructure.overlay import overlay

app = typer.Typer(no_args_is_help=True, help="Templates: compose (overlay), list, get.")
console = Console()
err_console = Console(stderr=True)

# Render mode for overlay atoms: {{params.*}} slots stay open (publish) and standalone closers /
# non-composable steps are omitted (composable), so definitions merge cleanly by step id.
COMPOSABLE_VALUES = {"publish": "true", "composable": "true"}
TEMPLATE_SUFFIX = ".tmpl.yaml"
TEMPLATE_ROLES = frozenset({"standalone", "base", "overlay"})
SAVED_KEY_TEMPLATES = {"review-pr": "review-pr"}


def template_name_for_key(key: str) -> str:
    """Resolve a stable saved workflow key to its renamed chart template."""
    return SAVED_KEY_TEMPLATES.get(key, key)


def template_role(name: str) -> str:
    """Read a template's required plain top-level role declaration."""
    path = CHARTS_DIR / "workflows" / "templates" / f"{name}{TEMPLATE_SUFFIX}"
    if not path.is_file():
        err_console.print(f"[red]Unknown template '{name}'[/red] — run `h template list`.")
        raise typer.Exit(1)
    roles = [
        line.removeprefix("role:").strip()
        for line in path.read_text().splitlines()
        if line.startswith("role:")
    ]
    if len(roles) != 1 or roles[0] not in TEMPLATE_ROLES:
        err_console.print(
            f"[red]Template '{name}' has invalid role metadata[/red] — expected exactly one of "
            "standalone, base, overlay."
        )
        raise typer.Exit(1)
    return roles[0]


def refuse_overlay(name: str, action: str) -> None:
    """Refuse an overlay where a complete workflow is required."""
    if template_role(name) == "overlay":
        err_console.print(
            f"[red]Cannot {action} overlay template '{name}' alone.[/red] "
            f"Compose it with a base: `h template compose implement {name}`."
        )
        raise typer.Exit(1)


def compose_templates(templates: list[str]) -> dict[str, Any]:
    """Render each template as an overlay atom and merge them into one workflow definition.

    The reusable core of `h template compose` — chain's compose-on-fire (a `-t` group) calls
    this too. Raises typer.Exit with a user-facing message on a helm/render failure.
    """
    definitions: list[dict[str, Any]] = []
    for name in templates:
        try:
            rendered = helm.render_workflow(name, values=COMPOSABLE_VALUES)
        except helm.HelmError as err:
            err_console.print(f"[red]helm ({name}):[/red] {err}")
            raise typer.Exit(1) from err
        loaded = yaml.safe_load(rendered)
        if not isinstance(loaded, dict) or not loaded.get("steps"):
            err_console.print(f"[red]Template '{name}' rendered no steps[/red] — check values.")
            raise typer.Exit(1)
        definitions.append(loaded)
    return overlay(*definitions)


@app.command()
def compose(
    templates: Annotated[
        list[str] | None,
        typer.Argument(
            help="Templates to overlay, space-separated, merged left-to-right by step id. "
            "E.g. `h template compose implement verify create-pr`.",
            metavar="TEMPLATE...",
        ),
    ] = None,
    save: Annotated[
        str | None,
        typer.Option(
            "--save",
            help="Persist the composed definition to workflow-svc under this key. Without it, "
            "the merged definition is printed for inspection. (Output is always named "
            "explicitly — the last operand is a template like any other, never a target.)",
        ),
    ] = None,
) -> None:
    """Overlay templates into one workflow definition (spatial composition).

    `implement verify create-pr` composes ONE workflow (one instanceId, one worktree, one agent
    context) ordered implement → verify-gate → PR. Publish-native: {{params.*}} slots stay open,
    so a --save'd result fires with `h workflow run <key> -p slug=... --spec <name> --agent <a>`.
    """
    if not templates:
        err_console.print("[red]at least one template operand is required[/red]")
        raise typer.Exit(1)
    merged = compose_templates(templates)
    joined = " ⊕ ".join(templates)
    if save:
        try:
            result = workflow_svc.save(
                save, merged["steps"], params=merged.get("params"), outputs=merged.get("outputs")
            )
        except httpx.HTTPError as err:
            err_console.print(f"[red]http:[/red] {err}")
            err_console.print("Is workflow-svc running? (make dev-tab)")
            raise typer.Exit(1) from err
        console.print(f"==> Composed [{joined}] saved as '{result['key']}'")
        console.print(f"    fire it: h workflow run {result['key']} -p slug=... -p spec=@file.md")
    else:
        rendered = yaml.safe_dump(merged, sort_keys=False)
        console.print(f"[dim]# composed: {joined} — pass --save <key> to persist[/dim]")
        console.print(Syntax(rendered, "yaml", background_color="default"))


@app.command("list")
def list_() -> None:
    """List the chart templates (the overlay atoms under cli/charts/workflows/templates)."""
    templates_dir = CHARTS_DIR / "workflows" / "templates"
    paths = sorted(templates_dir.glob(f"*{TEMPLATE_SUFFIX}"))
    if not paths:
        err_console.print(f"[red]No templates found[/red] under {templates_dir}")
        raise typer.Exit(1)
    rows = [
        (p.name.removesuffix(TEMPLATE_SUFFIX), template_role(p.name.removesuffix(TEMPLATE_SUFFIX)))
        for p in paths
    ]
    table = Table("template", "role", title=f"chart templates ({len(rows)})")
    for name, role in rows:
        table.add_row(name, role)
    console.print(table)


@app.command()
def get(
    template: Annotated[str, typer.Argument(help="A chart template name (see `h template list`).")],
) -> None:
    """Show one template rendered as an overlay atom (publish+composable mode, canonical YAML)."""
    try:
        rendered = helm.render_workflow(template, values=COMPOSABLE_VALUES)
    except helm.HelmError as err:
        err_console.print(f"[red]helm:[/red] {err}")
        raise typer.Exit(1) from err
    console.print(Syntax(rendered, "yaml", background_color="default"))
