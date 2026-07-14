"""h agents — CLI-level tests through typer's in-process runner.

Reads config data directly (no HTTP mocking needed)."""

from typer.testing import CliRunner

from h_cli.main import app

runner = CliRunner()


def test_agents_list() -> None:
    result = runner.invoke(app, ["agents", "list"])
    assert result.exit_code == 0, result.output
    # Each agent name and its agentId should appear in the table.
    for name, agent_id in (
        ("claude", "claude-agent"),
        ("openhands", "openhands-agent"),
        ("pi", "pi-agent"),
    ):
        assert name in result.output
        assert agent_id in result.output
