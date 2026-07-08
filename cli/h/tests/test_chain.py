"""h chain — registers a chain with the durable chain engine and inspects the registry.

The CLI is now a thin client: `run` POSTs /chain/run (fire-and-forget), `list` reads /chain/list.
The state-threading contract (hop N's output → hop N+1's params) moved into the engine and is tested
there (workflow-svc chain-scan.test.ts); here we pin the request the CLI builds and the list view.
"""

import json
from pathlib import Path

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


def _spec(tmp_path: Path) -> Path:
    p = tmp_path / "demo.md"
    p.write_text("# Demo\nDo the thing.\n")
    return p


@respx.mock
def test_chain_run_registers_default_hops(tmp_path: Path) -> None:
    route = respx.post(f"{WORKFLOW_URL}/chain/run").mock(
        return_value=Response(202, json={"chainId": "demo", "firing": True})
    )
    result = runner.invoke(
        app, ["chain", "run", "--slug", "demo", "--spec", str(_spec(tmp_path)), "--issue", "7"]
    )
    assert result.exit_code == 0, _all_output(result)

    body = json.loads(route.calls[0].request.content)
    assert body["slug"] == "demo"
    assert body["strategy"] == "sequential"
    assert [h["kind"] for h in body["hops"]] == ["feature-pr", "pr-review", "revise"]
    hop = {h["kind"]: h for h in body["hops"]}
    # feature-pr + revise share the branch instance; pr-review has its own; revise re-runs fresh.
    assert hop["feature-pr"]["instanceId"] == "feature-demo"
    assert hop["feature-pr"]["fresh"] is False
    assert hop["revise"]["instanceId"] == "feature-demo"
    assert hop["revise"]["fresh"] is True
    assert hop["pr-review"]["instanceId"] == "pr-review-demo"
    # The initial blackboard carries the first hop's inputs.
    assert body["data"]["slug"] == "demo"
    assert body["data"]["issueNumber"] == "7"
    assert "Do the thing" in body["data"]["spec"]
    assert "chain 'demo' registered" in result.output
    assert "does not block" in result.output


@respx.mock
def test_chain_run_custom_hop_list(tmp_path: Path) -> None:
    route = respx.post(f"{WORKFLOW_URL}/chain/run").mock(
        return_value=Response(202, json={"chainId": "x", "firing": True})
    )
    result = runner.invoke(
        app, ["chain", "run", "-t", "feature-pr", "--slug", "x", "--spec", str(_spec(tmp_path))]
    )
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert [h["kind"] for h in body["hops"]] == ["feature-pr"]


@respx.mock
def test_chain_run_fresh_first_hop(tmp_path: Path) -> None:
    route = respx.post(f"{WORKFLOW_URL}/chain/run").mock(
        return_value=Response(202, json={"chainId": "x", "firing": True})
    )
    args = ["chain", "run", "-t", "feature-pr", "--slug", "x", "--spec", str(_spec(tmp_path))]
    runner.invoke(app, [*args, "--fresh"])
    body = json.loads(route.calls[0].request.content)
    assert body["hops"][0]["fresh"] is True


@respx.mock
def test_chain_run_budget_override(tmp_path: Path) -> None:
    route = respx.post(f"{WORKFLOW_URL}/chain/run").mock(
        return_value=Response(202, json={"chainId": "x", "firing": True})
    )
    runner.invoke(
        app, ["chain", "run", "--slug", "x", "--spec", str(_spec(tmp_path)), "--budget", "90"]
    )
    assert json.loads(route.calls[0].request.content)["budgetMs"] == 90 * 60_000


@respx.mock
def test_chain_run_default_budget_scales_with_hops(tmp_path: Path) -> None:
    route = respx.post(f"{WORKFLOW_URL}/chain/run").mock(
        return_value=Response(202, json={"chainId": "x", "firing": True})
    )
    runner.invoke(app, ["chain", "run", "--slug", "x", "--spec", str(_spec(tmp_path))])
    assert json.loads(route.calls[0].request.content)["budgetMs"] == 3 * 45 * 60_000


def test_chain_run_unknown_hop(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["chain", "run", "-t", "nope", "--slug", "x", "--spec", str(_spec(tmp_path))]
    )
    assert result.exit_code == 1
    assert "unknown hop" in _all_output(result)


def test_chain_run_non_sequential_strategy(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "--spec", str(_spec(tmp_path)), "--strategy", "parallel"],
    )
    assert result.exit_code == 1
    assert "not implemented" in _all_output(result)


def test_chain_run_requires_slug_and_spec() -> None:
    result = runner.invoke(app, ["chain", "run", "--slug", "x"])
    assert result.exit_code == 1


@respx.mock
def test_chain_run_http_error_exits_1(tmp_path: Path) -> None:
    respx.post(f"{WORKFLOW_URL}/chain/run").mock(return_value=Response(500))
    result = runner.invoke(app, ["chain", "run", "--slug", "x", "--spec", str(_spec(tmp_path))])
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
                        "hops": [
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
