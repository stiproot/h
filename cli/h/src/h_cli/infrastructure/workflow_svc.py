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
    cron: dict[str, Any] | None = None,
) -> Any:
    """Fire a saved workflow; fire-time params override the stored defaults key-by-key.
    An instance_id gives the run a readable, stable worktree/workspace key. fresh opts in
    to purging a finished instance under that id and re-running (default: attach). A watch
    policy ({maxDurationMs, retry?}) registers the run with the durable watcher engine; a cron
    policy ({cadence, budget?}) registers a cron:sub row so the run RECURS until its goal
    resolves or the budget is spent (needs repo+slug params for the identity)."""
    body: dict[str, Any] = {}
    if params:
        body["params"] = params
    if instance_id:
        body["instanceId"] = instance_id
    if fresh:
        body["fresh"] = True
    if watch:
        body["watch"] = watch
    if cron:
        body["cron"] = cron
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run/{key}", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def run_steps(
    steps: list[Any],
    params: dict[str, Any] | None = None,
    instance_id: str | None = None,
    fresh: bool = False,
    watch: dict[str, Any] | None = None,
) -> Any:
    """Fire a hydrated definition (raw steps) directly — no saved key, no publish. The inline
    compose-on-fire path: the CLI renders a template and posts its steps + params here, so a
    run leaves only its wf: status row (POST /workflow/run). params resolve {{params.*}} tokens
    in the steps exactly as a saved run does; the merge with the template's value-defaults happens
    caller-side (there is no stored definition to merge against server-side)."""
    body: dict[str, Any] = {"steps": steps}
    if params:
        body["params"] = params
    if instance_id:
        body["instanceId"] = instance_id
    if fresh:
        body["fresh"] = True
    if watch:
        body["watch"] = watch
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def watch_list() -> Any:
    """The watch registry plus the scan heartbeat (the staleness signal, one call)."""
    resp = httpx.get(f"{WORKFLOW_URL}/watch/list", timeout=10)
    resp.raise_for_status()
    return resp.json()


def cron_list() -> Any:
    """The cron registry plus the scan heartbeat (the staleness signal, one call). Includes both the
    recur rows (`crons`) and the discovery/fan-out rows (`discover`)."""
    resp = httpx.get(f"{WORKFLOW_URL}/cron/list", timeout=10)
    resp.raise_for_status()
    return resp.json()


def provision_discover(
    repo: str,
    label: str,
    workflow: str,
    cadence: str,
    max_per_day: int | None = None,
    fire_params: dict[str, Any] | None = None,
    watch: dict[str, Any] | None = None,
) -> Any:
    """Register a discovery/fan-out cron by firing a one-step PROVISION workflow whose register-discover
    activity writes the cron:discover row (docs/plans/workflow-watcher-registry.md §10 — crons via
    activities, not an HTTP handler). The provision run's wf: row audits whether the patrol armed. The
    discovery cron then, each due tick, enumerates open '<label>' issues on <repo> and fires <workflow>
    per newly-discovered issue, deduped against the wf: keys. `watch` (a WatchPolicy) supervises each
    fired run so a hung feature-pr is terminated/retried rather than stalling the serialize."""
    step_input: dict[str, Any] = {
        "repo": repo,
        "label": label,
        "workflow": workflow,
        "cadence": cadence,
    }
    if max_per_day is not None:
        step_input["maxFiresPerDay"] = max_per_day
    if fire_params:
        step_input["fireParams"] = fire_params
    if watch:
        step_input["watch"] = watch
    slug = f"discover-{label}"
    body = {
        "steps": [{"activity": "register-discover", "input": step_input}],
        "instanceId": f"provision-{slug}",
        "wf": {"repo": repo, "slug": slug, "workflow": "provision-discover"},
    }
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run", json=body, timeout=30)
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
    ({chainId, firing}); the engine fires workflow 0 and sequences the rest on the cron tick."""
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
