"""Tests for WorkflowTools (name-routed dispatch + lifecycle). Run:
`uv run --package agent-core pytest`."""

from __future__ import annotations

from typing import Any

from agent_core.workflows import WorkflowTools


class FakeTool:
    def __init__(self, name: str, ret: Any) -> None:
        self.name = name
        self._ret = ret
        self.calls: list[dict] = []

    async def arun(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self._ret


class FakeClient:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


async def test_routes_and_runs_by_name() -> None:
    tool = FakeTool("run_workflow", {"instanceId": "wf-1"})
    wt = WorkflowTools(FakeClient(), [tool])

    assert wt.tools == [tool]
    assert wt.handles("run_workflow")
    assert not wt.handles("not_a_workflow_tool")

    out = await wt.run("run_workflow", {"steps": []})
    assert out == str({"instanceId": "wf-1"})
    assert tool.calls == [{"steps": []}]


async def test_aclose_closes_client() -> None:
    client = FakeClient()
    wt = WorkflowTools(client, [])
    await wt.aclose()
    assert client.closed is True
