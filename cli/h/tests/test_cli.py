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


def test_warn_missing_source_repo(capsys) -> None:
    rendered = (
        "steps:\n"
        "  - id: worktree\n"
        "    activity: create-worktree\n"
        "    input:\n"
        "      clonePath: /definitely/not/a/real/path\n"
    )
    feature._warn_missing_source_repo(rendered)
    assert "does not exist locally" in capsys.readouterr().err


def test_no_warning_for_existing_or_default_source_repo(capsys, tmp_path) -> None:
    feature._warn_missing_source_repo(
        f"steps:\n  - activity: create-worktree\n    input:\n      clonePath: {tmp_path}\n"
    )
    feature._warn_missing_source_repo("steps:\n  - activity: create-worktree\n    input: {}\n")
    assert capsys.readouterr().err == ""


@needs_helm
def test_feature_render_json_is_a_valid_definition(hostile_spec: Path) -> None:
    result = runner.invoke(app, ["feature", "render", str(hostile_spec), "--json"])
    assert result.exit_code == 0, _all_output(result)
    definition = json.loads(result.output)
    assert definition["instanceId"] == "feature-hostile"
    # This goes through the real CLI path, which merges the dev's gitignored values.local.yaml —
    # so the optional verify step (feature.verifyCmd) may or may not be present. The hermetic
    # step-shape assertions live in test_render.py.
    ids = [s["id"] for s in definition["steps"]]
    assert ids[:4] == ["worktree", "setup", "plan", "implement"]
    assert ids[4:] in ([], ["verify"])


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


@needs_helm
def test_template_compose_prints_merged_definition() -> None:
    result = runner.invoke(app, ["template", "compose", "feature", "create-pr"])
    assert result.exit_code == 0, _all_output(result)
    # The merged YAML carries feature's four steps with create-pr's epilogue folded into implement.
    assert "worktree" in result.output and "===PR===" in result.output
    assert "feature ⊕ create-pr" in result.output


def test_template_compose_requires_an_operand() -> None:
    result = runner.invoke(app, ["template", "compose"])
    assert result.exit_code == 1
    assert "at least one" in _all_output(result)


@needs_helm
def test_template_compose_unknown_template_exits_1() -> None:
    result = runner.invoke(app, ["template", "compose", "no-such-template"])
    assert result.exit_code == 1


def test_template_list_names_the_chart_atoms() -> None:
    result = runner.invoke(app, ["template", "list"])
    assert result.exit_code == 0, _all_output(result)
    for name in ("feature", "create-pr", "verify"):
        assert name in result.output


@needs_helm
def test_template_get_renders_one_atom() -> None:
    result = runner.invoke(app, ["template", "get", "create-pr"])
    assert result.exit_code == 0, _all_output(result)
    assert "steps" in result.output


def test_workflow_compose_is_gone() -> None:
    # Atomic relocation: the old spelling must fail loudly, not half-work.
    result = runner.invoke(app, ["workflow", "compose", "-t", "feature"])
    assert result.exit_code != 0


def test_workflow_list_unreachable_service_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    from h_cli.infrastructure import workflow_svc

    monkeypatch.setattr(workflow_svc, "WORKFLOW_URL", "http://127.0.0.1:1")
    result = runner.invoke(app, ["workflow", "list"])
    assert result.exit_code == 1
