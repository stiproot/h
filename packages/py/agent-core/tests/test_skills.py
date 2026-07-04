"""Tests for the skill-instruction loader. Run: `uv run --package agent-core pytest`."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from agent_core.skills import _strip_frontmatter, load_skill_instructions


def test_strips_leading_frontmatter() -> None:
    out = _strip_frontmatter("---\nname: x\ndescription: y\n---\n\n# Title\nbody")
    assert out.lstrip().startswith("# Title")
    assert "name: x" not in out


def test_passthrough_without_frontmatter() -> None:
    assert _strip_frontmatter("# Title\nbody") == "# Title\nbody"


def test_loads_body_from_dir() -> None:
    with tempfile.TemporaryDirectory() as d:
        skill = Path(d) / "demo"
        skill.mkdir()
        (skill / "SKILL.md").write_text("---\nname: demo\n---\n\n# Demo\nDo the thing.\n")
        assert load_skill_instructions("demo", skills_dir=d) == "# Demo\nDo the thing."


def test_uses_h_skills_dir_env() -> None:
    with tempfile.TemporaryDirectory() as d:
        skill = Path(d) / "demo"
        skill.mkdir()
        (skill / "SKILL.md").write_text("---\nname: demo\n---\nvia env\n")
        prev = os.environ.get("H_SKILLS_DIR")
        os.environ["H_SKILLS_DIR"] = d
        try:
            assert load_skill_instructions("demo") == "via env"
        finally:
            if prev is None:
                os.environ.pop("H_SKILLS_DIR", None)
            else:
                os.environ["H_SKILLS_DIR"] = prev


def test_raises_without_any_dir() -> None:
    prev = os.environ.pop("H_SKILLS_DIR", None)
    try:
        try:
            load_skill_instructions("demo")
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError when no skills dir is known")
    finally:
        if prev is not None:
            os.environ["H_SKILLS_DIR"] = prev
