"""Tests for the skill-instruction loader. Run: `uv run --package agent-core pytest`."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_core.skills import _strip_frontmatter, load_skill_instructions


def _write_skill(root: Path, name: str, body: str) -> None:
    skill = root / name
    skill.mkdir()
    (skill / "SKILL.md").write_text(body)


def test_strips_leading_frontmatter() -> None:
    out = _strip_frontmatter("---\nname: x\ndescription: y\n---\n\n# Title\nbody")
    assert out.lstrip().startswith("# Title")
    assert "name: x" not in out


def test_passthrough_without_frontmatter() -> None:
    assert _strip_frontmatter("# Title\nbody") == "# Title\nbody"


def test_loads_body_from_dir(tmp_path: Path) -> None:
    _write_skill(tmp_path, "demo", "---\nname: demo\n---\n\n# Demo\nDo the thing.\n")
    assert load_skill_instructions("demo", skills_dir=tmp_path) == "# Demo\nDo the thing."


def test_uses_h_skills_dir_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_skill(tmp_path, "demo", "---\nname: demo\n---\nvia env\n")
    monkeypatch.setenv("H_SKILLS_DIR", str(tmp_path))
    assert load_skill_instructions("demo") == "via env"


def test_raises_without_any_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("H_SKILLS_DIR", raising=False)
    with pytest.raises(ValueError):
        load_skill_instructions("demo")


def test_missing_skill_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_skill_instructions("nope", skills_dir=tmp_path)
