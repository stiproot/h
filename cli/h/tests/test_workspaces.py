"""h workspaces trust — the explicit trust stamp for Claude Code in h-managed checkouts."""

import json

from typer.testing import CliRunner

from h_cli.commands.workspaces import stamp_trust
from h_cli.config import H_WORKSPACE_DIR
from h_cli.main import app

runner = CliRunner()


def test_stamp_trust_creates_missing_config(tmp_path):
    config = tmp_path / ".claude.json"
    project = tmp_path / "clone"
    assert stamp_trust(config, project) is True
    loaded = json.loads(config.read_text())
    assert loaded["projects"][str(project)]["hasTrustDialogAccepted"] is True


def test_stamp_trust_preserves_existing_config(tmp_path):
    config = tmp_path / ".claude.json"
    project = tmp_path / "clone"
    config.write_text(
        json.dumps(
            {
                "theme": "dark",
                "projects": {
                    str(project): {"allowedTools": ["Bash"]},
                    "/elsewhere": {"hasTrustDialogAccepted": True},
                },
            }
        )
    )
    assert stamp_trust(config, project) is True
    loaded = json.loads(config.read_text())
    # only the one key was added; every sibling key and entry survives
    assert loaded["theme"] == "dark"
    assert loaded["projects"][str(project)] == {
        "allowedTools": ["Bash"],
        "hasTrustDialogAccepted": True,
    }
    assert loaded["projects"]["/elsewhere"] == {"hasTrustDialogAccepted": True}


def test_stamp_trust_is_idempotent(tmp_path):
    config = tmp_path / ".claude.json"
    project = tmp_path / "clone"
    assert stamp_trust(config, project) is True
    before = config.read_text()
    assert stamp_trust(config, project) is False
    assert config.read_text() == before


def test_trust_refuses_external_path(tmp_path):
    result = runner.invoke(app, ["workspaces", "trust", str(tmp_path)])
    assert result.exit_code == 1
    # rich wraps the refusal, and where it wraps depends on how long tmp_path happens to be —
    # so match on the unwrapped text, never on the console's line breaks.
    assert "outside the workspace h manages" in " ".join(result.output.split())


def test_trust_stamps_managed_path(tmp_path, monkeypatch):
    config = tmp_path / ".claude.json"
    monkeypatch.setattr("h_cli.commands.workspaces.CLAUDE_CONFIG", config)
    clone = H_WORKSPACE_DIR / "some-repo"
    monkeypatch.setattr("h_cli.commands.workspaces.Path.is_dir", lambda self: True)
    result = runner.invoke(app, ["workspaces", "trust", str(clone)])
    assert result.exit_code == 0, result.output
    assert "trusted" in result.output
    loaded = json.loads(config.read_text())
    assert loaded["projects"][str(clone.resolve())]["hasTrustDialogAccepted"] is True
