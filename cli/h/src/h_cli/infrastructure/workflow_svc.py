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


def save(
    key: str,
    steps: list[Any],
    params: dict[str, Any] | None = None,
    schedule: str | None = None,
    workspace_id: str | None = None,
    disabled: bool | None = None,
) -> Any:
    """Persist a (possibly parameterized) workflow definition under a key. A cron schedule
    makes workflow-svc fire it on its own; disabled parks the schedule without deleting it;
    a workspace_id pins every run to one reusable agent workspace."""
    body: dict[str, Any] = {"key": key, "steps": steps}
    if params:
        body["params"] = params
    if schedule:
        body["schedule"] = schedule
    if workspace_id:
        body["workspaceId"] = workspace_id
    if disabled is not None:
        body["disabled"] = disabled
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/save", json=body, timeout=10)
    resp.raise_for_status()
    return resp.json()


def run_saved(
    key: str,
    params: dict[str, Any] | None = None,
    instance_id: str | None = None,
    fresh: bool = False,
    watch: dict[str, Any] | None = None,
) -> Any:
    """Fire a saved workflow; fire-time params override the stored defaults key-by-key.
    An instance_id gives the run a readable, stable worktree/workspace key. fresh opts in
    to purging a finished instance under that id and re-running (default: attach). A watch
    policy ({maxDurationMs, retry?}) registers the run with the durable watcher engine."""
    body: dict[str, Any] = {}
    if params:
        body["params"] = params
    if instance_id:
        body["instanceId"] = instance_id
    if fresh:
        body["fresh"] = True
    if watch:
        body["watch"] = watch
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run/{key}", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def watch_list() -> Any:
    """The watch registry plus the scan heartbeat (the staleness signal, one call)."""
    resp = httpx.get(f"{WORKFLOW_URL}/watch/list", timeout=10)
    resp.raise_for_status()
    return resp.json()


def watch_get(instance_id: str) -> Any:
    resp = httpx.get(f"{WORKFLOW_URL}/watch/{instance_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def watch_delete(instance_id: str) -> Any:
    resp = httpx.delete(f"{WORKFLOW_URL}/watch/{instance_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def chain_run(body: dict[str, Any]) -> Any:
    """Register a chain with the durable chain engine (POST /chain/run). Returns immediately
    ({chainId, firing}); the engine fires hop 0 and sequences the rest on the cron tick."""
    resp = httpx.post(f"{WORKFLOW_URL}/chain/run", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def chain_list() -> Any:
    """The chain registry plus the scan heartbeat (the staleness signal, one call)."""
    resp = httpx.get(f"{WORKFLOW_URL}/chain/list", timeout=10)
    resp.raise_for_status()
    return resp.json()


def terminate(instance_id: str) -> Any:
    """Request termination of a running instance. The body must be `{}`, not empty —
    Fastify 400s an empty body when content-type is application/json."""
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/terminate/{instance_id}", json={}, timeout=30)
    resp.raise_for_status()
    return resp.json()
