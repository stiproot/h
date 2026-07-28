"""The LLM-invoked tools must refuse to leave the workspace.

This agent dispatches by tool NAME through `execute_tool` rather than exposing callables, but the
argument is equally model-supplied — the same escapes are reachable. Errors come back as strings:
the value goes to the model, and raising would abort the run instead of letting it adjust.
"""


from infrastructure.tools import execute_tool


def test_write_file_writes_inside_the_workspace(tmp_path):
    out = execute_tool("write_file", {"path": "notes/plan.md", "content": "hello"}, tmp_path)
    assert "Written:" in out
    assert (tmp_path / "notes/plan.md").read_text() == "hello"


def test_write_file_refuses_an_absolute_path(tmp_path):
    victim = tmp_path.parent / "victim.txt"
    out = execute_tool("write_file", {"path": str(victim), "content": "pwned"}, tmp_path)
    assert "escapes the workspace" in out
    assert not victim.exists()


def test_write_file_refuses_parent_traversal(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    out = execute_tool("write_file", {"path": "../escaped.txt", "content": "pwned"}, workspace)
    assert "escapes the workspace" in out
    assert not (tmp_path / "escaped.txt").exists()


def test_read_skill_refuses_a_traversal_skill_name(tmp_path):
    out = execute_tool("read_skill", {"skill_name": "../../etc"}, tmp_path)
    assert "invalid skill name" in out


def test_read_skill_reads_a_plain_skill(tmp_path):
    skill = tmp_path / ".tessl" / "skills" / "linear"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# linear")
    assert execute_tool("read_skill", {"skill_name": "linear"}, tmp_path) == "# linear"
