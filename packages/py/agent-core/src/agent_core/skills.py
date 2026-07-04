"""Load an h skill's instruction body so a Python agent can use the same skill text as its
system prompt — the single source of truth shared with CLI agents (which load the same
skills into ``~/.claude/skills``). Stdlib only, no extra needed.
"""

from __future__ import annotations

import os
from pathlib import Path


def load_skill_instructions(name: str, skills_dir: str | os.PathLike | None = None) -> str:
    """Return skill ``name``'s instruction body — its SKILL.md with the YAML frontmatter
    stripped. ``skills_dir`` defaults to the ``H_SKILLS_DIR`` env var (the h skills root).

    Raises ``ValueError`` if no skills dir is known, ``FileNotFoundError`` if the skill's
    SKILL.md is missing — fail fast, so a misconfigured prompt source is caught at startup.
    """
    root = skills_dir or os.getenv("H_SKILLS_DIR")
    if not root:
        raise ValueError("no skills dir: pass skills_dir or set H_SKILLS_DIR to the h skills root")
    text = (Path(root) / name / "SKILL.md").read_text(encoding="utf-8")
    return _strip_frontmatter(text).strip()


def _strip_frontmatter(text: str) -> str:
    """Drop a leading YAML frontmatter block (``---`` … ``---``) if present."""
    if not text.startswith("---"):
        return text
    close = text.find("\n---", 3)
    if close == -1:
        return text
    body_start = text.find("\n", close + 1)
    return text[body_start + 1 :] if body_start != -1 else ""
