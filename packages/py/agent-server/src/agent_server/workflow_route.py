"""The standard POST /workflow route — Python sibling of js/agent-server's
workflow-route.ts. Submit-and-forward, not submit-and-supervise.

Supervision is durable and engine-owned in workflow-svc:
its run routes accept a `watch` field, write a durable `watch:sub:<instanceId>` statestore
row in the same handler that schedules, and a cron-tick scan enforces the budget, retries,
publishes terminal `workflow-events`, and tallies cost. This route only translates the
caller's `policy.maxDurationMs` (default 45 min) into that `watch` field — an explicit
`watch` in the submit body is forwarded verbatim and wins — POSTs to workflow-svc via the
Dapr sidecar, and returns `{instanceId, watching}` from workflow-svc's reply.
GET /workflow/watches proxies workflow-svc's GET /watch/list (global durable truth).

Dependency-free like run_ledger (stdlib urllib, run in a thread from the event loop).
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.parse
import urllib.request
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class BabysitPolicy(BaseModel):
    maxDurationMs: int | None = None


class WorkflowSubmit(BaseModel):
    key: str | None = None
    steps: list[dict[str, Any]] | None = None
    params: dict[str, Any] | None = None
    instanceId: str | None = None
    workspaceId: str | None = None
    # Opt-in purge-and-rerun of a terminal instance under the given instanceId (default: attach).
    fresh: bool | None = None
    policy: BabysitPolicy | None = None
    # Explicit engine watch spec — forwarded verbatim, wins over policy.
    watch: dict[str, Any] | None = None
    watchMeta: dict[str, Any] | None = None


class WorkflowBabysitter:
    """Pure forwarder to workflow-svc's watch-aware run routes (name kept for consumers)."""

    def __init__(
        self,
        agent_id: str,
        dapr_http_port: str | None = None,
        workflow_app_id: str = "workflow-svc",
        default_max_duration_ms: int = 45 * 60_000,
    ) -> None:
        self.agent_id = agent_id
        self.dapr_http_port = dapr_http_port or os.getenv("DAPR_HTTP_PORT", "3500")
        self.workflow_app_id = workflow_app_id
        self.default_max_duration_ms = default_max_duration_ms

    # -- sidecar HTTP (stdlib, blocking — always called via asyncio.to_thread) ------------

    def _invoke_url(self, method: str) -> str:
        return (
            f"http://localhost:{self.dapr_http_port}/v1.0/invoke/"
            f"{self.workflow_app_id}/method/{method}"
        )

    def _post(self, url: str, body: dict) -> dict:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}

    def _get(self, url: str) -> Any:
        with urllib.request.urlopen(url, timeout=10) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None

    # -- public API ------------------------------------------------------------------------

    async def submit(self, submit: WorkflowSubmit) -> dict:
        """Schedule on workflow-svc with a `watch` field; the engine supervises durably.

        Returns {"instanceId": ..., "watching": ...} straight from workflow-svc's reply.
        """
        if not submit.key and not submit.steps:
            raise ValueError("submit needs a key or steps")
        if submit.key:
            url = self._invoke_url(f"workflow/run/{urllib.parse.quote(submit.key)}")
            body: dict[str, Any] = {}
        else:
            url = self._invoke_url("workflow/run")
            body = {"steps": submit.steps}
        if submit.params:
            body["params"] = submit.params
        if submit.instanceId:
            body["instanceId"] = submit.instanceId
        if submit.workspaceId:
            body["workspaceId"] = submit.workspaceId
        if submit.fresh is not None:
            body["fresh"] = submit.fresh
        # Explicit watch wins over policy; otherwise translate policy → watch.
        if submit.watch is not None:
            body["watch"] = submit.watch
        else:
            policy = submit.policy or BabysitPolicy()
            body["watch"] = {"maxDurationMs": policy.maxDurationMs or self.default_max_duration_ms}
        if submit.watchMeta is not None:
            body["watchMeta"] = submit.watchMeta
        scheduled = await asyncio.to_thread(self._post, url, body)
        return {
            "instanceId": scheduled["instanceId"],
            "watching": scheduled.get("watching", False),
        }

    async def watch_list(self) -> Any:
        """Proxy workflow-svc's GET /watch/list — the durable watch table."""
        return await asyncio.to_thread(self._get, self._invoke_url("watch/list"))


def register_workflow_route(router: APIRouter, babysitter: WorkflowBabysitter) -> None:
    """The standard agent-service workflow endpoint: 'invoke this workflow, engine-watched'.

    Non-blocking — 202 with {instanceId, watching} as soon as workflow-svc schedules; the
    durable watcher engine inside workflow-svc supervises it (budget, retries, terminal
    events). The shared contract that makes any agent service a workflow entry point.
    GET /workflow/watches proxies the engine's durable watch list.
    """

    @router.post("/workflow", status_code=202)
    async def submit(body: WorkflowSubmit):
        if not body.key and not body.steps:
            raise HTTPException(
                status_code=400, detail="body needs a saved-workflow key or inline steps"
            )
        try:
            return await babysitter.submit(body)
        except Exception as exc:  # scheduling failure — surface, nothing is being watched
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get("/workflow/watches")
    async def watches():
        try:
            return await babysitter.watch_list()
        except Exception as exc:  # workflow-svc unreachable — the durable truth is elsewhere
            raise HTTPException(status_code=502, detail=str(exc)) from exc
