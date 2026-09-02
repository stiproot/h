"""The consumer-repo surface: .h/config.toml discovery, the charts search path, h doctor.

A repo that consumes h declares its paths once in `<repo>/.h/config.toml`; the CLI discovers the
file by walking up from cwd (per-repo behaviour, the way git resolves its repo). The charts
search path makes a consumer chart ADDITIVE — primary first, h's stock chart as fallback —
instead of the all-or-nothing replacement the h-packaged POC hit live (2026-08-13).

config.py computes at import, so these tests reload it under a monkeypatched cwd/env and restore
the pristine module afterwards (reload re-executes into the SAME module dict, so config
FUNCTIONS see the new values while other modules' from-imports of constants stay untouched
until the restoring reload).
"""

import json
import importlib
from pathlib import Path

import pytest
from typer.testing import CliRunner

import h_cli.config as config

runner = CliRunner()

# Every env var the config settings read — cleared so a developer's shell cannot skew a test.
_SETTING_ENV = (
    "H_CHARTS_DIR",
    "H_LOCAL_BIN",
    "H_WORKSPACE_DIR",
    "H_LOCAL_WORKTREES_DIR",
    "AGENT_RUNS_DIR",
    "H_DOTENV",
    "H_EVENTS_STORE",
)


@pytest.fixture
def reload_config(monkeypatch):
    """Reload config with a given cwd (+ optional env), restoring the real module after."""

    def _reload(cwd: Path, **env: str):
        for var in _SETTING_ENV:
            monkeypatch.delenv(var, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        monkeypatch.chdir(cwd)
        return importlib.reload(config)

    yield _reload
    monkeypatch.undo()
    importlib.reload(config)


def _consumer_repo(tmp_path: Path, config_body: str, *templates: str) -> Path:
    repo = tmp_path / "consumer"
    (repo / ".h").mkdir(parents=True)
    (repo / ".h" / "config.toml").write_text(config_body)
    tdir = repo / ".h" / "charts" / "workflows" / "templates"
    tdir.mkdir(parents=True)
    for name in templates:
        (tdir / f"{name}.tmpl.yaml").write_text("role: standalone\n")
    return repo


def test_config_discovered_walking_up_and_paths_resolve_against_its_repo(
    tmp_path, reload_config
) -> None:
    """cwd deep inside the consumer repo still finds <repo>/.h/config.toml, and a relative
    charts_dir resolves against the repo carrying the file — not against cwd."""
    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n', "simulate-skate-game")
    deep = repo / "apps" / "somewhere"
    deep.mkdir(parents=True)
    cfg = reload_config(deep)
    assert cfg.CONSUMER_CONFIG_ROOT == repo
    assert cfg.CHARTS_DIR == (repo / ".h" / "charts").resolve()


def test_search_path_is_consumer_first_stock_fallback(tmp_path, reload_config) -> None:
    """The consumer's own template resolves to its chart; a stock name still resolves to h's —
    additive, not replacing (the POC's all-or-nothing finding)."""
    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n', "simulate-skate-game")
    cfg = reload_config(repo)
    assert cfg.charts_roots() == ((repo / ".h" / "charts").resolve(), cfg.STOCK_CHARTS_DIR)
    assert cfg.chart_root_for("simulate-skate-game") == (repo / ".h" / "charts").resolve()
    assert cfg.chart_root_for("answer") == cfg.STOCK_CHARTS_DIR
    assert cfg.chart_root_for("no-such-template") is None


def test_a_consumer_template_shadows_a_stock_name(tmp_path, reload_config) -> None:
    """A name in both charts resolves to the primary — shadowing is the overlay semantics."""
    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n', "answer")
    cfg = reload_config(repo)
    assert cfg.chart_root_for("answer") == (repo / ".h" / "charts").resolve()


def test_env_var_wins_over_config_file(tmp_path, reload_config) -> None:
    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n')
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    cfg = reload_config(repo, H_CHARTS_DIR=str(elsewhere))
    assert cfg.CHARTS_DIR == elsewhere


def test_no_config_means_stock_only(tmp_path, reload_config) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    cfg = reload_config(bare)
    assert cfg.CONSUMER_CONFIG_ROOT is None
    assert cfg.charts_roots() == (cfg.STOCK_CHARTS_DIR,)


def test_unknown_key_fails_loud_with_both_lists(tmp_path, reload_config) -> None:
    """A typo'd key must not silently fall back to a default — that is how a run lands in the
    wrong charts. The refusal names the offender AND the supported set."""
    repo = _consumer_repo(tmp_path, 'chart_dir = ".h/charts"\n')  # typo: chart_dir
    with pytest.raises(SystemExit) as caught:
        reload_config(repo)
    assert "chart_dir" in str(caught.value)
    assert "charts_dir" in str(caught.value)


def test_non_string_value_fails_loud(tmp_path, reload_config) -> None:
    repo = _consumer_repo(tmp_path, "charts_dir = 7\n")
    with pytest.raises(SystemExit) as caught:
        reload_config(repo)
    assert "charts_dir" in str(caught.value)


def test_malformed_toml_fails_loud(tmp_path, reload_config) -> None:
    repo = _consumer_repo(tmp_path, "charts_dir = \n")
    with pytest.raises(SystemExit) as caught:
        reload_config(repo)
    assert "malformed" in str(caught.value)


def test_doctor_reports_and_exits_zero() -> None:
    """Doctor is a report, not a gate: exit 0 whatever is missing (refusals stay at each
    surface's point of use)."""
    from h_cli.main import app

    result = runner.invoke(app, ["doctor"])
    assert result.exit_code == 0
    assert "tools" in result.output
    assert "h-local runner" in result.output


def test_workflow_run_local_refuses_an_unmanaged_checkout(tmp_path, monkeypatch) -> None:
    """The boundary check delegate/serve already make, now on `workflow run --local` too: the
    invoking checkout becomes the run's repoPath, so an unmanaged one is refused by name."""
    import subprocess

    from h_cli.main import app

    outside = tmp_path / "outside"
    outside.mkdir()
    subprocess.run(["git", "init", "-q", str(outside)], check=True)
    monkeypatch.chdir(outside)
    result = runner.invoke(app, ["workflow", "run", "answer", "--local", "-p", "task=x"])
    assert result.exit_code == 1
    combined = result.output + str(result.exception or "")
    assert "outside the workspace h manages" in combined


def test_allow_external_requires_local() -> None:
    from h_cli.main import app

    result = runner.invoke(app, ["workflow", "run", "answer", "--allow-external"])
    assert result.exit_code == 1
    assert "--allow-external applies to --local only" in (result.output or "")


def _consumer_values(repo: Path, body: str, local: bool = False) -> Path:
    name = "values.local.yaml" if local else "values.yaml"
    path = repo / ".h" / "charts" / "workflows" / name
    path.write_text(body)
    return path


def test_consumer_values_layer_over_a_stock_template(tmp_path, reload_config) -> None:
    """A consumer's committed values.yaml is layered over the stock chart's defaults when a STOCK
    template renders from the consumer repo — the values counterpart of the template search path.
    `verify.cmd` is the motivating case: required at render, and a packaged install has no other
    place to put it (trxy, 2026-09-01)."""
    from h_cli.infrastructure import helm

    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n')
    _consumer_values(repo, 'verify:\n  cmd: "bun run verify"\n')
    reload_config(repo)
    rendered = helm.render_workflow("verify", values={"publish": "true"}, include_local=False)
    assert "bun run verify" in rendered


def test_consumer_values_precedence_is_stock_then_consumer_then_set(
    tmp_path, reload_config
) -> None:
    """--set still wins over the consumer's file, and the consumer's values.local.yaml (machine
    overrides) wins over its committed values.yaml — but only when include_local is on."""
    from h_cli.infrastructure import helm

    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n')
    _consumer_values(repo, 'verify:\n  cmd: "committed-cmd"\n')
    _consumer_values(repo, 'verify:\n  cmd: "local-cmd"\n', local=True)
    reload_config(repo)
    hermetic = helm.render_workflow("verify", values={"publish": "true"}, include_local=False)
    assert "committed-cmd" in hermetic and "local-cmd" not in hermetic
    with_local = helm.render_workflow("verify", values={"publish": "true"})
    assert "local-cmd" in with_local
    explicit = helm.render_workflow("verify", values={"publish": "true", "verify.cmd": "set-cmd"})
    assert "set-cmd" in explicit and "local-cmd" not in explicit


def test_values_layers_only_preceding_roots_and_existing_files(tmp_path, reload_config) -> None:
    """Only roots that PRECEDE the owning root on the search path are layered, and only files
    that exist. A consumer template renders from its own chart — layering the stock chart's
    values.yaml under it would let stock defaults override the consumer's own, inverting the
    search path — while a stock template gains the consumer layer."""
    from h_cli.infrastructure import helm

    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n', "domain-thing")
    consumer_chart = (repo / ".h" / "charts" / "workflows").resolve()
    cfg = reload_config(repo)
    stock_chart = cfg.STOCK_CHARTS_DIR / "workflows"
    assert helm.values_layers(stock_chart, include_local=False) == []
    _consumer_values(repo, "x: 1\n")
    assert helm.values_layers(stock_chart, include_local=False) == [consumer_chart / "values.yaml"]
    assert helm.values_layers(consumer_chart, include_local=False) == []
    _consumer_values(repo, "x: 2\n", local=True)
    assert helm.values_layers(consumer_chart) == [consumer_chart / "values.local.yaml"]


@pytest.mark.parametrize("name", ["implement", "plan", "review-pr", "review-spec", "revise-pr"])
def test_consumer_worktree_seed_lands_on_every_create_worktree_step(
    name: str, tmp_path, reload_config
) -> None:
    """A consumer declares `worktree.seed` ONCE in its committed values.yaml and every stock template
    that cuts a worktree carries it as the create-worktree step's `seed` input — the gitignored env
    files a gate needs (trxy night 1, 2026-08-31: every worktree gate failed on a missing .env until
    the driver copied it by hand). Publish mode keeps the list literal: chart config, not a fire-time
    param."""
    from h_cli.infrastructure import helm

    repo = _consumer_repo(tmp_path, 'charts_dir = ".h/charts"\n')
    _consumer_values(repo, 'worktree:\n  seed: ["apps/svc/.env", ".env.local"]\n')
    reload_config(repo)
    rendered = helm.render_workflow(name, values={"publish": "true"}, include_local=False)
    definition = json.loads(helm.to_wire_json(rendered))
    (step,) = [s for s in definition["steps"] if s.get("activity") == "create-worktree"]
    assert step["input"]["seed"] == ["apps/svc/.env", ".env.local"]
