"""h chain — registers a chain with the durable chain engine and inspects the registry.

The CLI is a thin client: `run` parses the chain EXPRESSION (chain_expr.py — tested as the grammar
spec in test_chain_expr.py), resolves workflows (well-known names, compose-on-fire `-t` groups,
fire-time identity params), and POSTs /chain/run; `list` reads /chain/list. These tests pin the
request the CLI builds and the workflow-resolution behaviors; the state-threading contract
lives in the engine (workflow-svc chain-scan.test.ts).
"""

import json
import shutil
from pathlib import Path

import pytest
import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()

needs_helm = pytest.mark.skipif(shutil.which("helm") is None, reason="helm not on PATH")


def _all_output(result) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass
    return out


def _spec(tmp_path: Path) -> Path:
    p = tmp_path / "demo.md"
    p.write_text("# Demo\nDo the thing.\n")
    return p


def _pspec(tmp_path: Path) -> str:
    """The `-p spec=@<file>` value that hydrates the chain's spec (replaces the old --spec)."""
    return "spec=@" + str(_spec(tmp_path))


def _mock_run(chain_id: str = "x"):
    return respx.post(f"{WORKFLOW_URL}/chain/run").mock(
        return_value=Response(202, json={"chainId": chain_id, "firing": True})
    )


@respx.mock
def test_chain_run_registers_default_workflows(tmp_path: Path) -> None:
    route = _mock_run("demo")
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "-p", _pspec(tmp_path), "-p", "issueNumber=7"]
    )
    assert result.exit_code == 0, _all_output(result)

    body = json.loads(route.calls[0].request.content)
    assert body["slug"] == "demo"
    assert body["strategy"] == "sequential"
    assert [h["kind"] for h in body["workflows"]] == ["feature-pr", "pr-review", "revise"]
    workflow = {h["kind"]: h for h in body["workflows"]}
    # feature-pr + revise share the branch instance; pr-review has its own; revise re-runs fresh.
    assert workflow["feature-pr"]["instanceId"] == "feature-demo"
    assert workflow["feature-pr"]["fresh"] is False
    assert workflow["revise"]["instanceId"] == "feature-demo"
    assert workflow["revise"]["fresh"] is True
    assert workflow["pr-review"]["instanceId"] == "pr-review-demo"
    # The initial blackboard carries the first workflow's inputs.
    assert body["data"]["slug"] == "demo"
    assert body["data"]["issueNumber"] == "7"
    assert "Do the thing" in body["data"]["spec"]
    assert "chain 'demo' registered" in result.output
    assert "non-blocking" in result.output


@respx.mock
def test_chain_run_single_workflow_hop(tmp_path: Path) -> None:
    route = _mock_run()
    result = runner.invoke(
        app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-w", "feature-pr"]
    )
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert [h["kind"] for h in body["workflows"]] == ["feature-pr"]


@respx.mock
def test_chain_run_fresh_binds_to_its_hop(tmp_path: Path) -> None:
    route = _mock_run()
    args = ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path)]
    runner.invoke(app, [*args, "-w", "feature-pr", "--fresh", "-w", "pr-review"])
    body = json.loads(route.calls[0].request.content)
    assert body["workflows"][0]["fresh"] is True
    assert body["workflows"][1]["fresh"] is False


@respx.mock
def test_chain_run_prefix_budget_is_the_chain_wall_clock(tmp_path: Path) -> None:
    route = _mock_run()
    runner.invoke(
        app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "--budget", "90m"]
    )
    assert json.loads(route.calls[0].request.content)["budgetMs"] == 90 * 60_000


@respx.mock
def test_chain_run_default_budget_scales_with_workflows(tmp_path: Path) -> None:
    route = _mock_run()
    runner.invoke(app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path)])
    assert json.loads(route.calls[0].request.content)["budgetMs"] == 3 * 45 * 60_000


@respx.mock
def test_chain_run_identity_flags_become_hop_params(tmp_path: Path) -> None:
    route = _mock_run()
    respx.get(f"{WORKFLOW_URL}/workflow/get/feature-pr").mock(
        return_value=Response(
            200,
            json={
                "key": "feature-pr",
                "steps": [],
                "params": {"runActivity": "run-claude", "agentId": "claude-agent"},
            },
        )
    )
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--agent", "openhands", "-w", "pr-review",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert body["workflows"][0]["params"] == {
        "runActivity": "run-openhands",
        "agentId": "openhands-agent",
    }
    assert "params" not in body["workflows"][1]


@respx.mock
def test_chain_run_agent_on_slotless_workflow_fails_loud(tmp_path: Path) -> None:
    _mock_run()
    # Published before fire-time identity: no runActivity default → --agent must not silently bake.
    respx.get(f"{WORKFLOW_URL}/workflow/get/feature-pr").mock(
        return_value=Response(200, json={"key": "feature-pr", "steps": []})
    )
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--agent", "openhands",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "republish" in _all_output(result)


@respx.mock
def test_chain_run_agent_on_frozen_executor_warns_and_defaults(tmp_path: Path) -> None:
    route = _mock_run()
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "pr-review", "--agent", "openhands", "-w", "revise",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    assert "frozen" in _all_output(result)  # rich may wrap the warning mid-phrase
    body = json.loads(route.calls[0].request.content)
    assert "params" not in body["workflows"][0]  # the identity flag was dropped, not applied


def test_chain_run_unknown_agent(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--agent", "hal9000",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "unknown --agent" in _all_output(result)


@respx.mock
@needs_helm
def test_chain_run_template_group_composes_on_fire(tmp_path: Path) -> None:
    route = _mock_run()
    save = respx.post(f"{WORKFLOW_URL}/workflow/save").mock(
        return_value=Response(200, json={"key": "x-w0"})
    )
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-t", "feature", "verify", "create-pr", "-w", "pr-review", "-w", "revise",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    # The group published under the chain-scoped key, with its params defaults threaded through.
    saved = json.loads(save.calls[0].request.content)
    assert saved["key"] == "x-w0"
    assert saved["params"]["runActivity"] == "run-claude"
    body = json.loads(route.calls[0].request.content)
    assert body["workflows"][0] == {
        "kind": "feature-pr",
        "key": "x-w0",
        "instanceId": "feature-x",
        "fresh": False,
    }
    # revise re-fires the implement DEFINITION — the derived key, not the published feature-pr.
    assert body["workflows"][2]["kind"] == "revise"
    assert body["workflows"][2]["key"] == "x-w0"
    assert body["workflows"][2]["instanceId"] == "feature-x"


def test_chain_run_template_group_without_contract_needs_kind(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-t", "feature", "verify"],
    )
    assert result.exit_code == 1
    assert "cannot infer the workflow kind" in _all_output(result)


def test_chain_run_parallel_needs_the_phase5_engine(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--parallel", "-w", "pr-review",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "Phase 5" in _all_output(result)


def test_chain_run_bad_expression_surfaces_parse_error(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-w"]
    )
    assert result.exit_code == 1
    assert "-w needs a saved-workflow key" in _all_output(result)


@respx.mock
def test_chain_run_loop_until_clean(tmp_path: Path) -> None:
    route = _mock_run()
    args = ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path)]
    result = runner.invoke(app, [*args, "--strategy", "loop-until-clean", "--max-iterations", "5"])
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert body["strategy"] == "loop-until-clean"
    # the loop body starts at the pr-review workflow (index 1 in feature-pr → pr-review → revise).
    assert body["loop"] == {"startCursor": 1, "maxIterations": 5}


def test_chain_run_loop_needs_a_review_hop(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--strategy", "loop-until-clean",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "pr-review" in _all_output(result)


def test_chain_run_unknown_workflow_needs_kind(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-w", "nope"]
    )
    assert result.exit_code == 1
    assert "not a well-known workflow name" in _all_output(result)


def test_chain_run_non_sequential_strategy(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "--strategy", "parallel"],
    )
    assert result.exit_code == 1
    assert "not implemented" in _all_output(result)


def test_chain_run_requires_slug() -> None:
    result = runner.invoke(app, ["chain", "run"])
    assert result.exit_code == 1
    assert "--slug is required" in (result.output + getattr(result, "stderr", ""))


@respx.mock
def test_chain_run_http_error_exits_1(tmp_path: Path) -> None:
    respx.post(f"{WORKFLOW_URL}/chain/run").mock(return_value=Response(500))
    result = runner.invoke(app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path)])
    assert result.exit_code == 1


@respx.mock
def test_chain_list_renders_registry() -> None:
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(
        return_value=Response(
            200,
            json={
                "heartbeat": {"at": "2026-07-08T09:00:00Z", "enabled": True},
                "chains": [
                    {
                        "chainId": "dark-mode",
                        "status": "running",
                        "cursor": 1,
                        "workflows": [
                            {"kind": "feature-pr"},
                            {"kind": "pr-review"},
                            {"kind": "revise"},
                        ],
                        "outcome": None,
                    }
                ],
            },
        )
    )
    result = runner.invoke(app, ["chain", "list"])
    assert result.exit_code == 0, _all_output(result)
    assert "dark-mode" in result.output
    assert "running" in result.output


@respx.mock
def test_chain_list_http_error_exits_1() -> None:
    respx.get(f"{WORKFLOW_URL}/chain/list").mock(return_value=Response(500))
    result = runner.invoke(app, ["chain", "list"])
    assert result.exit_code == 1
