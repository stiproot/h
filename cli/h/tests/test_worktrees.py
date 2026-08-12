"""h worktrees — the sweep surface for both substrates (monkeypatched git, no HTTP)."""

import json
from pathlib import Path

from typer.testing import CliRunner

from h_cli.config import H_WORKSPACE_DIR, LOCAL_WORKTREES_DIR
from h_cli.infrastructure.git import WorktreeEntry
from h_cli.main import app

runner = CliRunner()

FAKE_REPO = Path("/fake/repo")


def _entry(branch_short: str, under_local: bool = True) -> WorktreeEntry:
    path = LOCAL_WORKTREES_DIR / branch_short.replace("/", "-") if under_local else Path("/other")
    branch = f"refs/heads/{branch_short}" if branch_short != "(detached)" else None
    return WorktreeEntry(path=path, head="abc1234", branch=branch)


def _patch_git(monkeypatch, entries, dirty=False, unpushed=False) -> None:
    monkeypatch.setattr("h_cli.infrastructure.local_runtime.repo_root", lambda cwd: str(FAKE_REPO))
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_prune", lambda repo: None)
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_list",
        lambda repo: [_entry("main", under_local=False)] + entries,
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


def test_list_shows_local_worktrees(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")])
    result = runner.invoke(app, ["worktrees", "list"])
    assert result.exit_code == 0
    assert "local/260101-010101" in result.output
    assert "main" not in result.output


def test_list_empty(monkeypatch) -> None:
    _patch_git(monkeypatch, [])
    result = runner.invoke(app, ["worktrees", "list"])
    assert result.exit_code == 0
    assert "no h-managed worktrees found" in result.output


def test_list_json(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], dirty=True)
    result = runner.invoke(app, ["worktrees", "list", "--json"])
    assert result.exit_code == 0
    rows = json.loads(result.output)
    assert rows[0]["branch"] == "local/260101-010101"
    assert rows[0]["path"] == str(LOCAL_WORKTREES_DIR / "local-260101-010101")
    assert rows[0]["dirty"] is True
    assert rows[0]["unpushed"] is False


def test_rm_refuses_dirty_without_force(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], dirty=True)
    result = runner.invoke(app, ["worktrees", "rm", "local/260101-010101"])
    assert result.exit_code == 1
    assert "refused" in result.output
    assert "uncommitted changes" in result.output


def test_rm_refuses_unpushed_without_force(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], unpushed=True)
    result = runner.invoke(app, ["worktrees", "rm", "local/260101-010101"])
    assert result.exit_code == 1
    assert "refused" in result.output
    assert "unpushed commits" in result.output


def test_rm_clean_calls_remove_and_branch_delete(monkeypatch) -> None:
    entry = _entry("local/260101-010101")
    _patch_git(monkeypatch, [entry])
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "rm", "local/260101-010101"])
    assert result.exit_code == 0
    assert removed == [(entry.path, {"force": False})]
    assert deleted == [("local/260101-010101", {})]


def test_rm_force_dirty_warns_and_removes(monkeypatch) -> None:
    entry = _entry("local/260101-010101")
    _patch_git(monkeypatch, [entry], dirty=True)
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "rm", "local/260101-010101", "--force"])
    assert result.exit_code == 0
    assert "warning" in result.output
    assert removed == [(entry.path, {"force": True})]


def test_rm_unknown_branch_loud_refusal(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")])
    result = runner.invoke(app, ["worktrees", "rm", "local/nope"])
    assert result.exit_code == 1
    assert "no h-managed worktree" in result.output
    assert "h worktrees list" in result.output


def test_rm_detached_head_skips_branch_delete(monkeypatch) -> None:
    detached = WorktreeEntry(
        path=LOCAL_WORKTREES_DIR / "detached-260101-010101",
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
    _patch_git(monkeypatch, [_entry("local/260101-010101")])
    removed = []
    _capture_remove(monkeypatch, removed)
    result = runner.invoke(app, ["worktrees", "sweep", "--dry-run"])
    assert result.exit_code == 0
    assert "would remove" in result.output
    assert removed == []


def test_sweep_removes_clean_skips_dirty(monkeypatch) -> None:
    clean = _entry("local/260101-010101")
    dirty = _entry("local/260101-010102")
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
    assert deleted == [("local/260101-010101", {})]
    assert "skipped" in result.output
    assert "uncommitted changes" in result.output


def test_sweep_force_removes_all_with_warnings(monkeypatch) -> None:
    clean = _entry("local/260101-010101")
    dirty = _entry("local/260101-010102")
    unpushed = _entry("local/260101-010103")
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
    assert "no h-managed worktrees found" in result.output
    assert removed == []


# --------------------------------------------------------------------------------------------
# Path-shape regressions. The cases above build every entry path FROM LOCAL_WORKTREES_DIR, so
# they agree with it by construction and passed while `h worktrees list` found nothing at all on
# a real checkout: the configured root carried a literal `..` (`<repo>/../h-worktrees`) and
# Path.is_relative_to is purely lexical. These two break that symmetry deliberately.
# --------------------------------------------------------------------------------------------


def test_local_worktrees_dir_is_resolved() -> None:
    """The configured root must be absolute and free of `..`, or the lexical filter can never
    match the absolute paths git reports."""
    assert LOCAL_WORKTREES_DIR.is_absolute()
    assert ".." not in LOCAL_WORKTREES_DIR.parts


def test_list_finds_an_entry_whose_path_is_not_lexically_normalised(monkeypatch) -> None:
    """git reports resolved absolute paths, but a symlinked or oddly-spelled checkout can still
    hand us an unnormalised one — the command resolves entries so it matches either way."""
    # Deliberately NOT lexically prefixed by the root — it only lands inside it once resolved,
    # so a filter that skips .resolve() rejects it.
    unnormalised = (
        LOCAL_WORKTREES_DIR.parent
        / "elsewhere"
        / ".."
        / LOCAL_WORKTREES_DIR.name
        / "local-260101-010101"
    )
    entry = WorktreeEntry(path=unnormalised, head="abc1234", branch="refs/heads/local/x")
    _patch_git(monkeypatch, [entry])

    result = runner.invoke(app, ["worktrees", "list", "--json"])

    assert result.exit_code == 0, result.output
    assert len(json.loads(result.output)) == 1


# --- both substrates, and reaching another checkout ---------------------------------------------
#
# Worktree admin lives in the CLONE, and the two substrates use different roots: the local one
# cuts under LOCAL_WORKTREES_DIR (local/*), the service one under <workspace>/worktrees (feature/*).
# Before this, only the local root was matched, so a merged 803MB feature worktree was invisible.


def _service_entry(branch_short: str) -> WorktreeEntry:
    path = H_WORKSPACE_DIR / "worktrees" / branch_short.replace("/", "-")
    return WorktreeEntry(path=path, head="abc1234", branch=f"refs/heads/{branch_short}")


def test_list_includes_service_substrate_worktrees(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101"), _service_entry("feature/x")])
    result = runner.invoke(app, ["worktrees", "list", "--json"])
    assert result.exit_code == 0
    branches = {row["branch"] for row in json.loads(result.stdout)}
    assert branches == {"local/260101-010101", "feature/x"}


def test_a_worktree_outside_every_managed_root_is_left_alone(monkeypatch) -> None:
    # Somebody's own worktree, in neither root — never h's to sweep.
    outside = WorktreeEntry(path=Path("/elsewhere/mine"), head="abc1234", branch="refs/heads/mine")
    _patch_git(monkeypatch, [outside])
    result = runner.invoke(app, ["worktrees", "list", "--json"])
    assert result.exit_code == 0
    assert json.loads(result.stdout) == []


def test_repo_option_resolves_against_the_given_checkout(monkeypatch) -> None:
    seen: list[Path] = []

    def fake_repo_root(cwd):
        seen.append(Path(cwd))
        return str(FAKE_REPO)

    monkeypatch.setattr("h_cli.infrastructure.local_runtime.repo_root", fake_repo_root)
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_prune", lambda repo: None)
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_list", lambda repo: [])
    result = runner.invoke(app, ["worktrees", "list", "--repo", "/some/clone"])
    assert result.exit_code == 0
    assert seen == [Path("/some/clone")]


def test_sweep_reaches_a_service_worktree_in_another_checkout(monkeypatch) -> None:
    _patch_git(monkeypatch, [_service_entry("feature/x")])
    removed: list = []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, [])
    result = runner.invoke(app, ["worktrees", "sweep", "--repo", "/some/clone"])
    assert result.exit_code == 0
    assert "removed 1, skipped 0" in result.stdout
    assert removed[0][0] == H_WORKSPACE_DIR / "worktrees" / "feature-x"
