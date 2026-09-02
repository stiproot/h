"""Shared fixtures for the h CLI suite."""

import os

# Help text and refusals are asserted as SUBSTRINGS, so the console must not style them. Typer
# decides at IMPORT time to force a colour terminal whenever GITHUB_ACTIONS (or FORCE_COLOR /
# PY_COLORS) is set, and then renders `--local` as two styled fragments — so every
# `"--local" in output` assertion failed on GitHub's runner while passing in every developer
# shell: main was red for seventeen days (2026-08-16 → 09-02) on exactly that, unnoticed because
# the pre-push hook runs lint, not tests. This is typer's own off switch, and it has to be set
# before typer.rich_utils is imported, which is why it lives here rather than in a fixture.
os.environ.setdefault("_TYPER_FORCE_DISABLE_TERMINAL", "1")
# rich's own consoles (every command's output) read these at construction and would style the
# output the same way in a developer shell that exports them; the suite asserts on plain text.
for _forced in ("FORCE_COLOR", "PY_COLORS"):
    os.environ.pop(_forced, None)

from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def hostile_spec() -> Path:
    """The committed hostile-content spec — every token class that must survive rendering."""
    return FIXTURES_DIR / "hostile.md"
