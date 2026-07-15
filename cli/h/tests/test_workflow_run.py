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
