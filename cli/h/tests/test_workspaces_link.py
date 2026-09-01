"""`h workspaces link` — provisioning agent primitives into the locations agents read."""

from pathlib import Path

import pytest

from h_cli.commands.workspaces import (
    available,
    link_skills,
    load_profile,
    resolve_names,
    write_rules,
)


def _repo(tmp_path: Path, skills: tuple[str, ...] = (), rules: tuple[str, ...] = ()) -> Path:
    for name in skills:
        d = tmp_path / ".h" / "skills" / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
    for name in rules:
        d = tmp_path / ".h" / "rules"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{name}.md").write_text(f"# {name}\n\nbody of {name}.\n")
    return tmp_path


def test_links_are_relative_so_a_worktree_resolves_its_own(tmp_path: Path) -> None:
    """An absolute link would point every worktree back at the checkout it was cut from."""
    repo = _repo(tmp_path, skills=("alpha",))
    link_skills(repo, ["alpha"], dry_run=False)
    link = repo / ".claude" / "skills" / "alpha"
    assert link.readlink().as_posix() == "../../.h/skills/alpha"
    assert (link / "SKILL.md").is_file()


def test_deselecting_a_skill_prunes_its_link(tmp_path: Path) -> None:
    """Selection is meaningless without pruning: run B would inherit run A's context."""
    repo = _repo(tmp_path, skills=("alpha", "beta"))
    link_skills(repo, ["alpha", "beta"], dry_run=False)
    _, pruned = link_skills(repo, ["alpha"], dry_run=False)
    assert pruned == ["beta"]
    assert not (repo / ".claude" / "skills" / "beta").exists()


def test_a_repos_own_skill_is_never_touched(tmp_path: Path) -> None:
    """h prunes only links INTO .h/skills — a real directory belongs to the repo."""
    repo = _repo(tmp_path, skills=("alpha",))
    own = repo / ".claude" / "skills" / "mine"
    own.mkdir(parents=True)
    (own / "SKILL.md").write_text("---\nname: mine\n---\n")
    link_skills(repo, ["alpha"], dry_run=False)
    assert own.is_dir() and not own.is_symlink()


def test_a_real_directory_is_refused_rather_than_replaced(tmp_path: Path) -> None:
    repo = _repo(tmp_path, skills=("alpha",))
    clash = repo / ".claude" / "skills" / "alpha"
    clash.mkdir(parents=True)
    with pytest.raises(Exception, match="real directory"):
        link_skills(repo, ["alpha"], dry_run=False)


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    repo = _repo(tmp_path, skills=("alpha",))
    linked, _ = link_skills(repo, ["alpha"], dry_run=True)
    assert linked == ["alpha"]
    assert not (repo / ".claude" / "skills" / "alpha").exists()


def test_rules_round_trip_on_and_off(tmp_path: Path) -> None:
    """The container profile writes the block; the local profile removes it — the A/B mechanism."""
    repo = _repo(tmp_path, rules=("h-runtime",))
    target = repo / ".claude" / "CLAUDE.md"
    assert write_rules(repo, ["h-runtime"], target, dry_run=False)
    assert "body of h-runtime" in target.read_text()
    assert write_rules(repo, [], target, dry_run=False)
    assert not target.exists(), "an empty steering file cannot be told from a failed write"


def test_rules_preserve_a_repos_own_steering(tmp_path: Path) -> None:
    """h writes between markers, so the repo's own words survive both apply and remove."""
    repo = _repo(tmp_path, rules=("h-runtime",))
    target = repo / ".claude" / "CLAUDE.md"
    target.parent.mkdir(parents=True)
    target.write_text("# The repo's own steering\n\nkeep me.\n")
    write_rules(repo, ["h-runtime"], target, dry_run=False)
    assert "keep me." in target.read_text()
    write_rules(repo, [], target, dry_run=False)
    assert "keep me." in target.read_text()
    assert "body of h-runtime" not in target.read_text()


def test_an_empty_profile_list_is_not_the_same_as_no_profile(tmp_path: Path) -> None:
    """`[]` means 'this mode deliberately gets none'; absent means 'fall back to the default'."""
    repo = _repo(tmp_path, skills=("alpha",), rules=("h-runtime",))
    (repo / ".h" / "context.toml").write_text(
        '[profiles.container]\nskills = ["*"]\nrules = ["h-runtime"]\n\n'
        '[profiles.local]\nskills = ["*"]\nrules = []\n'
    )
    assert load_profile(repo, "container") == (["*"], ["h-runtime"])
    assert load_profile(repo, "local") == (["*"], [])
    assert load_profile(repo, None) == (None, None)


def test_an_unknown_profile_names_the_ones_that_exist(tmp_path: Path) -> None:
    repo = _repo(tmp_path, skills=("alpha",))
    (repo / ".h" / "context.toml").write_text('[profiles.container]\nskills = ["*"]\n')
    with pytest.raises(Exception, match="container"):
        load_profile(repo, "nope")


def test_star_and_none_both_mean_everything(tmp_path: Path) -> None:
    repo = _repo(tmp_path, skills=("alpha", "beta"))
    offered = available(repo / ".h" / "skills", "SKILL.md")
    assert resolve_names(None, offered) == ["alpha", "beta"]
    assert resolve_names(["*"], offered) == ["alpha", "beta"]
    with pytest.raises(Exception, match="not available"):
        resolve_names(["ghost"], offered)


def test_sources_link_skills_whose_files_live_elsewhere(tmp_path: Path) -> None:
    """A skill can have two audiences: published for consumers AND used by this repo.

    `[sources]` links the one copy into `.h/skills/` rather than keeping a second set that drifts.
    """
    from h_cli.commands.workspaces import link_sources

    repo = tmp_path
    published = repo / "plugins" / "h" / "skills" / "delegate-locally"
    published.mkdir(parents=True)
    (published / "SKILL.md").write_text("---\nname: delegate-locally\n---\n")
    (repo / ".h").mkdir(exist_ok=True)
    (repo / ".h" / "context.toml").write_text(
        '[sources]\ndelegate-locally = "plugins/h/skills/delegate-locally"\n'
    )
    assert link_sources(repo, dry_run=False) == ["delegate-locally"]
    link = repo / ".h" / "skills" / "delegate-locally"
    assert link.is_symlink()
    assert (link / "SKILL.md").is_file()
    # idempotent — a second run has nothing to do
    assert link_sources(repo, dry_run=False) == []


def test_a_source_pointing_nowhere_is_refused(tmp_path: Path) -> None:
    (tmp_path / ".h").mkdir()
    (tmp_path / ".h" / "context.toml").write_text('[sources]\nghost = "plugins/h/skills/ghost"\n')
    from h_cli.commands.workspaces import link_sources

    with pytest.raises(Exception, match="no SKILL.md"):
        link_sources(tmp_path, dry_run=False)
