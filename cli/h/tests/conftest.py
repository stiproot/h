"""Shared fixtures for the h CLI suite."""

from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def hostile_spec() -> Path:
    """The committed hostile-content spec — every token class that must survive rendering."""
    return FIXTURES_DIR / "hostile.md"
