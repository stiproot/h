"""Statestore seeding against a respx-mocked Dapr state API — verifies the read-modify-write
contract (task record shape, index append, idempotency) without live services."""

import json
from typing import Any

import httpx
import pytest
import respx

from h_cli.infrastructure import statestore


@pytest.fixture
def state_api(respx_mock: respx.MockRouter) -> dict[str, Any]:
    """Mock the two state endpoints; capture every POST body in order."""
    captured: dict[str, Any] = {"posts": [], "index": None}

    def record(request: httpx.Request) -> httpx.Response:
        captured["posts"].append(json.loads(request.content))
        return httpx.Response(204)

    respx_mock.post(statestore.STATE_URL).mock(side_effect=record)
    captured["route"] = respx_mock.get(f"{statestore.STATE_URL}/tasks:index")
    return captured


def test_seed_task_writes_pending_record(state_api: dict[str, Any]) -> None:
    state_api["route"].mock(return_value=httpx.Response(204))
    statestore.seed_task("t1", "do the thing")
    [entry] = state_api["posts"][0]
    assert entry["key"] == "task:t1"
    assert entry["value"] == {
        "id": "t1",
        "status": "pending",
        "problem": "do the thing",
        "issueId": None,
        "result": None,
        "pluginFeedback": None,
    }


def test_seed_task_appends_to_existing_index(state_api: dict[str, Any]) -> None:
    state_api["route"].mock(return_value=httpx.Response(200, json=["older-task"]))
    statestore.seed_task("t2", "p")
    [index_entry] = state_api["posts"][1]
    assert index_entry == {"key": "tasks:index", "value": ["older-task", "t2"]}


def test_seed_task_initializes_missing_index(state_api: dict[str, Any]) -> None:
    """Dapr returns an empty body for an absent key — the index must start fresh, not crash."""
    state_api["route"].mock(return_value=httpx.Response(204))
    statestore.seed_task("t3", "p")
    [index_entry] = state_api["posts"][1]
    assert index_entry == {"key": "tasks:index", "value": ["t3"]}


def test_seed_task_index_append_is_idempotent(state_api: dict[str, Any]) -> None:
    state_api["route"].mock(return_value=httpx.Response(200, json=["t4", "other"]))
    statestore.seed_task("t4", "p")
    [index_entry] = state_api["posts"][1]
    assert index_entry["value"] == ["t4", "other"]


def test_seed_task_raises_on_write_failure(respx_mock: respx.MockRouter) -> None:
    respx_mock.post(statestore.STATE_URL).mock(return_value=httpx.Response(500))
    with pytest.raises(httpx.HTTPStatusError):
        statestore.seed_task("t5", "p")
