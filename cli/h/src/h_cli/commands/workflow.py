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

from h_cli.commands._local_journal import journal_preflight as _journal_preflight
from h_cli.commands.template import compose_templates, refuse_overlay, template_name_for_key
from h_cli.config import (
    AGENT_IDENTITY,
    AGENT_RUNS_DIR,
    AGENT_URLS,
    FROZEN_EXECUTOR_KEYS,
    LOCAL_WORKTREES_DIR,
    MODEL_PARAM_SLOTS,
    agent_identity_params,
    baked_models_suit,
    chart_root_for,
    resolve_agent_url,
)
from h_cli.infrastructure import agent_service, helm, local_runtime, workflow_svc, workspace
from h_cli.infrastructure.local_runtime import LocalRunError, group_id, repo_root
from h_cli.infrastructure.panelize import PanelizeError, panelize, roster_pairs
from h_cli.params import parse_params

app = typer.Typer(no_args_is_help=True, help="Saved workflows and instance status (workflow-svc).")

# Per-agent-step wall-clock budget on the local substrate. There is no watcher here to terminate
# a runaway, so the timeout IS the budget — matching the agent services' AGENT_RUN_TIMEOUT_MS.
LOCAL_STEP_TIMEOUT_MS = 1_800_000
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
        typer.Argument(
            help="Chart template (cli/charts/workflows/templates/<template>.tmpl.yaml)."
        ),
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
    refuse_overlay(template, "publish")
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
            # Declared output schema — the template's typed output signature, when it renders one.
            outputs=definition.get("outputs"),
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


def _render_template(name: str) -> dict[str, Any]:
    """Render a chart template in publish mode and return the parsed definition (with steps)."""
    try:
        rendered = helm.render_workflow(name, values={"publish": "true"})
    except helm.HelmError as err:
        err_console.print(f"[red]helm:[/red] {err}")
        err_console.print(f"Is '{name}' a chart template (cli/charts/workflows/templates)?")
        raise typer.Exit(1) from err
    definition = yaml.safe_load(rendered) or {}
    if not isinstance(definition, dict) or not definition.get("steps"):
        err_console.print(f"[red]Template '{name}' rendered no steps[/red] — check its values.")
        raise typer.Exit(1)
    return definition


def _inline_definition(names: list[str]) -> dict[str, Any]:
    """Render the operands of an `--inline` fire into ONE definition.

    A SINGLE operand renders standalone — the behaviour --inline always had. SEVERAL operands
    overlay left-to-right through `compose_templates`, the same core `h template compose` and
    chain's `-t` groups use, which renders every atom in COMPOSABLE mode: `implement` then commits
    locally instead of leaving a dirty tree, so a composed-in `create-pr` has something to push.

    That mode switch is what composition MEANS here, which is why it keys off the operand count
    rather than a separate flag — `h workflow run implement verify --inline` is the unpersisted
    twin of `h template compose implement verify --save k` + `h workflow run k`, and --save stays
    what it always was: optional, for when the definition must outlive the fire.
    """
    return _render_template(names[0]) if len(names) == 1 else compose_templates(names)


def _roster_definition(keys: list[str], inline: bool) -> dict[str, Any]:
    """A roster fires a PANELIZED definition, so it must
    compose-on-fire: render the chart template of that name when one exists (`outputs` AND
    `panelSynthesis` flow from the render; --inline forces the template reading), else fall back
    to the stored definition (generic synthesis prose)."""
    if inline:
        return _inline_definition(keys)
    key = keys[0]
    template_name = template_name_for_key(key)
    if chart_root_for(template_name) is not None:
        return _render_template(template_name)
    stored = _guarded(lambda: workflow_svc.get(key))
    if not isinstance(stored, dict) or not stored.get("steps"):
        err_console.print(f"[red]saved workflow '{key}' has no steps to panelize[/red]")
        raise typer.Exit(1)
    return stored


def _refuse_engine_flags(flags: dict[str, Any]) -> None:
    """Refuse, by name, the flags that need machinery the local substrate does not have.

    Every one of these hands the run to an ENGINE — supervision, recurrence, scheduling — or to
    another service. Local execution declines them rather than ignoring them: silently dropping
    `--cron` would report a recurrence that was never armed. This IS the boundary between the two
    substrates, so the message names the engine each flag needs.
    """
    used = [name for name, value in flags.items() if value]
    if not used:
        return
    err_console.print(
        f"[red]{', '.join(used)} need workflow-svc's engines[/red] — drop --local to use them "
        "(the watcher, cron and schedule engines live on the service substrate; local execution "
        "runs in this process, so the driver is the supervisor)."
    )
    raise typer.Exit(1)


def _identity_params(key: str, agent: str) -> dict[str, str]:
    """`--agent NAME` → the {runActivity, agentId} fire-time params (shared with `h chain run`).

    The review-pr executor is frozen (untrusted-input security invariant) — warn and apply
    nothing; the template has no identity slots, so the params would be inert anyway.
    """
    if key in FROZEN_EXECUTOR_KEYS:
        err_console.print(
            f"[yellow]warning:[/yellow] --agent '{agent}' ignored on '{key}': its executor is "
            "frozen"
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
    keys: Annotated[
        list[str],
        typer.Argument(
            help="Saved workflow key (a published template). With --inline, one or more chart "
            "TEMPLATE names instead, overlaid left-to-right.",
            metavar="KEY | TEMPLATE...",
        ),
    ],
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
            help="Treat the arguments as chart TEMPLATE names, not a saved key: render them "
            "(compose-on-fire, sibling to chain -t) and fire the steps directly — no publish, "
            "leaving only the wf: status row. SEVERAL names overlay into one workflow (one "
            "instanceId, one worktree), rendered in composable mode exactly as `h template "
            "compose` would — so --save is for when a definition must OUTLIVE the fire, never a "
            "precondition for composing one. -p/--agent/--model override the value-defaults.",
        ),
    ] = False,
    agent: Annotated[
        list[str] | None,
        typer.Option(
            "--agent",
            help="Executor machinery: which agent RUNS the steps — expands to the "
            "{runActivity, agentId} fire-time params. REPEAT the flag for a panel ROSTER "
            "(--agent claude --agent codex): the definition is panelized — each roster agent "
            "answers concurrently, a pinned judge synthesizes under the workflow's own contract "
            "— and fired inline. Contrast --via (routing).",
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
    cron: Annotated[
        str | None,
        typer.Option(
            "--cron",
            help="Recur this workflow on this cadence (5-field cron, UTC) until its goal resolves "
            "or the budget is spent. Registers a cron:sub row (needs repo+slug params for the "
            "identity); inspect with `h cron list`.",
        ),
    ] = None,
    max_fires: Annotated[
        int | None,
        typer.Option(
            "--max-fires",
            help="Cron budget: deactivate after N fires (default 100). Implies --cron.",
        ),
    ] = None,
    fallback_agent: Annotated[
        str | None,
        typer.Option(
            "--fallback-agent",
            help="On an LLM usage/rate limit, CONTINUE the run under this agent (claude|openhands|"
            "pi). Arms a deferred cron:sched continuation reusing the workspace. Implies --watch.",
        ),
    ] = None,
    fallback_model: Annotated[
        str | None,
        typer.Option(
            "--fallback-model",
            help="Model for the usage-limit fallback continuation (sets the identity model slots). "
            "Implies --watch.",
        ),
    ] = None,
    fallback_after: Annotated[
        str | None,
        typer.Option(
            "--fallback-after",
            help="Delay before the fallback continuation fires (ms, <n>m, or <n>h; e.g. 10m) — to "
            "let the original provider's window refresh. Default 0.",
        ),
    ] = None,
    fallback_max: Annotated[
        int | None,
        typer.Option(
            "--fallback-max",
            help="Max fallback handoffs (fail-closed budget; default 1). Implies --fallback-agent.",
        ),
    ] = None,
    at: Annotated[
        str | None,
        typer.Option(
            "--at",
            help="Schedule this workflow to fire ONCE at an absolute time (ISO 8601, UTC, e.g. "
            "2026-07-20T09:00:00Z) instead of now. Arms a cron:sched row; inspect with "
            "`h schedule list`. Mutually exclusive with --in and --cron.",
        ),
    ] = None,
    in_: Annotated[
        str | None,
        typer.Option(
            "--in",
            help="Schedule this workflow to fire ONCE after a relative delay (e.g. 45s, 30m, 2h, "
            "1d) instead of now. Arms a cron:sched row. Mutually exclusive with --at and --cron.",
        ),
    ] = None,
    via: ViaOpt = None,
    local: Annotated[
        bool,
        typer.Option(
            "--local",
            help="Execute on the LOCAL substrate: render the template and run its steps in this "
            "process, driving the agent CLIs as local children — no Dapr, no services, no "
            "registries. Same definition, same contracts; flags that need an engine are refused.",
        ),
    ] = False,
    with_setup: Annotated[
        bool,
        typer.Option(
            "--with-setup",
            help="--local only: run the definition's setup steps. Off by default because they "
            "provision the OPERATOR's own HOME (~/.claude) on this substrate, not a container's.",
        ),
    ] = False,
    allow_external: Annotated[
        bool,
        typer.Option(
            "--allow-external",
            help="--local only: run from a checkout outside the workspace h manages. "
            "Deliberately a flag you type per fire, not a config you can forget you set.",
        ),
    ] = False,
    resume: Annotated[
        str | None,
        typer.Option(
            "--resume",
            metavar="INSTANCE",
            help="--local only: CONTINUE the journaled run named by this instance id instead of "
            "starting a new one — completed steps replay from the journal (paid work is not "
            "re-paid). The composition must match the journaled one; a changed workflow is a "
            "new run and is refused.",
        ),
    ] = None,
    no_journal: Annotated[
        bool,
        typer.Option(
            "--no-journal",
            help="--local only: skip the run journal (no fabric involved, nothing resumable). "
            "For throwaway runs or a machine without nats-server provisioned.",
        ),
    ] = False,
) -> None:
    """Fire a saved workflow (or, with --inline, a template rendered on the fly) with fire-time
    params; prints the instance id.

    Template CONTENT values are populated with `-p key=value` (a template's param space is
    unbounded, so it gets one uniform syntax; `@path` splices a file). FLAGS are the closed
    machinery vocabulary: --agent (executor) and --model (which model) are execution machinery;
    --fresh re-runs, --instance-id names the run, --via ROUTES the submit through an agent's
    babysitter, and --watch/--budget/--retry hand the run to workflow-svc's durable watcher engine.

    --inline reinterprets the arguments as chart TEMPLATE names: it renders them (compose-on-fire,
    the sibling of chain -t) and fires the steps directly — no publish, no saved definition,
    leaving only the wf: status row. SEVERAL names overlay into ONE workflow, so a composition
    never has to be persisted just to run once:

        h workflow run implement verify --inline --local -p slug=x -p spec=@s.md

    Use it for a one-off; publish (`h template compose … --save`) when a definition must be
    reusable or fired by a trigger/cron.
    """
    params = parse_params(param or [])
    roster = tuple(agent) if agent and len(agent) > 1 else ()
    if not keys:
        err_console.print(
            "[red]a saved workflow key is required[/red] (or, with --inline, one or more "
            "template names)."
        )
        raise typer.Exit(1)
    if len(keys) > 1 and not inline:
        err_console.print(
            f"[red]only one saved workflow key may be named[/red] — got {len(keys)}: "
            f"{', '.join(keys)}. To overlay several chart TEMPLATES into one workflow, add "
            "--inline; to fire a stored composition, compose it first "
            "(`h template compose … --save <key>`)."
        )
        raise typer.Exit(1)
    if len(keys) > 1 and cron:
        # A recurrence needs a NAMEABLE definition: the cron row and the wf: row it mirrors are
        # keyed by workflow name, and an ad-hoc overlay has none that would still mean the same
        # thing on a later tick. Publishing the composition first gives it that identity.
        err_console.print(
            "[red]--cron needs ONE named workflow[/red] — a recurring fire is identified by "
            "its key in the cron: and wf: rows, which an ad-hoc overlay does not have. Persist "
            f"the composition first: `h template compose {' '.join(keys)} --save <key>` then "
            "`h workflow run <key> --cron …`."
        )
        raise typer.Exit(1)
    key = keys[0]
    if local:
        _refuse_engine_flags(
            {
                "--via": via,
                "--cron": cron,
                "--max-fires": max_fires,
                "--watch": watch or None,
                "--budget": budget,
                "--retry": retry,
                "--fallback-agent": fallback_agent,
                "--fallback-model": fallback_model,
                "--fallback-after": fallback_after,
                "--fallback-max": fallback_max,
                "--at": at,
                "--in": in_,
                "--fresh": fresh or None,
            }
        )
    elif with_setup:
        err_console.print("[red]--with-setup applies to --local only[/red]")
        raise typer.Exit(1)
    if allow_external and not local:
        err_console.print("[red]--allow-external applies to --local only[/red]")
        raise typer.Exit(1)
    if not local:
        # The journal is the LOCAL substrate's durability; the service substrate's is the Dapr
        # engine's own. Refused by name so nobody reads --resume as a generic retry flag.
        if resume:
            err_console.print(
                "[red]--resume applies to --local only[/red] (the service substrate resumes "
                "via its engine)"
            )
            raise typer.Exit(1)
        if no_journal:
            err_console.print("[red]--no-journal applies to --local only[/red]")
            raise typer.Exit(1)
    if resume and no_journal:
        err_console.print(
            "[red]--resume needs the journal it would replay[/red] — drop --no-journal"
        )
        raise typer.Exit(1)
    if resume and instance_id:
        err_console.print(
            "[red]--resume already names the instance[/red] — drop --instance-id "
            "(the journaled group id IS the instance)"
        )
        raise typer.Exit(1)
    if inline:
        refuse_overlay(key, "run")
    elif roster:
        template_name = template_name_for_key(key)
        if chart_root_for(template_name) is not None:
            refuse_overlay(template_name, "run")
    if agent and not roster:
        params.update(_identity_params(key, agent[0]))
        # A baked model belongs to the executor it was chosen for. When the user reassigns
        # the executor without also naming a model, clear the model param slots so the
        # saved default is overridden — the new executor's default model may not suit the
        # template's task, and the runner-side `||` fixes handle "" correctly.
        # An explicit --model still wins below.
        if not model and not baked_models_suit(agent[0]):
            for slot in MODEL_PARAM_SLOTS:
                params[slot] = ""
    if model:
        for slot in MODEL_PARAM_SLOTS:
            params[slot] = model
        # When --model is given alongside a roster, it is applied to every branch via panelize's
        # model_override; params go to the template, not individual branches.
    if roster and (via or cron or max_fires is not None or at or in_):
        err_console.print(
            "[red]a roster fires a panelized definition inline[/red] — drop --via/--cron/"
            "--at/--in (panel + recurrence/routing composes via `h chain run`)."
        )
        raise typer.Exit(1)
    watch_policy: dict[str, Any] | None = None
    if watch or budget or retry is not None:
        watch_policy = {"maxDurationMs": _parse_budget(budget) if budget else DEFAULT_BUDGET_MS}
        if retry is not None:
            watch_policy["retry"] = {"maxAttempts": retry, "fresh": True}
    # Usage-limit fallback: on a rate limit, continue under a different agent/model after a delay.
    fallback_wanted = (
        fallback_agent is not None
        or fallback_model is not None
        or fallback_after is not None
        or fallback_max is not None
    )
    if fallback_wanted:
        if fallback_agent is None and fallback_model is None:
            err_console.print(
                "[red]--fallback needs --fallback-agent and/or --fallback-model[/red]"
            )
            raise typer.Exit(1)
        identity: dict[str, str] = {}
        if fallback_agent:
            identity.update(_identity_params(key, fallback_agent))
        if fallback_model:
            for slot in MODEL_PARAM_SLOTS:
                identity[slot] = fallback_model
        fallback: dict[str, Any] = {
            "onOutcome": ["usage-limited"],
            "identity": identity,
            "maxHandoffs": fallback_max if fallback_max is not None else 1,
        }
        if fallback_after:
            fallback["after"] = _parse_budget(fallback_after)
        # --fallback implies --watch (a fallback rides the watch policy).
        if watch_policy is None:
            watch_policy = {"maxDurationMs": DEFAULT_BUDGET_MS}
        watch_policy["fallback"] = fallback
    cron_policy: dict[str, Any] | None = None
    if cron or max_fires is not None:
        if not cron:
            err_console.print("[red]--max-fires needs --cron[/red]")
            raise typer.Exit(1)
        cron_policy = {"cadence": cron}
        if max_fires is not None:
            cron_policy["budget"] = {"maxFires": max_fires}
    scheduled = at is not None or in_ is not None
    if scheduled:
        if at is not None and in_ is not None:
            err_console.print("[red]--at and --in are mutually exclusive[/red]")
            raise typer.Exit(1)
        if cron_policy:
            err_console.print(
                "[red]--at/--in (one-shot) cannot combine with --cron (recurring)[/red]"
            )
            raise typer.Exit(1)
        if inline or via:
            err_console.print(
                "[red]--at/--in schedule a SAVED workflow[/red] — drop --inline/--via "
                "(a scheduled fire arms a cron:sched row on workflow-svc)."
            )
            raise typer.Exit(1)
    if local:
        # The boundary check its siblings already make (delegate --cwd, events serve --repo):
        # the invoking checkout is the run's repoPath — worktrees are cut from it and the agent
        # works in it as the operator — so it must be a checkout h manages.
        try:
            workspace.assert_managed(
                Path(repo_root(Path.cwd())), allow_external=allow_external, flag="--local: cwd"
            )
        except workspace.ExternalWorkspaceError as err:
            err_console.print(f"[red]local:[/red] {err}")
            raise typer.Exit(1) from err
        except LocalRunError as err:
            err_console.print(f"[red]local:[/red] {err}")
            raise typer.Exit(1) from err
        # The local substrate composes on the fly: there is no saved-workflow store to read
        # (a registry is engine machinery), so the argument names a chart TEMPLATE and the
        # rendered definition IS the artifact — the same one the service path would have POSTed.
        template_names = keys if inline else [template_name_for_key(key)]
        # Only the FIRST operand must be a complete workflow — later ones are overlays by design
        # (that is what composing them means), so the base is the one that has to stand alone.
        refuse_overlay(template_names[0], "run")
        definition = _inline_definition(template_names)
        template_name = " ⊕ ".join(template_names)
        if roster:
            try:
                definition = panelize(
                    definition, roster_pairs(roster, AGENT_IDENTITY), model_override=model
                )
            except PanelizeError as err:
                err_console.print(f"[red]cannot panelize '{key}':[/red] {err}")
                raise typer.Exit(1) from err
            console.print(f"==> panelized '{key}' — roster: {', '.join(roster)} (judge: claude)")
        merged = {**(definition.get("params") or {}), **params}
        _run_local(
            template_name,
            definition,
            merged,
            instance_id,
            with_setup,
            resume=resume,
            no_journal=no_journal,
        )
        return
    if roster:
        # Panel path: panelize the definition and fire the
        # steps inline (leaving only the wf: status row) — the roster restructures the
        # definition, so there is no stored def to fire verbatim. The review-pr executor freeze
        # relaxes for a roster: the panelists run as named, the judge stays pinned (claude).
        # When --model is given, it is applied to every branch; without it the baked model is
        # stripped and a warning is emitted.
        definition = _roster_definition(keys, inline)
        baked_model = ""
        for step in definition.get("steps") or []:
            inp = step.get("input") or {}
            if inp.get("outputContract") and inp.get("model"):
                baked_model = inp["model"]
                break
        try:
            panelized = panelize(
                definition, roster_pairs(roster, AGENT_IDENTITY), model_override=model
            )
        except PanelizeError as err:
            err_console.print(f"[red]cannot panelize '{key}':[/red] {err}")
            raise typer.Exit(1) from err
        if baked_model and not model:
            err_console.print(
                f"[yellow]warning:[/yellow] panelized '{key}' — model "
                f"'{baked_model}' stripped from branches; each panelist uses its own "
                f"AGENT_MODEL (roster: {', '.join(roster)})"
            )
        merged = {**(definition.get("params") or {}), **params}
        model_note = f" (model: {model})" if model else ""
        console.print(
            f"==> panelized '{key}' — roster: {', '.join(roster)} (judge: claude){model_note}"
        )
        result = _guarded(
            lambda: workflow_svc.run_steps(
                panelized["steps"], merged, instance_id, fresh, watch_policy, None, None
            )
        )
    elif inline:
        if via:
            err_console.print(
                "[red]--inline fires directly on workflow-svc[/red] — drop --via (routing "
                "an inline definition through an agent babysitter is a separate path)."
            )
            raise typer.Exit(1)
        definition = _inline_definition(keys)
        steps = definition.get("steps")
        # Merge -p/--agent/--model OVER the template's rendered value-defaults (there is no stored
        # definition to merge against server-side, so the CLI does it — same result as a saved
        # fire).
        merged = {**(definition.get("params") or {}), **params}
        # --inline --cron: recur these very steps over an EMBEDDED source (nothing published to
        # re-hydrate). The cron key mirrors the wf: coords, so it needs repo+slug params + the
        # wf-identity, exactly like a saved --cron
        # .
        arm_cron: dict[str, Any] | None = None
        wf: dict[str, Any] | None = None
        if cron_policy:
            repo, slug = merged.get("repo"), merged.get("slug")
            if not repo or not slug:
                err_console.print(
                    "[red]--inline --cron needs repo and slug params[/red] "
                    "(-p repo=owner/name -p slug=…) — the cron key mirrors the wf: coords."
                )
                raise typer.Exit(1)
            wf = {"repo": repo, "slug": slug, "workflow": key}
            arm_cron = {"cadence": cron_policy["cadence"], "workflow": key, "inline": True}
            if "budget" in cron_policy:
                arm_cron["budget"] = cron_policy["budget"]
        result = _guarded(
            lambda: workflow_svc.run_steps(
                steps, merged, instance_id, fresh, watch_policy, arm_cron, wf
            )
        )
    elif via:
        if watch_policy or cron_policy:
            err_console.print(
                "[red]--watch/--budget/--retry/--cron need workflow-svc's engines[/red] — "
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
            lambda: workflow_svc.run_saved(
                key, params, instance_id, fresh, watch_policy, cron_policy, at, in_
            )
        )
    console.print_json(data=result)
    # A scheduled run ARMED a one-shot (no instance yet); a normal run has an instanceId.
    if scheduled:
        console.print(
            f"    scheduled: fires at {result.get('fireAt')} — inspect with h schedule list"
        )
        console.print(f"    cancel it: h schedule rm {result.get('scheduled')}")
        return
    console.print(f"    watch it: h workflow status {result['instanceId']}")
    if cron_policy:
        console.print(f"    recurring: {cron.strip()} — inspect with h cron list")
    if watch_policy:
        console.print(f"    watching: {result.get('watching')}")
        console.print(f"    watch row: h watch get {result['instanceId']}")
        if watch_policy.get("fallback"):
            console.print(
                "    fallback: on usage-limit → continues under "
                f"{fallback_agent or fallback_model} (see h schedule list when armed)"
            )


def _run_local(
    template: str,
    definition: dict[str, Any],
    params: dict[str, Any],
    instance_id: str | None,
    with_setup: bool,
    resume: str | None = None,
    no_journal: bool = False,
) -> None:
    """Execute a rendered definition on the local substrate and report what its steps produced.

    A `--resume INSTANCE` run REUSES the journaled group id (the composition must hash-match
    the journal; the executor refuses otherwise) instead of minting or taking a fresh one.
    """
    group = resume if resume else (instance_id or group_id(template))
    job: dict[str, Any] = {
        "kind": "workflow",
        "steps": definition["steps"],
        "params": params,
        "group": group,
        "runsDir": str(AGENT_RUNS_DIR),
        "timeoutMs": LOCAL_STEP_TIMEOUT_MS,
        "worktreeRoot": str(LOCAL_WORKTREES_DIR),
        # The checkout the operator invoked from is the default worktree source; a
        # template's own clonePath param still wins per step (the multi-repo knob).
        "repoPath": repo_root(Path.cwd()),
        **({"withSetup": True} if with_setup else {}),
    }
    if not no_journal:
        job["journal"] = _journal_preflight(resume)
    try:
        envelope = local_runtime.run_job(job)
    except LocalRunError as err:
        err_console.print(f"[red]local:[/red] {err}")
        raise typer.Exit(1) from err
    if envelope.get("note"):
        err_console.print(f"[yellow]{envelope['note']}[/yellow]")

    results: dict[str, Any] = envelope.get("results") or {}
    # The last step that produced agent output is what the run was FOR; earlier steps are
    # plumbing whose results were threaded onward.
    final = next(
        (
            value
            for key_, value in reversed(list(results.items()))
            if key_ != "params" and isinstance(value, dict) and value.get("output")
        ),
        None,
    )
    # The agent's own output already contains its fenced json block, so printing the validated
    # value again would just echo it. Validation's job is to GATE the step, not to reformat it.
    if final:
        console.print(final["output"])

    if not envelope.get("ok"):
        failed = envelope.get("failedStep")
        err_console.print(
            f"[red]step '{failed}' failed:[/red] {envelope.get('error', 'no detail')}"
            if failed
            else f"[red]local:[/red] {envelope.get('error', 'no detail')}"
        )
        raise typer.Exit(1)
    contract = " · output contract validated" if final and final.get("structured") else ""
    err_console.print(
        f"[green]done[/green] · {group}{contract} — runs under {AGENT_RUNS_DIR}/{group}"
    )


@app.command()
def terminate(
    instance_id: Annotated[str, typer.Argument(help="Running workflow instance id.")],
) -> None:
    """Terminate a running workflow instance (short-circuit a stuck or unwanted run)."""
    console.print_json(data=_guarded(lambda: workflow_svc.terminate(instance_id)))


@app.command()
def pause(
    instance_id: Annotated[str, typer.Argument(help="Running workflow instance id to pause.")],
    key: Annotated[str, typer.Argument(help="Saved workflow key to resume (the running one).")],
    at: Annotated[
        str | None,
        typer.Option("--at", help="Resume at an absolute time (ISO 8601, UTC)."),
    ] = None,
    in_: Annotated[
        str | None,
        typer.Option("--in", help="Resume after a relative delay (e.g. 45s, 30m, 2h, 1d)."),
    ] = None,
    param: Annotated[
        list[str] | None,
        typer.Option("--param", "-p", help="Fire-time param key=value for the resumed run."),
    ] = None,
    workspace_id: Annotated[
        str | None,
        typer.Option(
            "--workspace-id",
            help="Workspace to reuse on resume (default: the paused instance's own id).",
        ),
    ] = None,
) -> None:
    """Pause a running workflow and resume it later (stop-and-continue): terminate the instance NOW
    and arm a one-shot that re-fires the saved workflow after the delay, REUSING the paused run's
    workspace (worktree/state carry over). Meant for waiting out a rate-limit refresh window.

    The resumed run re-enters the workflow from the top — mid-step progress rides the persisted
    worktree + the agent's own session resume, not a frozen fiber. Exactly one of --at/--in."""
    if (at is None) == (in_ is None):
        err_console.print("[red]pass exactly one of --at / --in[/red]")
        raise typer.Exit(1)
    params = parse_params(param or [])
    result = _guarded(
        lambda: workflow_svc.pause(instance_id, key, params or None, at, in_, workspace_id)
    )
    console.print_json(data=result)
    console.print(
        f"    paused {result.get('paused')} → resumes at {result.get('fireAt')} "
        f"(reusing its workspace)"
    )
    console.print(f"    resume now:  h workflow resume {result.get('scheduled')}")
    console.print(f"    cancel:      h schedule rm {result.get('scheduled')}")


@app.command()
def resume(
    sched_id: Annotated[
        str, typer.Argument(help="The paused schedule id (from `h workflow pause` / `h schedule`).")
    ],
) -> None:
    """Resume a paused workflow NOW, before its scheduled time (advance the one-shot to fire on the
    next tick, ≤60s)."""
    result = _guarded(lambda: workflow_svc.resume(sched_id))
    console.print_json(data=result)
    console.print(f"    resuming {sched_id} — fires within a tick; watch with h schedule list")
