"""`h workspaces plugins` — declaring, installing and VERIFYING h's consumer plugin.

The tests that matter here are the ones about verification. Declaring a plugin in
`.claude/settings.json` and installing it are different acts, and trxy proved they are separable
by carrying the declaration for 19 days while the plugin never loaded. So a passing declaration
must never be able to read as a passing install.
"""

import json
from pathlib import Path

import pytest
import typer

from h_cli.commands.workspaces import declare_plugin, h_source, verify_installed


def _consumer(tmp_path: Path, repo_url: str = "https://github.com/stiproot/h") -> Path:
    lock = tmp_path / ".h" / "h.lock"
    lock.parent.mkdir(parents=True)
    lock.write_text(f'repo = "{repo_url}"\ncommit = "abc123"\n')
    return tmp_path


# --- h_source: the pin decides which h, and whether this is a consumer at all -----------------


def test_source_is_derived_from_the_pin_not_hardcoded(tmp_path: Path) -> None:
    """A fork's consumer must install the fork's plugin — the CLI and the skills describing it
    have to come from the same h."""
    assert h_source(_consumer(tmp_path, "https://github.com/someone/h-fork")) == "someone/h-fork"


def test_a_git_suffix_is_stripped(tmp_path: Path) -> None:
    assert h_source(_consumer(tmp_path, "https://github.com/stiproot/h.git")) == "stiproot/h"


def test_a_repo_with_no_pin_is_not_a_consumer(tmp_path: Path) -> None:
    """h's own checkout must never enable h's plugin: the marketplace source is GitHub, so it
    would run a published copy against a live source tree."""
    with pytest.raises(typer.BadParameter, match="does not pin h"):
        h_source(tmp_path)


def test_a_non_github_pin_is_refused_by_name(tmp_path: Path) -> None:
    with pytest.raises(typer.BadParameter, match="github owner/name"):
        h_source(_consumer(tmp_path, "git@gitlab.example/thing/h"))


# --- declare: additive, never clobbering the repo's own settings ------------------------------


def test_declaring_preserves_every_other_key(tmp_path: Path) -> None:
    """The settings file is the REPO's. Its other marketplaces and permissions must survive."""
    repo = _consumer(tmp_path)
    settings = repo / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(
        json.dumps(
            {
                "permissions": {"allow": ["Bash(ls:*)"]},
                "enabledPlugins": {"other@other-marketplace": True},
                "extraKnownMarketplaces": {
                    "other-marketplace": {"source": {"source": "github", "repo": "x/y"}}
                },
            }
        )
    )
    assert declare_plugin(repo, "stiproot/h", dry_run=False) is True
    got = json.loads(settings.read_text())
    assert got["permissions"] == {"allow": ["Bash(ls:*)"]}
    assert got["enabledPlugins"]["other@other-marketplace"] is True
    assert got["extraKnownMarketplaces"]["other-marketplace"]["source"]["repo"] == "x/y"
    assert got["enabledPlugins"]["h@h-marketplace"] is True
    assert got["extraKnownMarketplaces"]["h-marketplace"]["source"] == {
        "source": "github",
        "repo": "stiproot/h",
    }


def test_declaring_is_idempotent(tmp_path: Path) -> None:
    repo = _consumer(tmp_path)
    assert declare_plugin(repo, "stiproot/h", dry_run=False) is True
    assert declare_plugin(repo, "stiproot/h", dry_run=False) is False


def test_a_moved_pin_redeclares(tmp_path: Path) -> None:
    """Repointing the lock at a fork must move the marketplace with it, not leave the old one."""
    repo = _consumer(tmp_path)
    declare_plugin(repo, "stiproot/h", dry_run=False)
    assert declare_plugin(repo, "someone/h-fork", dry_run=False) is True
    got = json.loads((repo / ".claude" / "settings.json").read_text())
    assert got["extraKnownMarketplaces"]["h-marketplace"]["source"]["repo"] == "someone/h-fork"


def test_dry_run_writes_no_settings_file(tmp_path: Path) -> None:
    repo = _consumer(tmp_path)
    assert declare_plugin(repo, "stiproot/h", dry_run=True) is True
    assert not (repo / ".claude" / "settings.json").exists()


# --- verify: the load-bearing half ------------------------------------------------------------


def _registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, payload: dict) -> None:
    path = tmp_path / "installed_plugins.json"
    path.write_text(json.dumps(payload))
    monkeypatch.setattr("h_cli.commands.workspaces.INSTALLED_PLUGINS", path)


def test_a_declaration_alone_does_not_verify(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE regression: trxy's exact state — declared in settings.json, absent from the registry."""
    repo = _consumer(tmp_path)
    declare_plugin(repo, "stiproot/h", dry_run=False)
    _registry(tmp_path, monkeypatch, {"version": 2, "plugins": {}})
    assert verify_installed(repo) is None


def test_a_user_scope_install_does_not_verify_a_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`claude plugin install` defaults to user scope, which proves nothing about the clone an
    agent runs in."""
    repo = _consumer(tmp_path)
    _registry(
        tmp_path,
        monkeypatch,
        {"plugins": {"h@h-marketplace": [{"scope": "user", "version": "0.2.0"}]}},
    )
    assert verify_installed(repo) is None


def test_a_sibling_clones_install_does_not_verify_this_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each clone and worktree pins separately — the entry has to name THIS path."""
    repo = _consumer(tmp_path)
    _registry(
        tmp_path,
        monkeypatch,
        {
            "plugins": {
                "h@h-marketplace": [
                    {"scope": "project", "projectPath": "/somewhere/else", "version": "0.2.0"}
                ]
            }
        },
    )
    assert verify_installed(repo) is None


def test_a_project_scope_entry_for_this_path_verifies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _consumer(tmp_path)
    _registry(
        tmp_path,
        monkeypatch,
        {
            "plugins": {
                "h@h-marketplace": [
                    {"scope": "user", "version": "0.1.0"},
                    {"scope": "project", "projectPath": str(repo), "version": "0.2.0"},
                ]
            }
        },
    )
    entry = verify_installed(repo)
    assert entry is not None
    assert entry["version"] == "0.2.0"


def test_a_missing_or_corrupt_registry_reads_as_not_installed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail closed: an unreadable registry must never be reported as a verified install."""
    repo = _consumer(tmp_path)
    monkeypatch.setattr("h_cli.commands.workspaces.INSTALLED_PLUGINS", tmp_path / "absent.json")
    assert verify_installed(repo) is None
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    monkeypatch.setattr("h_cli.commands.workspaces.INSTALLED_PLUGINS", bad)
    assert verify_installed(repo) is None
