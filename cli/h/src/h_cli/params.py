"""The `-p key=value` parser — template-value hydration, shared by `h workflow run` and
`h chain run` so the two command surfaces can't drift. A template's content-param space is
unbounded, so it gets one uniform syntax; a value of `@path` splices in that file's content."""

from pathlib import Path

import typer
from rich.console import Console

_err = Console(stderr=True)


def parse_params(pairs: list[str]) -> dict[str, str]:
    """`key=value` pairs → params dict; a value of `@path` splices in that file's content."""
    params: dict[str, str] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            _err.print(f"[red]Bad -p[/red] '{pair}' — expected key=value")
            raise typer.Exit(1)
        if value.startswith("@"):
            path = Path(value[1:])
            if not path.is_file():
                _err.print(f"[red]-p {key}[/red]: no such file: {path}")
                raise typer.Exit(1)
            value = path.read_text()
        params[key] = value
    return params
