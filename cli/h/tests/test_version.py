"""`h --version` and its provenance stamp — the identity a CONSUMER pins against.

Every wheel cut from main carries the same `0.1.0`, so the release number cannot answer "which
h is this?". A consumer repo that pins h by commit (the isolation a packaged consumer wants)
needs the SOURCE COMMIT, and needs it machine-readably — its sync script compares the installed
commit against its lock. These tests hold that contract:

  - the human line always names a commit or says plainly that it cannot,
  - `--version-json` is parseable and carries the keys a sync script reads,
  - a wheel with no stamp degrades to `commit: null` rather than inventing one.
"""

import json

from typer.testing import CliRunner

from h_cli import config
from h_cli.main import app

runner = CliRunner()


def test_version_names_the_source_commit() -> None:
    """The human line is for an operator asking what they have installed."""
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert "h-cli" in result.stdout
    info = config.build_info()
    if info["shortCommit"]:
        assert str(info["shortCommit"]) in result.stdout
    else:
        # Never silently omit it: an unknown commit is a fact a consumer must be told, because
        # its lock cannot be verified against a build that does not know its own provenance.
        assert "commit unknown" in result.stdout


def test_version_json_is_machine_readable_for_a_sync_script() -> None:
    """The contract a consumer's sync script parses. Keys here are load-bearing OUTSIDE this
    repo — a rename breaks every consumer's lock comparison silently, so they are asserted."""
    result = runner.invoke(app, ["--version-json"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert set(payload) >= {"version", "mode", "commit", "shortCommit", "committedAt", "dirty"}
    assert payload["mode"] in {"checkout", "packaged"}
    assert isinstance(payload["dirty"], bool)


def test_build_info_reports_an_unstamped_bundle_as_unknown(monkeypatch, tmp_path) -> None:
    """A wheel built before provenance existed (or a corrupted bundle) must report no commit
    rather than raise or guess — a consumer sees "cannot verify", which is the truth."""
    monkeypatch.setattr(config, "IS_CHECKOUT", False)
    monkeypatch.setattr(config, "_BUNDLED_DIR", tmp_path)
    info = config.build_info()
    assert info["mode"] == "packaged"
    assert info["commit"] is None
    assert info["dirty"] is False


def test_build_info_reads_a_stamped_bundle(monkeypatch, tmp_path) -> None:
    """The packaged path: the stamp hatch_build.py writes is what --version reports."""
    (tmp_path / "build.json").write_text(
        json.dumps(
            {
                "commit": "a" * 40,
                "shortCommit": "aaaaaaa",
                "committedAt": "2026-08-15T21:10:09+02:00",
                "dirty": False,
            }
        )
    )
    monkeypatch.setattr(config, "IS_CHECKOUT", False)
    monkeypatch.setattr(config, "_BUNDLED_DIR", tmp_path)
    info = config.build_info()
    assert info["commit"] == "a" * 40
    assert info["shortCommit"] == "aaaaaaa"
    assert info["mode"] == "packaged"
