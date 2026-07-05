"""Tests for the submit-and-forward workflow route (engine-owned supervision in
workflow-svc — docs/plans/watcher-primitive.md). Run:
`uv run --package agent-server pytest`."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from agent_server import WorkflowBabysitter, WorkflowSubmit, register_workflow_route

DEFAULT_MAX_MS = 45 * 60_000


class FakeBabysitter(WorkflowBabysitter):
    """Records sidecar calls instead of making them."""

    def __init__(
        self,
        post_reply: dict | None = None,
        get_reply: Any = None,
        post_error: Exception | None = None,
        get_error: Exception | None = None,
    ) -> None:
        super().__init__(agent_id="test-agent", dapr_http_port="3500")
        self.post_reply = post_reply or {"instanceId": "wf-1", "watching": True}
        self.get_reply = get_reply
        self.post_error = post_error
        self.get_error = get_error
        self.posts: list[tuple[str, dict]] = []
        self.gets: list[str] = []

    def _post(self, url: str, body: dict) -> dict:
        if self.post_error:
            raise self.post_error
        self.posts.append((url, body))
        return self.post_reply

    def _get(self, url: str) -> Any:
        if self.get_error:
            raise self.get_error
        self.gets.append(url)
        return self.get_reply


def make_client(babysitter: WorkflowBabysitter) -> TestClient:
    app = FastAPI()
    router = APIRouter()
    register_workflow_route(router, babysitter)
    app.include_router(router)
    return TestClient(app)


# -- submit: policy → watch translation ----------------------------------------------------


async def test_policy_max_duration_translates_to_watch_field() -> None:
    b = FakeBabysitter()
    result = await b.submit(WorkflowSubmit(key="my-family", policy={"maxDurationMs": 120_000}))

    url, body = b.posts[0]
    assert url.endswith("/v1.0/invoke/workflow-svc/method/workflow/run/my-family")
    assert body["watch"] == {"maxDurationMs": 120_000}
    assert result == {"instanceId": "wf-1", "watching": True}


async def test_no_policy_defaults_watch_to_45_minutes() -> None:
    b = FakeBabysitter()
    await b.submit(WorkflowSubmit(steps=[{"id": "a"}]))

    url, body = b.posts[0]
    assert url.endswith("/v1.0/invoke/workflow-svc/method/workflow/run")
    assert body["steps"] == [{"id": "a"}]
    assert body["watch"] == {"maxDurationMs": DEFAULT_MAX_MS}


async def test_explicit_watch_is_forwarded_verbatim_and_wins_over_policy() -> None:
    watch = {
        "maxDurationMs": 10_000,
        "unknownStreakLimit": 3,
        "retry": {"maxAttempts": 2, "fresh": True, "onOutcome": ["failed"]},
        "escalate": {"onOutcome": ["budget-terminated"], "key": "escalate-fam"},
    }
    b = FakeBabysitter()
    await b.submit(
        WorkflowSubmit(
            key="k",
            policy={"maxDurationMs": 999_999},
            watch=watch,
            watchMeta={"origin": "test"},
        )
    )

    _, body = b.posts[0]
    assert body["watch"] == watch  # verbatim — policy did not leak in
    assert body["watchMeta"] == {"origin": "test"}


async def test_watch_meta_omitted_when_absent() -> None:
    b = FakeBabysitter()
    await b.submit(WorkflowSubmit(key="k"))
    _, body = b.posts[0]
    assert "watchMeta" not in body


async def test_submit_forwards_run_fields_and_svc_watching_flag() -> None:
    b = FakeBabysitter(post_reply={"instanceId": "wf-2", "watching": False})
    result = await b.submit(
        WorkflowSubmit(
            key="k",
            params={"x": 1},
            instanceId="my-id",
            workspaceId="ws",
            fresh=True,
        )
    )

    _, body = b.posts[0]
    assert body["params"] == {"x": 1}
    assert body["instanceId"] == "my-id"
    assert body["workspaceId"] == "ws"
    assert body["fresh"] is True
    assert result == {"instanceId": "wf-2", "watching": False}


# -- POST /workflow contract ---------------------------------------------------------------


def test_route_202_with_instance_and_watching() -> None:
    client = make_client(FakeBabysitter())
    resp = client.post("/workflow", json={"key": "k"})
    assert resp.status_code == 202
    assert resp.json() == {"instanceId": "wf-1", "watching": True}


def test_route_400_without_key_or_steps() -> None:
    client = make_client(FakeBabysitter())
    assert client.post("/workflow", json={}).status_code == 400


def test_route_502_when_scheduling_fails() -> None:
    client = make_client(FakeBabysitter(post_error=RuntimeError("sidecar down")))
    resp = client.post("/workflow", json={"key": "k"})
    assert resp.status_code == 502
    assert "sidecar down" in resp.json()["detail"]


# -- GET /workflow/watches: proxy of workflow-svc's durable watch list ----------------------


def test_watches_proxies_watch_list_body_as_is() -> None:
    svc_body = {
        "heartbeat": {"at": "2026-07-05T00:00:00Z", "enabled": True},
        "watches": [{"instanceId": "wf-1", "outcome": None}],
    }
    b = FakeBabysitter(get_reply=svc_body)
    client = make_client(b)

    resp = client.get("/workflow/watches")
    assert resp.status_code == 200
    assert resp.json() == svc_body
    assert b.gets == ["http://localhost:3500/v1.0/invoke/workflow-svc/method/watch/list"]


def test_watches_502_when_workflow_svc_unreachable() -> None:
    client = make_client(FakeBabysitter(get_error=OSError("connection refused")))
    resp = client.get("/workflow/watches")
    assert resp.status_code == 502
    assert "connection refused" in resp.json()["detail"]
