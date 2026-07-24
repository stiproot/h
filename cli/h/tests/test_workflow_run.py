"""h workflow run --inline: render a template on the fly and fire its steps (respx-mocked wire)."""

import json
import shutil

import pytest
import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()


def _all_output(result) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass
    return out

needs_helm = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm not on PATH (renders cli/charts)"
)


@needs_helm
@respx.mock
def test_inline_renders_a_template_and_fires_its_steps() -> None:
    """--inline posts the rendered steps + merged params to /workflow/run (no saved key, no
    publish)."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run").mock(
        return_value=Response(202, json={"instanceId": "revise-pi-agent", "watching": False})
    )
    result = runner.invoke(
        app,
        [
            "workflow", "run", "revise", "--inline",
            "-p", "pr=30", "-p", "repo=stiproot/h", "-p", "slug=pi-agent",
            "--instance-id", "revise-pi-agent",
        ],
    )
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(route.calls[0].request.content)
    # Raw steps came from the render (not a saved-key lookup).
    assert isinstance(body["steps"], list) and body["steps"]
    # -p content values are merged into params and resolve {{params.*}} in the steps.
    assert body["params"]["pr"] == "30"
    assert body["params"]["repo"] == "stiproot/h"
    assert body["params"]["slug"] == "pi-agent"
    assert body["instanceId"] == "revise-pi-agent"


@needs_helm
@respx.mock
def test_inline_cron_arms_an_embedded_recurrence() -> None:
    """--inline --cron posts armCron{inline:true} + wf identity so the run recurs over an
    EMBEDDED source built from its own steps (docs/plans/inline-chain-cron-composition.md D1)."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run").mock(
        return_value=Response(202, json={"instanceId": "revise-pi-agent", "watching": False})
    )
    result = runner.invoke(
        app,
        [
            "workflow", "run", "revise", "--inline",
            "-p", "repo=stiproot/h", "-p", "slug=pi-agent", "-p", "pr=30",
            "--cron", "*/30 * * * *", "--max-fires", "20",
            "--instance-id", "revise-pi-agent",
        ],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    assert body["armCron"] == {
        "cadence": "*/30 * * * *",
        "workflow": "revise",
        "inline": True,
        "budget": {"maxFires": 20},
    }
    # The wf-identity the cron key mirrors + the goal-handshake row the run writes.
    assert body["wf"] == {"repo": "stiproot/h", "slug": "pi-agent", "workflow": "revise"}
    # The embedded source recurs THESE steps — they still ride the initial run body.
    assert isinstance(body["steps"], list) and body["steps"]


@needs_helm
def test_inline_cron_requires_repo_and_slug() -> None:
    """The cron key mirrors the wf: coords, so --inline --cron without repo/slug is a clear error
    (fail closed rather than arm a malformed cron row)."""
    result = runner.invoke(
        app, ["workflow", "run", "revise", "--inline", "--cron", "*/30 * * * *"]
    )
    assert result.exit_code == 1
    assert "repo and slug" in result.output


@respx.mock
def test_cron_flag_registers_a_recurrence_on_the_saved_run() -> None:
    """--cron/--max-fires ride the run as a cron policy on /workflow/run/:key (the 4d field)."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run/revise").mock(
        return_value=Response(202, json={"instanceId": "revise-x", "watching": False})
    )
    result = runner.invoke(
        app,
        ["workflow", "run", "revise", "-p", "repo=o/r", "-p", "slug=x",
         "--cron", "*/30 * * * *", "--max-fires", "50"],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    assert body["cron"] == {"cadence": "*/30 * * * *", "budget": {"maxFires": 50}}
    assert body["params"] == {"repo": "o/r", "slug": "x"}


def test_max_fires_without_cron_errors() -> None:
    result = runner.invoke(app, ["workflow", "run", "revise", "--max-fires", "10"])
    assert result.exit_code == 1
    assert "--cron" in result.output


def test_inline_rejects_via() -> None:
    """--inline fires directly on workflow-svc; combining it with --via is a clear error."""
    result = runner.invoke(
        app, ["workflow", "run", "revise", "--inline", "--via", "claude-agent"]
    )
    assert result.exit_code == 1
    assert "inline" in result.output.lower()


# --- the --agent roster (docs/plans/panels-as-a-modifier.md) ---------------------------------


@needs_helm
@respx.mock
def test_agent_roster_panelizes_and_fires_inline() -> None:
    """A repeated --agent is a panel roster: the definition is panelized (parallel branches +
    a judge synthesis under the original contract) and fired as raw steps on /workflow/run."""
    route = respx.post(f"{WORKFLOW_URL}/workflow/run").mock(
        return_value=Response(202, json={"instanceId": "panel-x", "watching": False})
    )
    result = runner.invoke(
        app,
        [
            "workflow", "run", "pr-review",
            "--agent", "claude", "--agent", "codex", "--agent", "openhands",
            "-p", "pr=64", "-p", "repo=stiproot/h", "-p", "slug=x",
        ],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls[0].request.content)
    steps = body["steps"]
    panel = next(step for step in steps if "parallel" in step)
    assert [b["id"] for b in panel["parallel"]] == ["claude", "codex", "openhands"]
    assert [b["activity"] for b in panel["parallel"]] == [
        "run-claude", "run-codex", "run-openhands",
    ]
    # The synthesis keeps the workflow's own contract-carrying step id + contract, and the
    # template's panelSynthesis rule is spliced into the judge's task.
    synthesis = steps[steps.index(panel) + 1]
    assert synthesis["id"] == "review"
    assert synthesis["activity"] == "run-claude"
    assert synthesis["input"]["outputContract"]
    assert "Verdict rule" in synthesis["input"]["task"]
    # No identity params ride the body — roster identity is baked per branch.
    assert "runActivity" not in body["params"]


@needs_helm
def test_agent_roster_rejects_model_and_routing() -> None:
    result = runner.invoke(
        app,
        ["workflow", "run", "pr-review", "--agent", "claude", "--agent", "codex",
         "--model", "opus"],
    )
    assert result.exit_code == 1
    assert "roster" in _all_output(result)
    result = runner.invoke(
        app,
        ["workflow", "run", "pr-review", "--agent", "claude", "--agent", "codex",
         "--via", "claude-agent"],
    )
    assert result.exit_code == 1
    assert "roster" in _all_output(result)
