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
    outputs: dict[str, Any] | None = None,
) -> Any:
    """Persist a (possibly parameterized) workflow definition under a key. A cron schedule
    makes workflow-svc fire it on its own; disabled parks the schedule without deleting it;
    a workspace_id pins every run to one reusable agent workspace; outputs is the declared
    output schema — the workflow's typed output signature (structured-workflow-outputs plan)."""
    body: dict[str, Any] = {"key": key, "steps": steps}
    if params:
        body["params"] = params
    if schedule:
        body["schedule"] = schedule
    if workspace_id:
        body["workspaceId"] = workspace_id
    if disabled is not None:
        body["disabled"] = disabled
    if outputs:
        body["outputs"] = outputs
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
    at: str | None = None,
    in_: str | None = None,
) -> Any:
    """Fire a saved workflow; fire-time params override the stored defaults key-by-key.
    An instance_id gives the run a readable, stable worktree/workspace key. fresh opts in
    to purging a finished instance under that id and re-running (default: attach). A watch
    policy ({maxDurationMs, retry?}) registers the run with the durable watcher engine; a cron
    policy ({cadence, budget?}) registers a cron:sub row so the run RECURS until its goal
    resolves or the budget is spent (needs repo+slug params for the identity).

    `at` (absolute ISO) / `in_` (relative duration, e.g. "2h") instead ARM a one-shot cron:sched
    row — the workflow fires ONCE at that time rather than now — and the response is
    {scheduled, fireAt}. Mutually exclusive with cron (a schedule fires once, a cron recurs)."""
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
    if at:
        body["at"] = at
    if in_:
        body["in"] = in_
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run/{key}", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def run_steps(
    steps: list[Any],
    params: dict[str, Any] | None = None,
    instance_id: str | None = None,
    fresh: bool = False,
    watch: dict[str, Any] | None = None,
    arm_cron: dict[str, Any] | None = None,
    wf: dict[str, Any] | None = None,
) -> Any:
    """Fire a hydrated definition (raw steps) directly — no saved key, no publish. The inline
    compose-on-fire path: the CLI renders a template and posts its steps + params here, so a
    run leaves only its wf: status row (POST /workflow/run). params resolve {{params.*}} tokens
    in the steps exactly as a saved run does; the merge with the template's value-defaults happens
    caller-side (there is no stored definition to merge against server-side).

    `arm_cron` ({cadence, workflow, budget?, inline:true}) makes the run register its OWN recurrence
    over an EMBEDDED source built from these very steps — the inline sibling of `run_saved`'s cron,
    for a definition that was never published
    (docs/plans/impl/inline-chain-cron-composition.md D1). It
    needs `wf` ({repo, slug, workflow}) so the recurring runs write the goal-handshake status row
    the cron engine reads to stop."""
    body: dict[str, Any] = {"steps": steps}
    if params:
        body["params"] = params
    if instance_id:
        body["instanceId"] = instance_id
    if fresh:
        body["fresh"] = True
    if watch:
        body["watch"] = watch
    if wf:
        body["wf"] = wf
    if arm_cron:
        body["armCron"] = arm_cron
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/run", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def cron_disarm(repo: str, slug: str, workflow: str) -> Any:
    """Deactivate a recur cron row (set inactive/disabled; keep for audit). Idempotent when already
    inactive. Raises httpx.HTTPStatusError on 404 (unknown id) or 500 (concurrent modification)."""
    resp = httpx.post(
        f"{WORKFLOW_URL}/cron/disarm",
        json={"repo": repo, "slug": slug, "workflow": workflow},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def pause(
    instance_id: str,
    key: str,
    params: dict[str, Any] | None = None,
    at: str | None = None,
    in_: str | None = None,
    workspace_id: str | None = None,
) -> Any:
    """Pause a running workflow (stop-and-continue): terminate the instance NOW and arm a
    cron:sched row that re-fires the saved `key` after the delay, reusing the paused run's
    workspace. `at` (absolute ISO) or `in_` (duration) — exactly one. Returns {paused, scheduled,
    fireAt}."""
    body: dict[str, Any] = {"key": key}
    if params:
        body["params"] = params
    if at:
        body["at"] = at
    if in_:
        body["in"] = in_
    if workspace_id:
        body["workspaceId"] = workspace_id
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/pause/{instance_id}", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def resume(sched_id: str) -> Any:
    """Resume a paused workflow NOW (before its scheduled time): advance the cron:sched row so the
    next tick fires the continuation. Returns {resumed, status, fireAt}."""
    resp = httpx.post(f"{WORKFLOW_URL}/workflow/resume/{sched_id}", timeout=30)
    resp.raise_for_status()
    return resp.json()


def sched_disarm(sched_id: str) -> Any:
    """Disarm a one-shot scheduled-fire row by id (set disarmed; keep for audit). Idempotent when
    already terminal. Raises httpx.HTTPStatusError on 404 (unknown id)."""
    resp = httpx.post(
        f"{WORKFLOW_URL}/cron/sched/disarm",
        json={"id": sched_id},
        timeout=10,
    )
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


def exec_policy_get() -> Any:
    """The executor policy row (`exec:config`) — absent reads as {denied: [], updatedAt: ""}."""
    resp = httpx.get(f"{WORKFLOW_URL}/exec/policy", timeout=10)
    resp.raise_for_status()
    return resp.json()


def exec_policy_set(denied: list[str]) -> Any:
    """Replace the denied-executor set (workflow-svc is the exec: registry's single writer)."""
    resp = httpx.post(f"{WORKFLOW_URL}/exec/policy", json={"denied": denied}, timeout=10)
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
    """Register a discovery/fan-out cron by firing a one-step PROVISION workflow whose
    register-discover activity writes the cron:discover row (workflow-watcher-registry §10 — crons
    via activities, not an HTTP handler). The provision run's wf: row audits whether the patrol
    armed. The discovery cron then, each due tick, enumerates open '<label>' issues on <repo> and
    fires <workflow> per newly-discovered issue, deduped against the wf: keys. `watch` (a
    WatchPolicy) supervises each
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


def open_prs() -> list[dict[str, Any]]:
    """Fetch open PRs from the h repository via GitHub API. Returns a list of PR objects with
    number, title, and author fields. Read-only; network failures raise httpx.HTTPError.
    Supports unauthenticated access (lower rate limit) when GH_TOKEN is absent."""
    import os
    gh_token = os.environ.get("GH_TOKEN", "")
    headers = {}
    if gh_token:
        headers["Authorization"] = f"token {gh_token}"
    resp = httpx.get(
        "https://api.github.com/repos/stiproot/h/pulls?state=open&per_page=50",
        headers=headers,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        return []
    return [
        {
            "number": pr.get("number", 0),
            "title": pr.get("title", ""),
            "author": pr.get("user", {}).get("login", "unknown"),
        }
        for pr in data
    ]
