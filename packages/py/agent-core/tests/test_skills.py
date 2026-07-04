"""Tests for the skill-instruction loader. Run directly: `uv run --package agent-core python
packages/py/agent-core/tests/test_skills.py`."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from agent_core.skills import _strip_frontmatter, load_skill_instructions


def _strips_leading_frontmatter() -> None:
    out = _strip_frontmatter("---\nname: x\ndescription: y\n---\n\n# Title\nbody")
    assert out.lstrip().startswith("# Title"), repr(out)
    assert "name: x" not in out, repr(out)


def _passthrough_without_frontmatter() -> None:
    assert _strip_frontmatter("# Title\nbody") == "# Title\nbody"


def _loads_body_from_dir() -> None:
    with tempfile.TemporaryDirectory() as d:
        skill = Path(d) / "demo"
        skill.mkdir()
        (skill / "SKILL.md").write_text("---\nname: demo\n---\n\n# Demo\nDo the thing.\n")
        assert load_skill_instructions("demo", skills_dir=d) == "# Demo\nDo the thing."


def _uses_h_skills_dir_env() -> None:
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


def _raises_without_any_dir() -> None:
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


def main() -> None:
    _strips_leading_frontmatter()
    _passthrough_without_frontmatter()
    _loads_body_from_dir()
    _uses_h_skills_dir_env()
    _raises_without_any_dir()
    print("agent_core.skills: all tests passed")


if __name__ == "__main__":
    main()
