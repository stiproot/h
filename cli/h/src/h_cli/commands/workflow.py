"""h workflow — workflow-svc surface: saved workflows, runs, instance status.

Spatial composition lives under the template noun (`h template compose`); this command owns the
definition/run level: publish, run, list, get, status, terminate.
"""

from typing import Annotated, Any

import httpx
import typer
import yaml
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from h_cli.config import (
    AGENT_IDENTITY,
    AGENT_URLS,
    FROZEN_EXECUTOR_KEYS,
    MODEL_PARAM_SLOTS,
    agent_identity_params,
    resolve_agent_url,
)
from h_cli.infrastructure import agent_service, helm, workflow_svc
from h_cli.params import parse_params

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

    Template config (clonePath, models, verifyCmd, …) bakes in from values.yaml +
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
            # Stored param DEFAULTS (fire-time identity, §1.9 of chain-composition-surface):
            # the render emits e.g. {runActivity, agentId} from values; fire-time params
            # override them key-by-key.
            params=definition.get("params"),
            schedule=schedule,
            workspace_id=workspace_id,
            disabled=disabled if (disabled or schedule) else None,
        )
    )
    console.print(f"==> Published template '{template}' as saved workflow '{result['key']}'")
    if schedule:
        state = "DISABLED — re-publish without --disabled to arm" if disabled else "armed"
        console.print(f"    schedule: '{schedule}' ({state})")
    console.print(
        f"    fire it: h workflow run {result['key']} -p slug=... -p spec=@file.md "
        "--agent claude --model <model>"
    )


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


ViaOpt = Annotated[
    str | None,
    typer.Option(
        "--via",
        help="Submit THROUGH an agent service's POST /workflow (submit-and-babysit) instead of "
        "workflow-svc directly — a routing/transport choice, not identity. An agent name from "
        "the registry, or a full URL. (Contrast --agent, which selects who RUNS the steps.)",
    ),
]


def _resolve_via(via: str) -> str:
    url = resolve_agent_url(via)
    if url is None:
        err_console.print(f"[red]Unknown --via agent[/red] '{via}'")
        err_console.print("Known agents: " + ", ".join(sorted(AGENT_URLS)) + " (or a full URL)")
        raise typer.Exit(1)
    return url


def _identity_params(key: str, agent: str) -> dict[str, str]:
    """`--agent NAME` → the {runActivity, agentId} fire-time params (shared with `h chain run`).

    The pr-review executor is frozen (untrusted-input security invariant) — warn and apply
    nothing; the template has no identity slots, so the params would be inert anyway.
    """
    if key in FROZEN_EXECUTOR_KEYS:
        err_console.print(
            f"[yellow]warning:[/yellow] --agent '{agent}' ignored on '{key}': its executor is "
            "frozen (untrusted-input security invariant, docs/plans/reviewer-identity-security.md)"
        )
        return {}
    params = agent_identity_params(agent)
    if params is None:
        err_console.print(
            f"[red]unknown --agent[/red] '{agent}' — known: "
            + ", ".join(sorted(set(AGENT_IDENTITY)))
        )
        raise typer.Exit(1)
    return params


@app.command()
def run(
    key: Annotated[str, typer.Argument(help="Saved workflow key (a published template).")],
    param: Annotated[
        list[str] | None,
        typer.Option(
            "--param", "-p", help="Fire-time param key=value; value '@path' splices a file."
        ),
    ] = None,
    inline: Annotated[
        bool,
        typer.Option(
            "--inline",
            help="Treat the argument as a TEMPLATE name, not a saved key: render it (compose-on-fire, "
            "sibling to chain -t) and fire its steps directly — no publish, leaving only the wf: "
            "status row. -p/--agent/--model override the template's value-defaults.",
        ),
    ] = False,
    agent: Annotated[
        str | None,
        typer.Option(
            "--agent",
            help="Executor machinery: which agent RUNS the steps — expands to the "
            "{runActivity, agentId} fire-time params. Contrast --via (routing).",
        ),
    ] = None,
    model: Annotated[
        str | None,
        typer.Option(
            "--model",
            help="Execution machinery: the model the run uses — sets the template's model slots "
            f"({', '.join(MODEL_PARAM_SLOTS)}). (Template content values ride -p key=value.)",
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
    via: ViaOpt = None,
) -> None:
    """Fire a saved workflow (or, with --inline, a template rendered on the fly) with fire-time
    params; prints the instance id.

    Template CONTENT values are populated with `-p key=value` (a template's param space is
    unbounded, so it gets one uniform syntax; `@path` splices a file). FLAGS are the closed
    machinery vocabulary: --agent (executor) and --model (which model) are execution machinery;
    --fresh re-runs, --instance-id names the run, --via ROUTES the submit through an agent's
    babysitter, and --watch/--budget/--retry hand the run to workflow-svc's durable watcher engine.

    --inline reinterprets the argument as a chart TEMPLATE name: it renders the template
    (compose-on-fire, the sibling of chain -t) and fires its steps directly — no publish, no saved
    definition, leaving only the wf: status row. Use it for a one-off; publish when a definition
    must be reusable or fired by a trigger/cron.
    """
    params = parse_params(param or [])
    if agent:
        params.update(_identity_params(key, agent))
    if model:
        for slot in MODEL_PARAM_SLOTS:
            params[slot] = model
    watch_policy: dict[str, Any] | None = None
    if watch or budget or retry is not None:
        watch_policy = {"maxDurationMs": _parse_budget(budget) if budget else DEFAULT_BUDGET_MS}
        if retry is not None:
            watch_policy["retry"] = {"maxAttempts": retry, "fresh": True}
    if inline:
        if via:
            err_console.print(
                "[red]--inline fires directly on workflow-svc[/red] — drop --via (routing "
                "an inline definition through an agent babysitter is a separate path)."
            )
            raise typer.Exit(1)
        try:
            rendered = helm.render_workflow(key, values={"publish": "true"})
        except helm.HelmError as err:
            err_console.print(f"[red]helm:[/red] {err}")
            err_console.print(f"Is '{key}' a chart template (cli/charts/workflows/templates)?")
            raise typer.Exit(1) from err
        definition = yaml.safe_load(rendered) or {}
        steps = definition.get("steps")
        if not steps:
            err_console.print(f"[red]Template '{key}' rendered no steps[/red] — check its values.")
            raise typer.Exit(1)
        # Merge -p/--agent/--model OVER the template's rendered value-defaults (there is no stored
        # definition to merge against server-side, so the CLI does it — same result as a saved fire).
        merged = {**(definition.get("params") or {}), **params}
        result = _guarded(
            lambda: workflow_svc.run_steps(steps, merged, instance_id, fresh, watch_policy)
        )
    elif via:
        if watch_policy:
            err_console.print(
                "[red]--watch/--budget/--retry need workflow-svc's watcher engine[/red] — "
                "drop --via (the agent babysitter carries its own policy)."
            )
            raise typer.Exit(1)
        via_url = _resolve_via(via)
        body: dict[str, Any] = {"key": key}
        if params:
            body["params"] = params
        if instance_id:
            body["instanceId"] = instance_id
        if fresh:
            body["fresh"] = True
        result = _guarded(lambda: agent_service.submit_workflow(via_url, body))
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
