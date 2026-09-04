import subprocess
from pathlib import Path

from h_cli.config import checkout_anchor, main_checkout_dir


def _git(*args: str, cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _repo_with_worktree(tmp_path: Path) -> tuple[Path, Path]:
    repo_dir = tmp_path / "h"
    repo_dir.mkdir()
    _git("init", cwd=repo_dir)
    _git("config", "user.name", "Checkout Anchor Test", cwd=repo_dir)
    _git("config", "user.email", "checkout-anchor@example.invalid", cwd=repo_dir)
    (repo_dir / "tracked.txt").write_text("tracked\n")
    _git("add", "tracked.txt", cwd=repo_dir)
    _git("commit", "-m", "test fixture", cwd=repo_dir)

    worktree_dir = tmp_path / "h-worktrees" / "feat"
    worktree_dir.parent.mkdir()
    _git("worktree", "add", str(worktree_dir), "-b", "feat", cwd=repo_dir)
    return repo_dir, worktree_dir


def test_checkout_anchor_matches_for_main_checkout_and_worktree(tmp_path: Path) -> None:
    repo_dir, worktree_dir = _repo_with_worktree(tmp_path)

    assert checkout_anchor(worktree_dir).resolve() == tmp_path.resolve()
    assert checkout_anchor(repo_dir).resolve() == tmp_path.resolve()
    assert main_checkout_dir(worktree_dir).resolve() == repo_dir.resolve()


def test_plain_checkout_anchor_is_independent_of_process_cwd(tmp_path: Path, monkeypatch) -> None:
    repo_dir, _ = _repo_with_worktree(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    assert checkout_anchor(repo_dir).resolve() == repo_dir.parent.resolve()


def test_checkout_anchor_falls_back_without_git(tmp_path: Path, monkeypatch) -> None:
    exported_dir = tmp_path / "exported-h"
    exported_dir.mkdir()
    monkeypatch.setenv("PATH", "")

    assert checkout_anchor(exported_dir).resolve() == exported_dir.parent.resolve()
