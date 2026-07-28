"""The LLM-invoked tools must refuse to leave the workspace.

`path` and `skill_name` are MODEL-supplied, so every escape here is reachable from a tool call.
The tools return an error STRING rather than raising: the value goes back to the model, and a
raised exception would abort the run instead of letting the agent see the refusal and adjust.
"""

from pathlib import Path

from infrastructure.tools import make_tool_fns


def _call(cwd: Path, name: str, **kwargs) -> str:
    return make_tool_fns(cwd)[name](**kwargs)


def test_write_file_writes_inside_the_workspace(tmp_path):
    out = _call(tmp_path, "write_file", path="notes/plan.md", content="hello")
    assert "Written:" in out
    assert (tmp_path / "notes/plan.md").read_text() == "hello"


def test_write_file_refuses_an_absolute_path(tmp_path):
    victim = tmp_path.parent / "victim.txt"
    out = _call(tmp_path, "write_file", path=str(victim), content="pwned")
    assert "escapes the workspace" in out
    assert not victim.exists()


def test_write_file_refuses_parent_traversal(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    out = _call(workspace, "write_file", path="../escaped.txt", content="pwned")
    assert "escapes the workspace" in out
    assert not (tmp_path / "escaped.txt").exists()


def test_read_skill_refuses_a_traversal_skill_name(tmp_path):
    assert "invalid skill name" in _call(tmp_path, "read_skill", skill_name="../../etc")


def test_read_skill_reads_a_plain_skill(tmp_path):
    skill = tmp_path / ".tessl" / "skills" / "linear"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# linear")
    assert _call(tmp_path, "read_skill", skill_name="linear") == "# linear"
