"""Printing a definition or an evidence line so that a PIPE gets all of it.

rich's `Syntax` CROPS every line at the console width, and a console that is not a TTY is
80 columns wide — so `h template compose … > file` and `h workflow get KEY | …` wrote a
definition with the tail of every long line missing, silently (found 2026-09-03: a test
asserting on composed output stopped seeing `OUTPUT CONTRACT` because the phrase had moved
across the 80th column). Highlighting is for eyes; a pipe gets the bytes.
"""

from __future__ import annotations

import sys

from rich.console import Console
from rich.syntax import Syntax

console = Console()


def print_yaml(rendered: str) -> None:
    """Syntax-highlight on a terminal; write verbatim to anything else."""
    if sys.stdout.isatty():
        console.print(Syntax(rendered, "yaml", background_color="default"))
    else:
        sys.stdout.write(rendered if rendered.endswith("\n") else rendered + "\n")
