"""Composition root for the h CLI — wires the command groups onto one Typer app.

Early prototype (see cli/README.md): each subcommand ports one proven vertical slice of the
cli/scripts machinery; the shell scripts remain the executable spec until a subcommand has
demonstrably replaced them.
"""

import typer

from h_cli.commands import chain, feature, template, watch, workflow

app = typer.Typer(
    no_args_is_help=True,
    help="h — the harness CLI (early prototype). Chart-rendered workflows and workflow-svc views.",
)
app.add_typer(feature.app, name="feature")
app.add_typer(template.app, name="template")
app.add_typer(chain.app, name="chain")
app.add_typer(watch.app, name="watch")
app.add_typer(workflow.app, name="workflow")
