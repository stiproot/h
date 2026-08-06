"""h worktrees — the direct-substrate sweep surface (monkeypatched git, no HTTP)."""

import json
from pathlib import Path

from typer.testing import CliRunner

from h_cli.config import DIRECT_WORKTREES_DIR
from h_cli.infrastructure.git import WorktreeEntry
from h_cli.main import app

runner = CliRunner()

FAKE_REPO = Path("/fake/repo")


def _entry(branch_short: str, under_direct: bool = True) -> WorktreeEntry:
    path = DIRECT_WORKTREES_DIR / branch_short.replace("/", "-") if under_direct else Path("/other")
    branch = f"refs/heads/{branch_short}" if branch_short != "(detached)" else None
    return WorktreeEntry(path=path, head="abc1234", branch=branch)


def _patch_git(monkeypatch, entries, dirty=False, unpushed=False) -> None:
    monkeypatch.setattr("h_cli.infrastructure.direct.repo_root", lambda cwd: str(FAKE_REPO))
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_prune", lambda repo: None)
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_list",
        lambda repo: [_entry("main", under_direct=False)] + entries,
    )
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_is_dirty", lambda path: dirty)
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_has_unpushed", lambda path: unpushed)


def _capture_remove(monkeypatch, removed):
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_remove",
        lambda repo, path, **kw: removed.append((path, kw)),
    )


def _capture_delete(monkeypatch, deleted):
    monkeypatch.setattr(
        "h_cli.infrastructure.git.branch_delete",
        lambda repo, branch, **kw: deleted.append((branch, kw)),
    )


def test_list_shows_direct_worktrees(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("direct/260101-010101")])
    result = runner.invoke(app, ["worktrees", "list"])
    assert result.exit_code == 0
    assert "direct/260101-010101" in result.output
    assert "main" not in result.output


def test_list_empty(monkeypatch) -> None:
    _patch_git(monkeypatch, [])
    result = runner.invoke(app, ["worktrees", "list"])
    assert result.exit_code == 0
    assert "no direct-substrate worktrees found" in result.output


def test_list_json(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("direct/260101-010101")], dirty=True)
    result = runner.invoke(app, ["worktrees", "list", "--json"])
    assert result.exit_code == 0
    rows = json.loads(result.output)
    assert rows[0]["branch"] == "direct/260101-010101"
    assert rows[0]["path"] == str(DIRECT_WORKTREES_DIR / "direct-260101-010101")
    assert rows[0]["dirty"] is True
    assert rows[0]["unpushed"] is False


def test_rm_refuses_dirty_without_force(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("direct/260101-010101")], dirty=True)
    result = runner.invoke(app, ["worktrees", "rm", "direct/260101-010101"])
    assert result.exit_code == 1
    assert "refused" in result.output
    assert "uncommitted changes" in result.output


def test_rm_refuses_unpushed_without_force(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("direct/260101-010101")], unpushed=True)
    result = runner.invoke(app, ["worktrees", "rm", "direct/260101-010101"])
    assert result.exit_code == 1
    assert "refused" in result.output
    assert "unpushed commits" in result.output


def test_rm_clean_calls_remove_and_branch_delete(monkeypatch) -> None:
    entry = _entry("direct/260101-010101")
    _patch_git(monkeypatch, [entry])
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "rm", "direct/260101-010101"])
    assert result.exit_code == 0
    assert removed == [(entry.path, {"force": False})]
    assert deleted == [("direct/260101-010101", {})]


def test_rm_force_dirty_warns_and_removes(monkeypatch) -> None:
    entry = _entry("direct/260101-010101")
    _patch_git(monkeypatch, [entry], dirty=True)
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "rm", "direct/260101-010101", "--force"])
    assert result.exit_code == 0
    assert "warning" in result.output
    assert removed == [(entry.path, {"force": True})]


def test_rm_unknown_branch_loud_refusal(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("direct/260101-010101")])
    result = runner.invoke(app, ["worktrees", "rm", "direct/nope"])
    assert result.exit_code == 1
    assert "no direct-substrate worktree" in result.output
    assert "h worktrees list" in result.output


def test_rm_detached_head_skips_branch_delete(monkeypatch) -> None:
    detached = WorktreeEntry(
        path=DIRECT_WORKTREES_DIR / "detached-260101-010101",
        head="abc1234",
        branch=None,
    )
    _patch_git(monkeypatch, [detached])
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "rm", "detached-260101-010101"])
    assert result.exit_code == 0
    assert removed == [(detached.path, {"force": False})]
    assert deleted == []


def test_sweep_dry_run_no_side_effects(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("direct/260101-010101")])
    removed = []
    _capture_remove(monkeypatch, removed)
    result = runner.invoke(app, ["worktrees", "sweep", "--dry-run"])
    assert result.exit_code == 0
    assert "would remove" in result.output
    assert removed == []


def test_sweep_removes_clean_skips_dirty(monkeypatch) -> None:
    clean = _entry("direct/260101-010101")
    dirty = _entry("direct/260101-010102")
    _patch_git(monkeypatch, [clean, dirty])
    dirty_paths = {dirty.path}
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_is_dirty",
        lambda path: path in dirty_paths,
    )
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_has_unpushed", lambda path: False)
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "sweep"])
    assert result.exit_code == 0
    assert [p for p, _ in removed] == [clean.path]
    assert deleted == [("direct/260101-010101", {})]
    assert "skipped" in result.output
    assert "uncommitted changes" in result.output


def test_sweep_force_removes_all_with_warnings(monkeypatch) -> None:
    clean = _entry("direct/260101-010101")
    dirty = _entry("direct/260101-010102")
    unpushed = _entry("direct/260101-010103")
    _patch_git(monkeypatch, [clean, dirty, unpushed])
    dirty_paths = {dirty.path}
    unpushed_paths = {unpushed.path}
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_is_dirty",
        lambda path: path in dirty_paths,
    )
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_has_unpushed",
        lambda path: path in unpushed_paths,
    )
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "sweep", "--force"])
    assert result.exit_code == 0
    assert len(removed) == 3
    assert len(deleted) == 3
    assert "warning" in result.output
    assert "removed 3, skipped 0" in result.output


def test_sweep_empty_no_action(monkeypatch) -> None:
    _patch_git(monkeypatch, [])
    removed = []
    _capture_remove(monkeypatch, removed)
    result = runner.invoke(app, ["worktrees", "sweep"])
    assert result.exit_code == 0
    assert "no direct-substrate worktrees found" in result.output
    assert removed == []


# --------------------------------------------------------------------------------------------
# Path-shape regressions. The cases above build every entry path FROM DIRECT_WORKTREES_DIR, so
# they agree with it by construction and passed while `h worktrees list` found nothing at all on
# a real checkout: the configured root carried a literal `..` (`<repo>/../h-worktrees`) and
# Path.is_relative_to is purely lexical. These two break that symmetry deliberately.
# --------------------------------------------------------------------------------------------


def test_direct_worktrees_dir_is_resolved() -> None:
    """The configured root must be absolute and free of `..`, or the lexical filter can never
    match the absolute paths git reports."""
    assert DIRECT_WORKTREES_DIR.is_absolute()
    assert ".." not in DIRECT_WORKTREES_DIR.parts


def test_list_finds_an_entry_whose_path_is_not_lexically_normalised(monkeypatch) -> None:
    """git reports resolved absolute paths, but a symlinked or oddly-spelled checkout can still
    hand us an unnormalised one — the command resolves entries so it matches either way."""
    # Deliberately NOT lexically prefixed by the root — it only lands inside it once resolved,
    # so a filter that skips .resolve() rejects it.
    unnormalised = (
        DIRECT_WORKTREES_DIR.parent
        / "elsewhere"
        / ".."
        / DIRECT_WORKTREES_DIR.name
        / "direct-260101-010101"
    )
    entry = WorktreeEntry(path=unnormalised, head="abc1234", branch="refs/heads/direct/x")
    _patch_git(monkeypatch, [entry])

    result = runner.invoke(app, ["worktrees", "list", "--json"])

    assert result.exit_code == 0, result.output
    assert len(json.loads(result.output)) == 1
