"""h worktrees — the sweep surface for both substrates (monkeypatched git, no HTTP)."""

import errno
import json
import os
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from h_cli.commands.worktrees import _blocked
from h_cli.config import H_WORKSPACE_DIR, LOCAL_WORKTREES_DIR
from h_cli.infrastructure.git import Dirt, WorktreeEntry, worktree_dirt
from h_cli.main import app

runner = CliRunner()

FAKE_REPO = Path("/fake/repo")


def _entry(branch_short: str, under_local: bool = True) -> WorktreeEntry:
    path = LOCAL_WORKTREES_DIR / branch_short.replace("/", "-") if under_local else Path("/other")
    branch = f"refs/heads/{branch_short}" if branch_short != "(detached)" else None
    return WorktreeEntry(path=path, head="abc1234", branch=branch)


def _patch_git(monkeypatch, entries, dirty=False, unpushed=False, untracked=()) -> None:
    # The husk pass reads the real filesystem, so an unrelated test would otherwise see whatever
    # leaked directories the developer's machine happens to hold. Husks have their own tests.
    monkeypatch.setattr("h_cli.commands.worktrees._husks", lambda repo: [])
    monkeypatch.setattr("h_cli.infrastructure.local_runtime.repo_root", lambda cwd: str(FAKE_REPO))
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_prune", lambda repo: None)
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_list",
        lambda repo: [_entry("main", under_local=False)] + entries,
    )
    _patch_dirt(monkeypatch, lambda path: Dirt(tracked=dirty, untracked=list(untracked)))
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_has_unpushed", lambda path: unpushed)


def _patch_dirt(monkeypatch, fn) -> None:
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_dirt", fn)


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
    _patch_dirt(monkeypatch, lambda path: Dirt(tracked=path in dirty_paths, untracked=[]))
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
    _patch_dirt(monkeypatch, lambda path: Dirt(tracked=path in dirty_paths, untracked=[]))
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


# --- scratch: untracked-only dirt is its own class -----------------------------------------
#
# One leftover scratch file used to mark a whole finished worktree dirty, so reclaiming it needed
# --force — the flag that also discards tracked edits and unpushed commits. Untracked-only dirt is
# now a distinct status with its own narrower flag.

SCRATCH = ["plan-feature-review-spec-template.md"]


# The shared safety contract — see the fixture's own `_why`. The unattended collector
# (git-core's worktree-gc, TypeScript) reads the SAME file, so the two implementations of these
# rules can differ in every way except what they would delete. The path is asserted by
# scripts/check-sweep-parity.mjs, so neither consumer can quietly stop reading it.
PARITY_FIXTURE = (
    Path(__file__).resolve().parents[3] / "scripts/fixtures/worktree-classification.json"
)


@pytest.mark.parametrize(
    "case",
    json.loads(PARITY_FIXTURE.read_text())["cases"],
    ids=lambda case: case["name"],
)
def test_sweep_rule_parity_with_the_unattended_collector(case, monkeypatch) -> None:
    monkeypatch.setattr(
        "subprocess.run",
        lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout=case["porcelain"], stderr=""),
    )
    dirt = worktree_dirt(Path("/anywhere"))
    assert dirt.tracked is case["tracked"]
    assert list(dirt.untracked) == case["untracked"]

    # `_blocked` returns the REASON; parity is over the decision, so wording may differ across the
    # two languages while the outcome may not.
    collectable = lambda prune: (  # noqa: E731 - a local alias keeps the assertions readable
        _blocked(dirt, case["unpushed"], force=False, prune_untracked=prune) is None
    )
    assert collectable(False) is case["collectable"]
    assert collectable(True) is case["collectableWithPrune"]


def test_worktree_dirt_splits_porcelain_by_class(monkeypatch) -> None:
    """The parse the whole decision rests on: `??` is scratch, every other line is tracked."""
    porcelain = " M src/a.py\n?? plan.md\nA  src/new.py\n?? notes/scratch.txt\n"
    monkeypatch.setattr(
        "subprocess.run",
        lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout=porcelain, stderr=""),
    )
    dirt = worktree_dirt(Path("/anywhere"))
    assert dirt.tracked is True
    assert dirt.untracked == ["plan.md", "notes/scratch.txt"]
    assert dirt.untracked_only is False


def test_worktree_dirt_reports_tracked_when_git_fails(monkeypatch) -> None:
    """Unknown state is never sweepable — the safe default the whole surface leans on."""

    def boom(*a, **kw):
        raise OSError("no such directory")

    monkeypatch.setattr("subprocess.run", boom)
    dirt = worktree_dirt(Path("/gone"))
    assert dirt.tracked is True
    assert dirt.untracked_only is False


def test_list_reports_untracked_only_as_scratch(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], untracked=SCRATCH)
    result = runner.invoke(app, ["worktrees", "list"])
    assert result.exit_code == 0
    assert "scratch" in result.output
    assert "dirty" not in result.output


def test_list_json_separates_untracked_from_tracked_dirt(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], untracked=SCRATCH)
    rows = json.loads(runner.invoke(app, ["worktrees", "list", "--json"]).stdout)
    assert rows[0]["dirty"] is False  # `dirty` now means TRACKED modifications only
    assert rows[0]["untracked"] == SCRATCH


def test_sweep_skips_scratch_by_default(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], untracked=SCRATCH)
    removed: list = []
    _capture_remove(monkeypatch, removed)
    result = runner.invoke(app, ["worktrees", "sweep"])
    assert result.exit_code == 0
    assert removed == []
    assert "1 untracked file" in result.output


def test_sweep_prune_untracked_removes_scratch_and_names_the_files(monkeypatch) -> None:
    entry = _entry("local/260101-010101")
    _patch_git(monkeypatch, [entry], untracked=SCRATCH)
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "sweep", "--prune-untracked"])
    assert result.exit_code == 0
    # git itself refuses a worktree holding untracked files without its own --force.
    assert removed == [(entry.path, {"force": True})]
    assert SCRATCH[0] in result.output  # the file list IS the safety check
    assert "removed 1, skipped 0" in result.output


def test_prune_untracked_does_not_unlock_tracked_dirt_or_unpushed(monkeypatch) -> None:
    tracked = _entry("local/260101-010101")
    unpushed = _entry("local/260101-010102")
    _patch_git(monkeypatch, [tracked, unpushed], untracked=SCRATCH)
    _patch_dirt(
        monkeypatch,
        lambda path: Dirt(tracked=path == tracked.path, untracked=list(SCRATCH)),
    )
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_has_unpushed", lambda path: path == unpushed.path
    )
    removed: list = []
    _capture_remove(monkeypatch, removed)
    result = runner.invoke(app, ["worktrees", "sweep", "--prune-untracked"])
    assert result.exit_code == 0
    assert removed == []
    assert "removed 0, skipped 2" in result.output


def test_rm_refuses_scratch_but_points_at_the_narrow_flag(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], untracked=SCRATCH)
    result = runner.invoke(app, ["worktrees", "rm", "local/260101-010101"])
    assert result.exit_code == 1
    assert "--prune-untracked" in result.output
    assert "--force" not in result.output


def test_rm_prune_untracked_removes_scratch(monkeypatch) -> None:
    entry = _entry("local/260101-010101")
    _patch_git(monkeypatch, [entry], untracked=SCRATCH)
    removed, deleted = [], []
    _capture_remove(monkeypatch, removed)
    _capture_delete(monkeypatch, deleted)
    result = runner.invoke(app, ["worktrees", "rm", "local/260101-010101", "--prune-untracked"])
    assert result.exit_code == 0
    assert removed == [(entry.path, {"force": True})]
    assert deleted == [("local/260101-010101", {})]


def test_dry_run_shows_what_a_scratch_removal_would_discard(monkeypatch) -> None:
    _patch_git(monkeypatch, [_entry("local/260101-010101")], untracked=SCRATCH)
    removed: list = []
    _capture_remove(monkeypatch, removed)
    result = runner.invoke(app, ["worktrees", "sweep", "--prune-untracked", "--dry-run"])
    assert result.exit_code == 0
    assert removed == []
    assert "discarding 1 untracked file" in result.output
    assert SCRATCH[0] in result.output


# --- husks: directories git has no record of -------------------------------------------------
#
# The gap that let 1.8GB hide under h-worktrees/ on 2026-08-23: `git worktree list` reported
# nothing, so the sweep reported "no h-managed worktrees found" and walked past a full worktree
# whose registration had been lost. git-core's collector had this pass; the CLI did not.


def _patch_husks(monkeypatch, names) -> None:
    """Sweep-level: git knows of no worktrees, and `names` are sitting on disk unregistered."""
    monkeypatch.setattr("h_cli.infrastructure.local_runtime.repo_root", lambda cwd: str(FAKE_REPO))
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_prune", lambda repo: None)
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_list", lambda repo: [_entry("main", under_local=False)]
    )
    monkeypatch.setattr(
        "h_cli.commands.worktrees._husks",
        lambda repo: [LOCAL_WORKTREES_DIR / n for n in names],
    )


def test_sweep_reports_a_husk_instead_of_claiming_nothing_to_do(monkeypatch):
    """The exact 2026-08-23 shape: git knows of no worktrees, but a directory is sitting there."""
    _patch_husks(monkeypatch, ["orphaned-run"])
    result = runner.invoke(app, ["worktrees", "sweep", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "no h-managed worktrees found" not in result.output
    assert "orphaned-run" in result.output and "husk" in result.output


def test_sweep_keeps_a_husk_without_prune_untracked(monkeypatch):
    """A husk holds only files git never tracked, so it needs the same permission as scratch."""
    _patch_husks(monkeypatch, ["orphaned-run"])
    result = runner.invoke(app, ["worktrees", "sweep", "--dry-run"])
    assert "would skip: orphaned-run" in result.output
    assert "--prune-untracked" in result.output


def test_sweep_collects_a_husk_with_prune_untracked(monkeypatch):
    _patch_husks(monkeypatch, ["orphaned-run"])
    result = runner.invoke(app, ["worktrees", "sweep", "--dry-run", "--prune-untracked"])
    assert "would remove: orphaned-run" in result.output


def test_husks_finds_an_unregistered_directory_and_ignores_a_registered_one(monkeypatch, tmp_path):
    """The detection itself, against a real directory tree."""
    from h_cli.commands import worktrees as wt

    root = tmp_path / "h-worktrees"
    (root / "registered").mkdir(parents=True)
    (root / "orphaned-run").mkdir()
    (root / "not-a-dir.txt").write_text("x")
    monkeypatch.setattr(wt, "_managed_roots", lambda: [root])
    monkeypatch.setattr(
        "h_cli.infrastructure.git.worktree_list",
        lambda repo: [WorktreeEntry(path=root / "registered", head="abc", branch="refs/heads/x")],
    )

    found = [p.name for p in wt._husks("repo")]
    assert found == ["orphaned-run"], "a registered worktree is not a husk, and a file is not one"


def test_husks_spares_another_repos_live_worktree(monkeypatch, tmp_path):
    """The managed root is shared across repos: a sweep against one clone must not read another
    clone's live worktree as a husk. Discriminated by the directory's own `.git` link resolving —
    a dangling one (pruned gitdir) stays a husk."""
    import subprocess

    from h_cli.commands import worktrees as wt

    root = tmp_path / "h-worktrees"
    root.mkdir()
    other = tmp_path / "other-repo"
    other.mkdir()
    subprocess.run(["git", "init", "-q", str(other)], check=True)
    # Identity per-invocation: a CI runner has no global user.email, and `git commit` exits 128
    # without one — the test passed on a developer box and was red on every CI run.
    subprocess.run(
        [
            "git",
            "-C",
            str(other),
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=h test",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "x",
        ],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(other), "worktree", "add", "-q", str(root / "theirs-live")], check=True
    )
    subprocess.run(
        ["git", "-C", str(other), "worktree", "add", "-q", str(root / "theirs-pruned")], check=True
    )
    # Break the second one the way a failed removal does: gitdir gone, directory left behind.
    subprocess.run(
        ["git", "-C", str(other), "worktree", "remove", "--force", str(root / "theirs-pruned")],
        check=True,
    )
    (root / "theirs-pruned").mkdir()
    (root / "theirs-pruned" / ".git").write_text(f"gitdir: {other}/.git/worktrees/theirs-pruned\n")
    (root / "no-git-at-all").mkdir()
    monkeypatch.setattr(wt, "_managed_roots", lambda: [root])
    monkeypatch.setattr("h_cli.infrastructure.git.worktree_list", lambda repo: [])

    found = sorted(p.name for p in wt._husks("repo"))
    assert found == ["no-git-at-all", "theirs-pruned"], found


# --- husk permission-error reporting ----------------------------------------------------------


@pytest.mark.skipif(os.getuid() == 0, reason="running as root — permission blocks don't apply")
def test_sweep_husk_permission_error_reports_full_path_owner_and_suggestion(monkeypatch):
    """A root-owned file blocking shutil.rmtree must produce a report with:
    - the husk's full path (not just name)
    - the blocking entry's full path
    - the owner uid:gid (with passwd name where available)
    - the collector's own uid
    - whether the collection was partial or untouched
    - a suggested sudo command the operator can run manually
    """
    import types

    from h_cli.commands import worktrees as wt_mod

    husk = LOCAL_WORKTREES_DIR / "implement-260824-121020"
    blocking = str(LOCAL_WORKTREES_DIR / "implement-260824-121020" / "build-history.bin")

    _patch_husks(monkeypatch, ["implement-260824-121020"])

    def _raise_permission(*args, **kw):
        raise PermissionError(errno.EACCES, "Permission denied", blocking)

    # Patch shutil in the worktrees module so pytest's own shutil calls are unaffected.
    monkeypatch.setattr(wt_mod, "shutil", types.SimpleNamespace(rmtree=_raise_permission))

    _sizes = iter([1_800_000_000, 100_000_000])
    monkeypatch.setattr(wt_mod, "_dir_size", lambda p: next(_sizes), raising=False)

    class _Stat:
        st_uid = 0
        st_gid = 0

    class _PwEntry:
        pw_name = "root"

    # Patch os and pwd in the worktrees module so global os.stat / pwd.getpwuid are unaffected.
    monkeypatch.setattr(
        wt_mod,
        "os",
        types.SimpleNamespace(stat=lambda p: _Stat(), getuid=lambda: 1000),
        raising=False,
    )
    monkeypatch.setattr(
        wt_mod,
        "pwd",
        types.SimpleNamespace(getpwuid=lambda uid: _PwEntry()),
        raising=False,
    )

    result = runner.invoke(app, ["worktrees", "sweep", "--prune-untracked"])

    assert result.exit_code == 1
    out = result.output
    # Rich may wrap long paths at 80 chars; join lines before checking full-path substrings.
    flat = out.replace("\n", "")

    # New message format — the clearest indicator of the old code's poverty.
    assert "blocked by (first encountered)" in out
    # Full paths must appear (join lines to handle Rich console wrapping of long paths).
    assert str(husk) in flat  # full husk path, not just name
    assert blocking in flat  # blocking entry's full path
    # Owner and collector uid information (absent in the old errno message).
    assert "root (0)" in out
    assert "1000" in out  # collector uid
    # Size tracking distinguishes a partial collection from an untouched husk.
    assert "reclaimed" in out or "untouched" in out
    # Suggested operator command — the CLI never runs it (see comment in worktrees.py).
    assert "sudo rm -rf" in out
    # Summary line shape is unchanged.
    assert "1 failed" in out
    # Wording does not claim the named blocker is the only one.
    assert "first encountered" in out
