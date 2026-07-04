"""Client for workflow-svc's HTTP surface (saved workflows, runs, instance status)."""

from typing import Any

import httpx

from h_cli.config import WORKFLOW_URL


def list_keys() -> list[str]:
    resp = httpx.get(f"{WORKFLOW_URL}/workflow/list", timeout=10)
    resp.raise_for_status()
    return resp.json()["keys"]


def get(key: str) -> Any:
    resp = httpx.get(f"{WORKFLOW_URL}/workflow/get/{key}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def status(instance_id: str) -> Any:
    resp = httpx.get(f"{WORKFLOW_URL}/workflow/status/{instance_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def save(key: str, steps: list[Any], params: dict[str, Any] | None = None) -> Any:
    """Persist a (possibly parameterized) workflow definition under a key."""
    body: dict[str, Any] = {"key": key, "steps": steps}
    if params:
        body["params"] = params
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/save", json=body, timeout=10)
    resp.raise_for_status()
    return resp.json()


def run_saved(
    key: str, params: dict[str, Any] | None = None, instance_id: str | None = None
) -> Any:
    """Fire a saved workflow; fire-time params override the stored defaults key-by-key.
    An instance_id gives the run a readable, stable worktree/workspace key."""
    body: dict[str, Any] = {}
    if params:
        body["params"] = params
    if instance_id:
        body["instanceId"] = instance_id
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run/{key}", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def terminate(instance_id: str) -> Any:
    """Request termination of a running instance. The body must be `{}`, not empty —
    Fastify 400s an empty body when content-type is application/json."""
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/terminate/{instance_id}", json={}, timeout=30)
    resp.raise_for_status()
    return resp.json()
