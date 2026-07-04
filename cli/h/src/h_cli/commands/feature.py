"""h feature — the feature-request workflow, chart strategy.

The CLI sibling of cli/scripts/invoke-workflow-feature-helm.sh: same spec resolution and slug
rules, same seeding/trigger plumbing. `render` stops at the canonical YAML artifact; `run`
applies the JSON wire step, seeds the task (definition embedded), and triggers workflow-agent.
"""

import re
import sys
from pathlib import Path
from typing import Annotated

import httpx
import typer
import yaml
from rich.console import Console
from rich.syntax import Syntax

from h_cli.config import AGENT_URLS, FEATURE_SPECS_DIR, resolve_agent_url
from h_cli.infrastructure import agent_service, helm, statestore, workflow_agent

app = typer.Typer(no_args_is_help=True, help="Feature-request workflow (chart strategy).")
console = Console()
err_console = Console(stderr=True)

# The workflow-agent runs the pre-built definition verbatim and monitors — construction already
# happened at render time. Keep this text aligned with invoke-workflow-feature-helm.sh.
_RUN_VERBATIM_PREAMBLE = (
    "Run the pre-built workflow definition below EXACTLY as provided — do not add, remove, "
    "reorder, or rewrite steps, and do not save_workflow it. Call run_workflow with the "
    "instanceId and steps from the JSON under ===WORKFLOW DEFINITION===, then await_workflow "
    "on the returned instanceId (on TIMEOUT, call await_workflow again with the SAME "
    "instanceId). When COMPLETED, return the implement step's output verbatim."
    "\n\n===WORKFLOW DEFINITION===\n"
)


def _resolve_spec(spec: str) -> Path:
    """An existing path wins; otherwise try a bare name (with/without .md) under the spec home."""
    for cand in (Path(spec), FEATURE_SPECS_DIR / spec, FEATURE_SPECS_DIR / f"{spec}.md"):
        if cand.is_file():
            return cand
    err_console.print(f"[red]Could not resolve spec:[/red] {spec}")
    if FEATURE_SPECS_DIR.is_dir():
        names = sorted(p.stem for p in FEATURE_SPECS_DIR.glob("*.md"))
        if names:
            err_console.print("Available feature requests: " + ", ".join(names))
    raise typer.Exit(1)


def _derive_slug(spec_file: Path) -> str:
    """Sanitize the .md filename to a git-branch-safe token (same rules as the shell scripts)."""
    slug = re.sub(r"[^a-z0-9]+", "-", spec_file.stem.lower()).strip("-")
    if not slug:
        err_console.print(f"[red]Could not derive a slug from[/red] '{spec_file}' — pass --slug")
        raise typer.Exit(1)
    return slug


def _render(spec: str, slug: str | None) -> tuple[str, str]:
    spec_file = _resolve_spec(spec)
    resolved_slug = slug or _derive_slug(spec_file)
    try:
        rendered = helm.render_workflow(
            "feature",
            values={"feature.slug": resolved_slug},
            file_values={"feature.spec": spec_file},
        )
    except helm.HelmError as err:
        err_console.print(f"[red]helm:[/red] {err}")
        raise typer.Exit(1) from err
    return rendered, resolved_slug


SpecArg = Annotated[
    str,
    typer.Argument(help="A .md path, or a bare name under the feature-requests spec home."),
]
SlugOpt = Annotated[
    str | None,
    typer.Option(help="Branch/run slug (branch feature/<slug>); default: sanitized filename."),
]


@app.command()
def render(
    spec: SpecArg,
    slug: SlugOpt = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Apply the JSON wire step instead of canonical YAML.")
    ] = False,
) -> None:
    """Render the workflow definition and print it — no seeding, no run."""
    rendered, _ = _render(spec, slug)
    if as_json:
        print(helm.to_wire_json(rendered))
    elif sys.stdout.isatty():
        console.print(Syntax(rendered, "yaml", background_color="default"))
    else:
        print(rendered, end="")


@app.command()
def run(
    spec: SpecArg,
    slug: SlugOpt = None,
    agent: Annotated[
        str | None,
        typer.Option(
            "--agent",
            help="Submit via this agent service's POST /workflow (submit-and-babysit, "
            "non-blocking). An agent name from the registry, or a full URL. Without it, "
            "the legacy workflow-agent long-poll path runs.",
        ),
    ] = None,
    timeout: Annotated[
        int, typer.Option(help="Seconds to wait for the workflow-agent long-poll (legacy path).")
    ] = 1800,
) -> None:
    """Render and run the feature workflow.

    With --agent: the rendered definition is submitted to that agent's standard /workflow
    endpoint — 202 with the instanceId immediately, the agent's babysitter supervises the run
    (watch with `h workflow status <id>`). Without: the legacy blocking path (seed a task,
    long-poll workflow-agent).
    """
    rendered, resolved_slug = _render(spec, slug)
    console.print(
        f"==> Feature request -> slug '{resolved_slug}' "
        f"(branch feature/{resolved_slug}, chart-rendered)"
    )

    if agent:
        agent_url = resolve_agent_url(agent)
        if agent_url is None:
            err_console.print(f"[red]Unknown agent[/red] '{agent}'")
            err_console.print(
                "Known agents: " + ", ".join(sorted(AGENT_URLS)) + " (or a full URL)"
            )
            raise typer.Exit(1)
        definition = yaml.safe_load(rendered)
        body = {k: definition[k] for k in ("instanceId", "steps") if k in definition}
        try:
            result = agent_service.submit_workflow(agent_url, body)
        except httpx.HTTPError as err:
            err_console.print(f"[red]http:[/red] {err}")
            err_console.print(f"Is {agent} running and serving POST /workflow?")
            raise typer.Exit(1) from err
        console.print_json(data=result)
        console.print(f"    watch it: h workflow status {result['instanceId']}")
        return

    task_id = f"feature-helm-{resolved_slug}"
    try:
        console.print(f"==> Seeding task '{task_id}' into the state store")
        statestore.seed_task(task_id, _RUN_VERBATIM_PREAMBLE + helm.to_wire_json(rendered))
        with console.status(f"workflow-agent running '{task_id}' (run -> monitor)..."):
            result = workflow_agent.run_task(task_id, timeout_secs=timeout)
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Are workflow-agent and its sidecar running? (make dev-tab)")
        raise typer.Exit(1) from err
    console.print_json(data=result)
