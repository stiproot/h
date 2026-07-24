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
    runner.invoke(app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "--budget", "90m"])
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
def test_chain_run_pi_identity_flags_become_hop_params(tmp_path: Path) -> None:
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
            "-w", "feature-pr", "--agent", "pi", "-w", "pr-review",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert body["workflows"][0]["params"] == {
        "runActivity": "run-pi",
        "agentId": "pi-agent",
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
    # revise is its own first-class workflow — it fires the published `revise` key (NOT the composed
    # feature-pr definition), sharing the branch instance so it operates on the same feature/<slug>.
    assert body["workflows"][2]["kind"] == "revise"
    assert body["workflows"][2]["key"] == "revise"
    assert body["workflows"][2]["instanceId"] == "feature-x"


@respx.mock
@needs_helm
def test_chain_run_inline_embeds_steps_without_publishing(tmp_path: Path) -> None:
    route = _mock_run()
    # No /workflow/save mock: if the inline member tried to publish, the un-mocked call would fail
    # the run (exit 1). Exit 0 proves it embedded instead.
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-t", "feature", "verify", "create-pr", "--inline", "-w", "pr-review",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    member = json.loads(route.calls[0].request.content)["workflows"][0]
    assert "steps" in member and "key" not in member  # embedded, not published
    assert "embedded inline" in result.output


@respx.mock
@needs_helm
def test_chain_run_cron_member_arms_an_embedded_recurrence(tmp_path: Path) -> None:
    route = _mock_run()
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-p", "repo=o/r",
            "-t", "feature", "create-pr", "--cron", "*/30 * * * *", "--max-fires", "20",
            "--id", "gather",
            "-w", "pr-review",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    member = json.loads(route.calls[0].request.content)["workflows"][0]
    # --cron forces inline (embedded steps), arms {cadence, maxFires}, and takes the explicit id.
    assert "steps" in member and "key" not in member
    assert member["cron"] == {"cadence": "*/30 * * * *", "maxFires": 20}
    assert member["id"] == "gather"


@needs_helm
def test_chain_run_cron_member_needs_a_repo(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-t", "feature", "create-pr", "--cron", "* * * * *",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "needs a repo" in _all_output(result)


def test_chain_run_template_group_without_contract_needs_kind(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-t", "feature", "verify"],
    )
    assert result.exit_code == 1
    assert "cannot infer the workflow kind" in _all_output(result)


@respx.mock
def test_chain_run_parallel_emits_a_shared_stage(tmp_path: Path) -> None:
    route = _mock_run()
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--parallel", "-w", "pr-review",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    a, b = body["workflows"]
    # Both members share stage 0 — one concurrent stage the engine joins before finalizing.
    assert a["stage"] == 0 and b["stage"] == 0
    # Parallel members get a unique engine-derived instance (no shared branch instanceId) + a
    # blackboard namespace, so concurrent captures never collide.
    assert "instanceId" not in a and "instanceId" not in b
    assert a["id"] == "feature-pr" and b["id"] == "pr-review"


@respx.mock
def test_chain_run_explicit_stage_marks_members_parallel(tmp_path: Path) -> None:
    route = _mock_run()
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--stage", "0", "-w", "pr-review", "--stage", "0",
            "-w", "revise", "--stage", "1",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    workflows = json.loads(route.calls[0].request.content)["workflows"]
    assert [w["stage"] for w in workflows] == [0, 0, 1]
    # --stage 0 on two members (no --parallel) still marks them parallel — computed from the FINAL
    # stage, so they share a stage and drop their shared branch instance.
    assert "instanceId" not in workflows[0] and "instanceId" not in workflows[1]
    # revise is alone in stage 1 → keeps its branch instance.
    assert workflows[2]["instanceId"] == "feature-x"


@respx.mock
def test_chain_run_dotted_input_flows_through(tmp_path: Path) -> None:
    route = _mock_run()
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "-w", "pr-review", "--input", "pr=feature-pr.prNumber",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    # A dotted `id.field` input passes through verbatim; the engine resolves it as a path (D5).
    assert body["workflows"][1]["inputs"] == {"pr": "feature-pr.prNumber"}


def test_chain_run_max_fires_needs_cron(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--max-fires", "5",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "--max-fires" in _all_output(result) and "--cron" in _all_output(result)


def test_chain_run_cron_on_saved_key_is_rejected(tmp_path: Path) -> None:
    # A cron member self-arms an EMBEDDED recurrence — it must be composed with -t, not a saved key.
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--cron", "* * * * *",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "must be composed with -t" in _all_output(result)


def test_chain_run_bad_expression_surfaces_parse_error(tmp_path: Path) -> None:
    result = runner.invoke(app, ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path), "-w"])
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


PR_OUTPUTS = {
    "type": "object",
    "required": ["pr"],
    "properties": {"pr": {"type": "integer"}, "url": {"type": "string"}},
}


def _mock_get(key: str, outputs: dict | None = None):
    stored: dict = {"key": key, "steps": [], "params": {}}
    if outputs is not None:
        stored["outputs"] = outputs
    return respx.get(f"{WORKFLOW_URL}/workflow/get/{key}").mock(
        return_value=Response(200, json=stored)
    )


@respx.mock
def test_chain_run_mapping_flags_land_on_the_member(tmp_path: Path) -> None:
    route = _mock_run()
    _mock_get("feature-pr", outputs=PR_OUTPUTS)
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--capture", "prNumber=pr", "--capture", "prUrl=url",
            "-w", "pr-review", "--input", "pr=prNumber",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    feature, review = body["workflows"]
    assert feature["captures"] == {"prNumber": "pr", "prUrl": "url"}
    assert "inputs" not in feature
    assert review["inputs"] == {"pr": "prNumber"}


@respx.mock
def test_chain_run_until_shapes_the_predicate(tmp_path: Path) -> None:
    route = _mock_run()
    _mock_get("pr-review", outputs={"type": "object", "properties": {"verdict": {}}})
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "-w", "pr-review", "--until", "verdict=CLEAN",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    assert body["workflows"][1]["until"] == {"path": "verdict", "equals": "CLEAN"}


@respx.mock
def test_chain_run_capture_without_declared_outputs_fails_at_registration(
    tmp_path: Path,
) -> None:
    _mock_run()
    _mock_get("feature-pr")  # no outputs declaration on the saved workflow
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--capture", "prNumber=pr",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "declares no outputs schema" in _all_output(result)


@respx.mock
def test_chain_run_capture_of_undeclared_field_fails_at_registration(tmp_path: Path) -> None:
    _mock_run()
    _mock_get("feature-pr", outputs=PR_OUTPUTS)
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "feature-pr", "--capture", "prNumber=prNum",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "no field(s) prNum" in _all_output(result)


@respx.mock
def test_chain_run_agent_panel_is_a_first_class_kind(tmp_path: Path) -> None:
    """`-w agent-panel` resolves its kind with no --kind (it's WELL_KNOWN): the multi-agent panel
    is a chain member. A lone sequential panel keeps its own `panel-<slug>` instance and re-runs
    fresh (each chain gets a fresh design)."""
    route = _mock_run()
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "-p", "task=design the codex integration", "-w", "agent-panel"],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    panel = json.loads(route.calls[0].request.content)["workflows"][0]
    assert panel["kind"] == "agent-panel"
    assert panel["key"] == "agent-panel"
    assert panel["instanceId"] == "panel-x"
    assert panel["fresh"] is True


@respx.mock
def test_chain_run_agent_panel_parallel_member_namespaces_its_captures(tmp_path: Path) -> None:
    """The panel's in-process parallel step runs concurrently with another workflow in a stage: a
    `--parallel` panel drops its shared branch instance, gets a blackboard namespace, and its
    --capture fields validate against agent-panel's declared outputs schema (consensus/best)."""
    route = _mock_run()
    respx.get(f"{WORKFLOW_URL}/workflow/get/agent-panel").mock(
        return_value=Response(
            200,
            json={
                "key": "agent-panel",
                "steps": [],
                "outputs": {
                    "type": "object",
                    "properties": {
                        "consensus": {"type": "string"},
                        "best": {"type": "string"},
                        "disagreements": {"type": "string"},
                    },
                },
            },
        )
    )
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "agent-panel", "--id", "design", "--input", "task=task",
            "--capture", "consensus=consensus", "--capture", "best=best",
            "--parallel", "-w", "feature-pr",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, _all_output(result)
    panel = json.loads(route.calls[0].request.content)["workflows"][0]
    assert panel["kind"] == "agent-panel"
    assert panel["stage"] == 0
    assert "instanceId" not in panel  # parallel → engine-derived instance, no branch collision
    assert panel["id"] == "design"
    assert panel["captures"] == {"consensus": "consensus", "best": "best"}
    assert panel["inputs"] == {"task": "task"}


@respx.mock
def test_chain_run_agent_panel_bad_capture_field_fails_loud(tmp_path: Path) -> None:
    """A --capture field that isn't in agent-panel's declared outputs schema fails at registration."""
    _mock_run()
    respx.get(f"{WORKFLOW_URL}/workflow/get/agent-panel").mock(
        return_value=Response(
            200,
            json={
                "key": "agent-panel",
                "steps": [],
                "outputs": {"type": "object", "properties": {"consensus": {"type": "string"}}},
            },
        )
    )
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
            "-w", "agent-panel", "--capture", "nope=notafield",
        ],
    )  # fmt: skip
    assert result.exit_code == 1
    assert "no field(s) notafield" in _all_output(result)


# --- the --agent roster (docs/plans/panels-as-a-modifier.md) ---------------------------------


@needs_helm
@respx.mock
def test_chain_roster_member_panelizes_inline(tmp_path: Path) -> None:
    """`-w pr-review --agent A B C --inline` renders the template, panelizes it (branches +
    judge synthesis under the pr-review contract), and embeds the steps in the chain row."""
    route = _mock_run("panel-x")
    result = runner.invoke(
        app,
        [
            "chain", "run", "--slug", "panel-x", "-p", _pspec(tmp_path), "-p", "repo=o/r",
            "-w", "pr-review", "--agent", "claude", "codex", "openhands", "--inline",
        ],
    )
    assert result.exit_code == 0, _all_output(result)
    body = json.loads(route.calls[0].request.content)
    member = body["workflows"][0]
    assert member["kind"] == "pr-review"
    assert "key" not in member
    panel = next(step for step in member["steps"] if "parallel" in step)
    assert [b["activity"] for b in panel["parallel"]] == [
        "run-claude", "run-codex", "run-openhands",
    ]
    synthesis = member["steps"][member["steps"].index(panel) + 1]
    assert synthesis["id"] == "review"
    assert synthesis["input"]["outputContract"]
    # Roster identity is baked per branch — never a runActivity param.
    assert "runActivity" not in (member.get("params") or {})


def test_chain_roster_rejects_write_kinds(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
         "-w", "feature-pr", "--agent", "claude", "codex"],
    )
    assert result.exit_code == 1
    assert "roster" in _all_output(result)


def test_chain_roster_rejects_model(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "-p", _pspec(tmp_path),
         "-w", "pr-review", "--agent", "claude", "codex", "--model", "opus"],
    )
    assert result.exit_code == 1
    assert "--model with a roster" in _all_output(result)
