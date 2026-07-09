"""h workflow — workflow-svc surface: saved workflows, runs, instance status.

Spatial composition lives under the template noun (`h template compose`); this command owns the
definition/run level: publish, run, list, get, status, terminate.
"""

from pathlib import Path
from typing import Annotated, Any

import httpx
import typer
import yaml
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from h_cli.config import AGENT_URLS, resolve_agent_url
from h_cli.infrastructure import agent_service, helm, workflow_svc

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


def _parse_params(pairs: list[str]) -> dict[str, Any]:
    """`key=value` pairs → params dict; a value of `@path` splices in that file's content."""
    params: dict[str, Any] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            err_console.print(f"[red]Bad --param[/red] '{pair}' — expected key=value")
            raise typer.Exit(1)
        if value.startswith("@"):
            path = Path(value[1:])
            if not path.is_file():
                err_console.print(f"[red]--param {key}[/red]: no such file: {path}")
                raise typer.Exit(1)
            value = path.read_text()
        params[key] = value
    return params


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


@app.command()
def publish(
    template: Annotated[
        str,
        typer.Argument(help="Chart template (cli/charts/workflows/templates/<template>.yaml)."),
    ],
    key: Annotated[
        str | None, typer.Option(help="Saved-workflow key; defaults to the template name.")
    ] = None,
    schedule: Annotated[
        str | None,
        typer.Option(
            "--schedule",
            help="Cron expression (5-field, UTC): workflow-svc fires the saved workflow "
            "on this schedule.",
        ),
    ] = None,
    workspace_id: Annotated[
        str | None,
        typer.Option(
            "--workspace-id",
            help="Stable workspace key: every run (incl. cron fires) reuses one agent "
            "workspace dir instead of a per-run one.",
        ),
    ] = None,
    disabled: Annotated[
        bool,
        typer.Option(
            "--disabled",
            help="Save with the schedule parked: the cron tick skips it until re-saved "
            "without this flag (the kill switch).",
        ),
    ] = False,
) -> None:
    """Render a template in publish mode ({{params.*}} slots open) and save it to workflow-svc.

    Template config (sourceRepo, models, verifyCmd, …) bakes in from values.yaml +
    values.local.yaml at publish time; per-run inputs stay open as params, supplied later via
    `h workflow run <key> -p k=v` (or run_saved_workflow from any agent).
    """
    try:
        rendered = helm.render_workflow(template, values={"publish": "true"})
    except helm.HelmError as err:
        err_console.print(f"[red]helm:[/red] {err}")
        raise typer.Exit(1) from err
    definition = yaml.safe_load(rendered)
    steps = definition.get("steps") if isinstance(definition, dict) else None
    if not steps:
        err_console.print(f"[red]Template '{template}' rendered no steps[/red] — check its values.")
        raise typer.Exit(1)
    resolved_key = key or template
    result = _guarded(
        lambda: workflow_svc.save(
            resolved_key,
            steps,
            schedule=schedule,
            workspace_id=workspace_id,
            disabled=disabled if (disabled or schedule) else None,
        )
    )
    console.print(f"==> Published template '{template}' as saved workflow '{result['key']}'")
    if schedule:
        state = "DISABLED — re-publish without --disabled to arm" if disabled else "armed"
        console.print(f"    schedule: '{schedule}' ({state})")
    console.print(f"    fire it: h workflow run {result['key']} -p slug=... -p spec=@file.md")


DEFAULT_BUDGET_MS = 45 * 60_000
_BUDGET_UNITS = {"m": 60_000, "h": 3_600_000}


def _parse_budget(value: str) -> int:
    """A watch budget → milliseconds: a plain integer is ms; `<n>m`/`<n>h` are minutes/hours."""
    raw = value.strip().lower()
    unit = _BUDGET_UNITS.get(raw[-1:], 1)
    digits = raw[:-1] if raw[-1:] in _BUDGET_UNITS else raw
    if not digits.isdigit() or not digits:
        err_console.print(
            f"[red]Bad --budget[/red] '{value}' — expected milliseconds, <n>m, or <n>h"
        )
        raise typer.Exit(1)
    return int(digits) * unit


AgentOpt = Annotated[
    str | None,
    typer.Option(
        "--agent",
        help="Submit via an agent service's POST /workflow (submit-and-babysit) instead of "
        "workflow-svc directly. An agent name from the registry, or a full URL.",
    ),
]


def _resolve_agent(agent: str) -> str:
    url = resolve_agent_url(agent)
    if url is None:
        err_console.print(f"[red]Unknown agent[/red] '{agent}'")
        err_console.print("Known agents: " + ", ".join(sorted(AGENT_URLS)) + " (or a full URL)")
        raise typer.Exit(1)
    return url


@app.command()
def run(
    key: Annotated[str, typer.Argument(help="Saved workflow key (a published template).")],
    param: Annotated[
        list[str] | None,
        typer.Option(
            "--param", "-p", help="Fire-time param key=value; value '@path' splices a file."
        ),
    ] = None,
    instance_id: Annotated[
        str | None,
        typer.Option(
            "--instance-id",
            help="Stable, readable instance id for this run (becomes the worktree/workspace "
            "name instead of a generated GUID).",
        ),
    ] = None,
    fresh: Annotated[
        bool,
        typer.Option(
            "--fresh",
            help="Purge a FINISHED instance under --instance-id and re-run it. Without this, "
            "re-firing an existing instance id attaches to it instead of re-running.",
        ),
    ] = False,
    watch: Annotated[
        bool,
        typer.Option(
            "--watch",
            help="Register the run with workflow-svc's durable watcher engine "
            "(budget-terminate on breach; inspect with `h watch list`).",
        ),
    ] = False,
    budget: Annotated[
        str | None,
        typer.Option(
            "--budget",
            help="Watch wall-clock budget: milliseconds, <n>m, or <n>h (e.g. 45m). "
            "Implies --watch; defaults to 45m when --watch is set alone.",
        ),
    ] = None,
    retry: Annotated[
        int | None,
        typer.Option(
            "--retry",
            help="Watch retry policy: re-fire a failed run up to N attempts (fresh). "
            "Implies --watch.",
        ),
    ] = None,
    agent: AgentOpt = None,
) -> None:
    """Fire a saved workflow with fire-time params; prints the instance id.

    With --agent, the run is submitted through that agent service's babysitter (non-blocking
    supervision: terminal event or budget-terminate); without it, straight to workflow-svc.
    With --watch/--budget/--retry, workflow-svc's durable watcher engine supervises the run.
    """
    params = _parse_params(param or [])
    watch_policy: dict[str, Any] | None = None
    if watch or budget or retry is not None:
        watch_policy = {"maxDurationMs": _parse_budget(budget) if budget else DEFAULT_BUDGET_MS}
        if retry is not None:
            watch_policy["retry"] = {"maxAttempts": retry, "fresh": True}
    if agent:
        if watch_policy:
            err_console.print(
                "[red]--watch/--budget/--retry need workflow-svc's watcher engine[/red] — "
                "drop --agent (the agent babysitter carries its own policy)."
            )
            raise typer.Exit(1)
        agent_url = _resolve_agent(agent)
        body: dict[str, Any] = {"key": key}
        if params:
            body["params"] = params
        if instance_id:
            body["instanceId"] = instance_id
        if fresh:
            body["fresh"] = True
        result = _guarded(lambda: agent_service.submit_workflow(agent_url, body))
    else:
        result = _guarded(
            lambda: workflow_svc.run_saved(key, params, instance_id, fresh, watch_policy)
        )
    console.print_json(data=result)
    console.print(f"    watch it: h workflow status {result['instanceId']}")
    if watch_policy:
        console.print(f"    watching: {result.get('watching')}")
        console.print(f"    watch row: h watch get {result['instanceId']}")


@app.command()
def terminate(
    instance_id: Annotated[str, typer.Argument(help="Running workflow instance id.")],
) -> None:
    """Terminate a running workflow instance (short-circuit a stuck or unwanted run)."""
    console.print_json(data=_guarded(lambda: workflow_svc.terminate(instance_id)))
