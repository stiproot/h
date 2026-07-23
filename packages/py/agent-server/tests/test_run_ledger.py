from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_server import run_ledger
from agent_server.models import AgentRequest, AgentResponse


def request(*, instance: str | None = None, workspace: str | None = None) -> AgentRequest:
    return AgentRequest(input="do work", workflow_instance_id=instance, workspace_id=workspace)


def response() -> AgentResponse:
    return AgentResponse(
        output="finished",
        session_id="session-1",
        model="model-1",
        turns=3,
        cost_usd=1.25,
        tool_calls=4,
    )


@pytest.mark.parametrize(
    ("instance", "workspace_id", "group"),
    [("wf-1", "ws-1", "wf-1"), (None, "ws-1", "ws-1"), (None, None, "adhoc")],
)
def test_group_fallback_run_id_and_watcher_mirror_prefix(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    instance: str | None,
    workspace_id: str | None,
    group: str,
) -> None:
    posts: list[tuple[str, object]] = []
    monkeypatch.setattr(run_ledger.time, "time", lambda: 1.234)
    monkeypatch.setattr(run_ledger, "_post_json", lambda url, body: posts.append((url, body)))
    monkeypatch.setattr(run_ledger, "_get_json", lambda _url: [])

    run_id = run_ledger.record_run(
        agent_id="agent",
        request=request(instance=instance, workspace=workspace_id),
        response=response(),
        workspace=tmp_path / "base" / "workspaces" / "key",
        status="completed",
        runs_dir=str(tmp_path / "runs"),
        dapr_http_port="3500",
    )

    assert run_id == f"{group}:agent:1234"
    mirror = posts[0][1]
    assert mirror[0]["key"] == f"run:{run_id}"  # type: ignore[index]
    if instance:
        assert mirror[0]["key"].startswith(f"run:{instance}:")  # type: ignore[index]


def test_runs_dir_explicit_and_sibling_resolution(tmp_path: Path) -> None:
    workspace = tmp_path / "agent-base" / "workspaces" / "key"
    assert run_ledger._runs_dir("/explicit/runs", workspace) == Path("/explicit/runs")
    assert run_ledger._runs_dir(None, workspace) == tmp_path / ".runs"


def test_cli_compatible_artifact_shape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run_ledger.time, "time", lambda: 2.0)
    runs = tmp_path / "runs"
    run_id = run_ledger.record_run(
        agent_id="agent",
        request=request(instance="wf-2"),
        response=response(),
        workspace=tmp_path / "workspace",
        status="completed",
        runs_dir=str(runs),
    )
    run_dir = runs / "wf-2" / "agent-2000"
    summary = json.loads((run_dir / "summary.json").read_text())
    assert {k: summary[k] for k in ("runId", "agentId", "workflowInstanceId")} == {
        "runId": run_id,
        "agentId": "agent",
        "workflowInstanceId": "wf-2",
    }
    assert summary["costUsd"] == 1.25
    assert summary["toolCalls"] == 4
    assert (run_dir / "output.txt").read_text() == "finished"
    assert json.loads((run_dir / "events.jsonl").read_text()) == {
        "type": "result",
        "status": "completed",
        "turns": 3,
    }


def test_fs_failure_is_swallowed_and_mirror_still_fires(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    posts: list[object] = []
    monkeypatch.setattr(Path, "mkdir", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError()))
    monkeypatch.setattr(run_ledger, "_post_json", lambda _url, body: posts.append(body))
    monkeypatch.setattr(run_ledger, "_get_json", lambda _url: [])
    run_ledger.record_run(
        agent_id="agent",
        request=request(instance="wf-3"),
        response=response(),
        workspace=tmp_path / "workspace",
        status="completed",
        runs_dir=str(tmp_path / "runs"),
        dapr_http_port="3500",
    )
    record = posts[0][0]["value"]  # type: ignore[index]
    assert record["dir"]
    assert record["outputPreview"] == "finished"


def test_mirror_skipped_without_dapr_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DAPR_HTTP_PORT", raising=False)
    monkeypatch.setattr(
        run_ledger, "_post_json", lambda *_args: pytest.fail("mirror should be skipped")
    )
    run_ledger._mirror_to_statestore(None, "run-id", {})


def test_runs_index_append_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    key = "run:wf:agent:1"
    posts: list[object] = []
    monkeypatch.setattr(run_ledger, "_post_json", lambda _url, body: posts.append(body))
    monkeypatch.setattr(run_ledger, "_get_json", lambda _url: [key])
    run_ledger._mirror_to_statestore("3500", "wf:agent:1", {})
    assert len(posts) == 1
    assert posts[0][0]["key"] == key  # type: ignore[index]
