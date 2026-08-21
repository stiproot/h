"""h template — the template primitive's surface: the spatial (overlay) composition level.

The composition stack: templates —(compose)→ workflow
definitions —(run)→ workflows —(chain run)→ chains. `compose` is the arrow out of this level:
it renders each named template in publish+composable mode and overlays them (merge by step id)
into ONE workflow definition — one run, one worktree, one agent context. `-t` means template
everywhere in the CLI; operands here are space-separated (`rm`-style), never `+`-joined.
"""

from pathlib import Path
from typing import Annotated, Any

import httpx
import typer
import yaml
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from h_cli.config import chart_root_for, charts_roots
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
    root = chart_root_for(name)
    if root is None:
        err_console.print(f"[red]Unknown template '{name}'[/red] — run `h template list`.")
        raise typer.Exit(1)
    path = root / "workflows" / "templates" / f"{name}{TEMPLATE_SUFFIX}"
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


def template_summary(name: str) -> str:
    """Read a template's plain top-level summary line — the catalog line beside its role.

    Same line-scan mechanic as template_role (no render), but GRACEFUL: h's stock templates
    are required to carry one (check-templates.mjs enforces it), while a consumer chart's
    template without one lists as "—" rather than failing the whole listing.
    """
    root = chart_root_for(name)
    if root is None:
        return "—"
    path = root / "workflows" / "templates" / f"{name}{TEMPLATE_SUFFIX}"
    summaries = [
        line.removeprefix("summary:").strip()
        for line in path.read_text().splitlines()
        if line.startswith("summary:")
    ]
    return summaries[0] if len(summaries) == 1 and summaries[0] else "—"


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
    """List the chart templates across the search path (consumer chart first, stock fallback);
    a name in both charts lists once, owned by the primary (shadowing)."""
    roots = charts_roots()
    owned: dict[str, Path] = {}
    for root in roots:
        for p in sorted((root / "workflows" / "templates").glob(f"*{TEMPLATE_SUFFIX}")):
            owned.setdefault(p.name.removesuffix(TEMPLATE_SUFFIX), root)
    if not owned:
        err_console.print(
            f"[red]No templates found[/red] under {' or '.join(str(r) for r in roots)}"
        )
        raise typer.Exit(1)
    multi = len(roots) > 1
    columns = ("template", "role", "summary", "chart") if multi else ("template", "role", "summary")
    table = Table(*columns, title=f"chart templates ({len(owned)})")
    for name in sorted(owned):
        row = (name, template_role(name), template_summary(name)) + (
            (str(owned[name]),) if multi else ()
        )
        table.add_row(*row)
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


# --- drift ---------------------------------------------------------------------------------------
#
# A saved workflow is a SNAPSHOT of a template render, taken at publish time. Nothing keeps the two
# in step afterwards: edit a template and the live definition keeps running the old shape until
# someone re-publishes, and a definition edited directly in the control plane looks identical from
# the outside. Both failures are silent, and both are visible by simply re-rendering and comparing.

# Sections compared. Deliberately not the whole stored record: savedAt/schedule/workspaceId/disabled
# are publish-time OPERATIONAL choices, not template content, so they are not drift.
DRIFT_SECTIONS = ("steps", "params", "outputs")


def _template_for_saved_key(key: str) -> str | None:
    """The chart template a saved key came from, or None when it did not come from one.

    Chain members publish under `<slug>-w<N>` and agents can save ad-hoc definitions; those have no
    template to re-render, so they are reported as unchecked rather than as drift.
    """
    name = template_name_for_key(key)
    return name if chart_root_for(name) is not None else None


def _render_published(template: str) -> dict[str, Any]:
    """Re-render a template exactly as `h workflow publish` would."""
    rendered = helm.render_workflow(template, values={"publish": "true"})
    loaded = yaml.safe_load(rendered)
    return loaded if isinstance(loaded, dict) else {}


def _diff_sections(stored: dict[str, Any], fresh: dict[str, Any]) -> list[str]:
    """Which compared sections differ. Absent and empty are the SAME thing here — a template that
    renders no `outputs` and a stored record that omits the key are not in conflict."""
    return [
        section
        for section in DRIFT_SECTIONS
        if (stored.get(section) or None) != (fresh.get(section) or None)
    ]


@app.command()
def drift(
    keys: Annotated[
        list[str] | None,
        typer.Argument(help="Saved keys to check; default every saved workflow."),
    ] = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print machine-readable rows instead of the table.")
    ] = False,
) -> None:
    """Compare saved workflow definitions against a fresh render of the template they came from.

    Catches a saved definition that has fallen behind its template (nobody re-published after an
    edit) and a live definition changed out from under the chart. Exits 1 when anything drifted, so
    it can gate.
    """
    try:
        targets = keys or sorted(workflow_svc.list_keys())
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Is workflow-svc running?")
        raise typer.Exit(1) from err

    rows: list[dict[str, Any]] = []
    for key in targets:
        template = _template_for_saved_key(key)
        if template is None:
            rows.append({"key": key, "template": None, "status": "unchecked", "sections": []})
            continue
        try:
            stored = workflow_svc.get(key)
        except httpx.HTTPError as err:
            rows.append(
                {"key": key, "template": template, "status": "error", "sections": [str(err)]}
            )
            continue
        try:
            fresh = _render_published(template)
        except helm.HelmError as err:
            rows.append(
                {"key": key, "template": template, "status": "error", "sections": [str(err)]}
            )
            continue
        differing = _diff_sections(stored, fresh)
        rows.append(
            {
                "key": key,
                "template": template,
                "status": "drifted" if differing else "ok",
                "sections": differing,
            }
        )

    if as_json:
        console.print_json(data=rows)
    else:
        table = Table("key", "template", "status", "differs in", title="template drift")
        for row in rows:
            status = {
                "ok": "[green]ok[/green]",
                "drifted": "[red]drifted[/red]",
                "error": "[red]error[/red]",
                "unchecked": "[dim]no template[/dim]",
            }[row["status"]]
            table.add_row(
                row["key"], row["template"] or "-", status, ", ".join(row["sections"]) or "-"
            )
        console.print(table)
        drifted = [r["key"] for r in rows if r["status"] == "drifted"]
        if drifted:
            console.print(
                f"[red]{len(drifted)} drifted[/red] — re-publish with "
                f"`h workflow publish <template>`, or investigate if you did not edit the chart."
            )

    if any(row["status"] in ("drifted", "error") for row in rows):
        raise typer.Exit(1)
