from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from agent_server.routes import SETUP_SENTINEL, register_setup_route


def make_client(tmp_path: Path) -> TestClient:
    app = FastAPI()
    router = APIRouter()
    register_setup_route(router, lambda key: tmp_path / key)
    app.include_router(router)
    return TestClient(app)


def test_identical_spec_skips_second_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **_kwargs: calls.append(cmd) or SimpleNamespace(returncode=0, stderr=""),
    )
    client = make_client(tmp_path)
    body = {"workflowInstanceId": "wf", "setup": [{"cmd": "one"}]}
    assert client.post("/setup", json=body).json()["skipped"] is False
    assert client.post("/setup", json=body).json()["skipped"] is True
    assert calls == ["one"]


def test_changed_spec_reruns_and_rewrites_sentinel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **_kwargs: calls.append(cmd) or SimpleNamespace(returncode=0, stderr=""),
    )
    client = make_client(tmp_path)
    client.post("/setup", json={"workflowInstanceId": "wf", "setup": [{"cmd": "one"}]})
    changed = [{"cmd": "two", "validateCmd": None}]
    client.post("/setup", json={"workflowInstanceId": "wf", "setup": changed})
    expected = hashlib.sha256(json.dumps(changed, sort_keys=True).encode()).hexdigest()
    assert calls == ["one", "two"]
    assert (tmp_path / "wf" / SETUP_SENTINEL).read_text() == expected


def test_failed_step_leaves_no_sentinel_and_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    def fail(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return SimpleNamespace(returncode=1, stderr="boom")

    monkeypatch.setattr(subprocess, "run", fail)
    client = make_client(tmp_path)
    body = {"workflowInstanceId": "wf", "setup": [{"cmd": "bad"}]}
    assert client.post("/setup", json=body).status_code == 500
    assert client.post("/setup", json=body).status_code == 500
    assert calls == 2
    assert not (tmp_path / "wf" / SETUP_SENTINEL).exists()


def test_python_hash_is_key_order_insensitive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unlike agent-routes.test.ts, Python deliberately hashes sorted JSON object keys.

    The JS sibling intentionally pins insertion-order JSON.stringify hashing; keep both
    cross-references loud if the implementations are ever aligned.
    """
    calls: list[str] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **_kwargs: calls.append(cmd) or SimpleNamespace(returncode=0, stderr=""),
    )
    client = make_client(tmp_path)
    first = '{"workflowInstanceId":"wf","setup":[{"cmd":"one","validateCmd":"check"}]}'
    reordered = '{"setup":[{"validateCmd":"check","cmd":"one"}],"workflowInstanceId":"wf"}'
    headers = {"content-type": "application/json"}
    assert client.post("/setup", content=first, headers=headers).is_success
    assert client.post("/setup", content=reordered, headers=headers).json()["skipped"] is True
    assert calls == ["one", "check"]
