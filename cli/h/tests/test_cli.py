"""CLI-level behavior through typer's in-process runner: exit codes, parseable output, wiring.

Presentation (rich tables, spinners) is deliberately not snapshotted — assert on behavior,
not box-drawing characters. The rendered-artifact snapshots live in test_render.py.
"""

import json
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from h_cli.commands import feature
from h_cli.main import app

runner = CliRunner()

needs_helm = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm not on PATH (renders cli/charts)"
)


def _all_output(result) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass  # click merged stderr into output
    return out


def test_no_args_shows_help() -> None:
    result = runner.invoke(app, [])
    assert "feature" in result.output
    assert "workflow" in result.output


@needs_helm
def test_feature_render_json_is_a_valid_definition(hostile_spec: Path) -> None:
    result = runner.invoke(app, ["feature", "render", str(hostile_spec), "--json"])
    assert result.exit_code == 0, _all_output(result)
    definition = json.loads(result.output)
    assert definition["instanceId"] == "feature-hostile"
    assert [s["id"] for s in definition["steps"]] == ["worktree", "setup", "plan", "implement"]


@needs_helm
def test_feature_render_slug_override(hostile_spec: Path) -> None:
    result = runner.invoke(
        app, ["feature", "render", str(hostile_spec), "--slug", "ui-theme", "--json"]
    )
    assert result.exit_code == 0, _all_output(result)
    assert json.loads(result.output)["instanceId"] == "feature-ui-theme"


def test_feature_render_missing_spec_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(feature, "FEATURE_SPECS_DIR", tmp_path)
    result = runner.invoke(app, ["feature", "render", "does-not-exist"])
    assert result.exit_code == 1


@needs_helm
def test_feature_render_bad_slug_surfaces_helm_error(hostile_spec: Path) -> None:
    result = runner.invoke(
        app, ["feature", "render", str(hostile_spec), "--slug", "Bad_Slug", "--json"]
    )
    assert result.exit_code == 1
    assert "does not match pattern" in _all_output(result)


def test_workflow_list_unreachable_service_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    from h_cli.infrastructure import workflow_svc

    monkeypatch.setattr(workflow_svc, "WORKFLOW_URL", "http://127.0.0.1:1")
    result = runner.invoke(app, ["workflow", "list"])
    assert result.exit_code == 1
