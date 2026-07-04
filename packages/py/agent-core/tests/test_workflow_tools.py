"""Tests for WorkflowTools (name-routed dispatch + lifecycle). Run directly: `uv run
--package agent-core python packages/py/agent-core/tests/test_workflow_tools.py`."""

from __future__ import annotations

import asyncio
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


async def _routes_and_runs_by_name() -> None:
    tool = FakeTool("run_workflow", {"instanceId": "wf-1"})
    wt = WorkflowTools(FakeClient(), [tool])

    assert wt.tools == [tool]
    assert wt.handles("run_workflow")
    assert not wt.handles("not_a_workflow_tool")

    out = await wt.run("run_workflow", {"steps": []})
    assert out == str({"instanceId": "wf-1"}), out
    assert tool.calls == [{"steps": []}], tool.calls


async def _aclose_closes_client() -> None:
    client = FakeClient()
    wt = WorkflowTools(client, [])
    await wt.aclose()
    assert client.closed is True


async def main() -> None:
    await _routes_and_runs_by_name()
    await _aclose_closes_client()
    print("agent_core.workflows.WorkflowTools: all tests passed")


if __name__ == "__main__":
    asyncio.run(main())
