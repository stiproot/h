"""Composition root for the h CLI — wires the command groups onto one Typer app.

Early prototype (see cli/README.md): each subcommand ports one proven vertical slice of the
cli/scripts machinery; the shell scripts remain the executable spec until a subcommand has
demonstrably replaced them.
"""

import json

import typer

from h_cli import config
from h_cli.commands import (
    agents,
    chain,
    cron,
    events,
    feature,
    runs,
    schedule,
    template,
    watch,
    workflow,
    worktrees,
)
from h_cli.commands.delegate import delegate
from h_cli.commands.doctor import doctor
from h_cli.commands.status import status

app = typer.Typer(
    no_args_is_help=True,
    help="h — the harness CLI (early prototype). Chart-rendered workflows and workflow-svc views.",
)
app.add_typer(agents.app, name="agents")
app.add_typer(feature.app, name="feature")
app.add_typer(template.app, name="template")
app.add_typer(chain.app, name="chain")
app.add_typer(watch.app, name="watch")
app.add_typer(cron.app, name="cron")
app.add_typer(schedule.app, name="schedule")
app.add_typer(workflow.app, name="workflow")
app.add_typer(worktrees.app, name="worktrees")
app.add_typer(runs.app, name="runs")
app.command("status")(status)
# The consumer's one-screen toolchain report; refusals stay at each surface's point of use.
app.command("doctor")(doctor)
# The local execution substrate's atom: agent CLIs as local child processes, no services.
app.command("delegate")(delegate)
# The local substrate's event fabric: NATS JetStream + the relay (h events serve).
app.add_typer(events.app, name="events")


def _version(value: bool) -> None:
    """`h --version` — WHICH h this is, not just which release series.

    A consumer repo pins h by COMMIT (every wheel from main shares one version number), so a
    sync script needs a machine-readable identity to compare its lock against. `--version`
    prints it for a human; `--version-json` is the one a script parses.
    """
    if not value:
        return
    info = config.build_info()
    short, at = info.get("shortCommit"), info.get("committedAt")
    where = f"@{short}" if short else " (commit unknown — wheel built without provenance)"
    dirty = " +dirty" if info.get("dirty") else ""
    when = f", {str(at)[:10]}" if at else ""
    typer.echo(f"h-cli {info['version']}{where}{dirty} [{info['mode']}{when}]")
    raise typer.Exit()


def _version_json(value: bool) -> None:
    if not value:
        return
    typer.echo(json.dumps(config.build_info(), indent=2))
    raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        callback=_version,
        is_eager=True,
        help="Show h's version and source commit.",
    ),
    version_json: bool = typer.Option(
        False,
        "--version-json",
        callback=_version_json,
        is_eager=True,
        help="Machine-readable version + provenance (for a consumer's sync script).",
    ),
) -> None:
    """h — the harness CLI."""
