"""Pure units: slug sanitization and spec resolution — no helm, no network."""

from pathlib import Path

import pytest
import typer

from h_cli.commands import feature


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("dark-mode.md", "dark-mode"),
        ("My Feature 2.md", "my-feature-2"),
        ("UPPER_snake__case.md", "upper-snake-case"),
        ("--edges--.md", "edges"),
        ("dots.and.spaces here.md", "dots-and-spaces-here"),
    ],
)
def test_derive_slug_sanitizes_to_branch_safe_token(filename: str, expected: str) -> None:
    assert feature._derive_slug(Path(filename)) == expected


def test_derive_slug_rejects_empty_result(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(typer.Exit) as excinfo:
        feature._derive_slug(Path("###.md"))
    assert excinfo.value.exit_code == 1
    assert "pass --slug" in capsys.readouterr().err


def test_resolve_spec_existing_path_wins(tmp_path: Path) -> None:
    spec = tmp_path / "anywhere.md"
    spec.write_text("# spec")
    assert feature._resolve_spec(str(spec)) == spec


def test_resolve_spec_bare_name_with_and_without_suffix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "dark-mode.md").write_text("# spec")
    monkeypatch.setattr(feature, "FEATURE_SPECS_DIR", tmp_path)
    assert feature._resolve_spec("dark-mode") == tmp_path / "dark-mode.md"
    assert feature._resolve_spec("dark-mode.md") == tmp_path / "dark-mode.md"


def test_resolve_spec_missing_lists_available_and_exits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "other-spec.md").write_text("# spec")
    monkeypatch.setattr(feature, "FEATURE_SPECS_DIR", tmp_path)
    with pytest.raises(typer.Exit) as excinfo:
        feature._resolve_spec("nope")
    assert excinfo.value.exit_code == 1
    err = capsys.readouterr().err
    assert "nope" in err
    assert "other-spec" in err
