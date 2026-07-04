"""Tests for OpenAIChatAdapter — the seam between dapr_agents' OpenAIChatClient and the
provider-agnostic loop. Bypasses __init__ (no real SDK client) to unit-test the parse/append
logic. Run: `uv run --package agent-core python packages/py/agent-core/tests/test_openai_adapter.py`
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from agent_core.llm.openai import OpenAIChatAdapter
from agent_core.react_loop import LLMTurn, ToolCall


class FakeMsg:
    def __init__(self, content: str | None, tool_calls: list) -> None:
        self.content = content
        self._tool_calls = tool_calls

    def get_tool_calls(self) -> list:
        return self._tool_calls


class FakeResponse:
    def __init__(self, msg: FakeMsg) -> None:
        self._msg = msg

    def get_message(self) -> FakeMsg:
        return self._msg


class FakeClient:
    def __init__(self, response: FakeResponse) -> None:
        self._response = response
        self.calls: list[tuple] = []

    def generate(self, messages: list, tools: Any = None) -> FakeResponse:
        self.calls.append((messages, tools))
        return self._response


def _adapter_with(response: FakeResponse) -> tuple[OpenAIChatAdapter, FakeClient]:
    # Bypass __init__ so no real OpenAIChatClient is constructed; inject a fake.
    adapter = object.__new__(OpenAIChatAdapter)
    client = FakeClient(response)
    adapter._client = client
    return adapter, client


def _tool_call(id: str, name: str, args: dict) -> SimpleNamespace:
    return SimpleNamespace(id=id, function=SimpleNamespace(name=name, arguments_dict=args))


async def _parses_final_content() -> None:
    msg = FakeMsg("hello", [])
    adapter, client = _adapter_with(FakeResponse(msg))
    turn = await adapter.generate([{"role": "user", "content": "hi"}], ["tool-schema"])
    assert turn.content == "hello"
    assert turn.tool_calls == []
    assert turn.raw is msg
    # tools are forwarded to the client verbatim
    assert client.calls == [([{"role": "user", "content": "hi"}], ["tool-schema"])]


async def _parses_tool_calls() -> None:
    msg = FakeMsg(None, [_tool_call("id1", "run_workflow", {"steps": []})])
    adapter, _ = _adapter_with(FakeResponse(msg))
    turn = await adapter.generate([], [])
    assert len(turn.tool_calls) == 1
    call = turn.tool_calls[0]
    assert (call.id, call.name, call.arguments) == ("id1", "run_workflow", {"steps": []})
    assert turn.raw is msg


async def _handles_missing_get_tool_calls() -> None:
    # A message object without get_tool_calls() → no tool calls, not an error.
    msg = SimpleNamespace(content="done")
    adapter, _ = _adapter_with(FakeResponse(msg))  # type: ignore[arg-type]
    turn = await adapter.generate([], [])
    assert turn.content == "done"
    assert turn.tool_calls == []


def _append_assistant_appends_raw() -> None:
    adapter, _ = _adapter_with(FakeResponse(FakeMsg(None, [])))
    messages: list = []
    raw = {"role": "assistant", "tool_calls": [{"id": "id1"}]}
    adapter.append_assistant(messages, LLMTurn(raw=raw))
    assert messages == [raw]


def _append_tool_result_shapes_message() -> None:
    adapter, _ = _adapter_with(FakeResponse(FakeMsg(None, [])))
    messages: list = []
    adapter.append_tool_result(messages, ToolCall("id1", "t", {}), "the-result")
    assert messages == [{"role": "tool", "tool_call_id": "id1", "content": "the-result"}]


async def main() -> None:
    await _parses_final_content()
    await _parses_tool_calls()
    await _handles_missing_get_tool_calls()
    _append_assistant_appends_raw()
    _append_tool_result_shapes_message()
    print("agent_core.llm.openai.OpenAIChatAdapter: all tests passed")


if __name__ == "__main__":
    asyncio.run(main())
