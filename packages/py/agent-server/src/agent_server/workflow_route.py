"""The workflow babysitter + standard POST /workflow route — Python sibling of
js/agent-server's workflow-babysitter.ts / workflow-route.ts.

`submit` schedules a workflow on workflow-svc (via the Dapr sidecar) and returns the
instanceId immediately; a background asyncio task then polls the instance on a cadence and
enforces a deterministic policy — terminal status → publish a `workflow-events` event and
stop; wall-clock budget exceeded → terminate the instance, publish, stop. Machines run the
loop; agents are only consulted at decision points — never blocked holding a connection for
the workflow's lifetime.

Dependency-free like run_ledger (stdlib urllib, run in a thread from the event loop).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

_TERMINAL = {"COMPLETED", "FAILED", "TERMINATED"}


class BabysitPolicy(BaseModel):
    maxDurationMs: int | None = None
    pollIntervalMs: int | None = None


class WorkflowSubmit(BaseModel):
    key: str | None = None
    steps: list[dict[str, Any]] | None = None
    params: dict[str, Any] | None = None
    instanceId: str | None = None
    workspaceId: str | None = None
    policy: BabysitPolicy | None = None


@dataclass
class WatchState:
    instanceId: str
    startedAt: str
    lastStatus: str = "SCHEDULED"
    outcome: str | None = None
    endedAt: str | None = None


def _now() -> str:
    return datetime.now(UTC).isoformat()


class WorkflowBabysitter:
    """Submit-and-supervise. In-process watch table (restarts forget past watches — MVP)."""

    def __init__(
        self,
        agent_id: str,
        dapr_http_port: str | None = None,
        workflow_app_id: str = "workflow-svc",
        pubsub_name: str = "pubsub",
        events_topic: str = "workflow-events",
        default_poll_interval_ms: int = 10_000,
        default_max_duration_ms: int = 45 * 60_000,
    ) -> None:
        self.agent_id = agent_id
        self.dapr_http_port = dapr_http_port or os.getenv("DAPR_HTTP_PORT", "3500")
        self.workflow_app_id = workflow_app_id
        self.pubsub_name = pubsub_name
        self.events_topic = events_topic
        self.default_poll_interval_ms = default_poll_interval_ms
        self.default_max_duration_ms = default_max_duration_ms
        self.watches: dict[str, WatchState] = {}

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

    def _get_status(self, instance_id: str) -> str:
        url = self._invoke_url(f"workflow/status/{urllib.parse.quote(instance_id)}")
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                return json.loads(resp.read()).get("runtimeStatus", "UNKNOWN")
        except Exception:
            # A transient sidecar/svc outage reads as UNKNOWN and the loop keeps polling —
            # supervision must outlive the infra hiccups it exists to catch.
            return "UNKNOWN"

    # -- public API ------------------------------------------------------------------------

    async def submit(self, submit: WorkflowSubmit) -> dict:
        """Schedule and start watching; returns {"instanceId": ...} as soon as scheduled."""
        if not submit.key and not submit.steps:
            raise ValueError("submit needs a key or steps")
        if submit.key:
            url = self._invoke_url(f"workflow/run/{urllib.parse.quote(submit.key)}")
            body: dict[str, Any] = {"params": submit.params} if submit.params else {}
        else:
            url = self._invoke_url("workflow/run")
            body = {"steps": submit.steps}
            if submit.params:
                body["params"] = submit.params
            if submit.instanceId:
                body["instanceId"] = submit.instanceId
            if submit.workspaceId:
                body["workspaceId"] = submit.workspaceId
        scheduled = await asyncio.to_thread(self._post, url, body)
        instance_id = scheduled["instanceId"]
        state = WatchState(instanceId=instance_id, startedAt=_now())
        self.watches[instance_id] = state
        policy = submit.policy or BabysitPolicy()
        # Fire-and-forget: the watch owns its lifetime; a watch failure never propagates
        # into the submitting request.
        task = asyncio.create_task(self._watch(state, policy))
        task.add_done_callback(lambda t: t.exception())  # swallow, already logged
        return {"instanceId": instance_id}

    def list(self) -> list[dict]:
        return [asdict(s) for s in self.watches.values()]

    # -- the deterministic loop --------------------------------------------------------------

    async def _watch(self, state: WatchState, policy: BabysitPolicy) -> None:
        poll_s = (policy.pollIntervalMs or self.default_poll_interval_ms) / 1000
        budget_s = (policy.maxDurationMs or self.default_max_duration_ms) / 1000
        deadline = time.monotonic() + budget_s
        try:
            while True:
                await asyncio.sleep(poll_s)
                status = await asyncio.to_thread(self._get_status, state.instanceId)
                state.lastStatus = status
                if status in _TERMINAL:
                    state.outcome = status.lower()
                    state.endedAt = _now()
                    await self._publish_event(state, status)
                    return
                if time.monotonic() >= deadline:
                    logger.warning(
                        "babysitter | %s exceeded %.0fs budget — terminating",
                        state.instanceId,
                        budget_s,
                    )
                    terminate_url = self._invoke_url(
                        f"workflow/terminate/{urllib.parse.quote(state.instanceId)}"
                    )
                    try:
                        await asyncio.to_thread(self._post, terminate_url, {})
                    except Exception:
                        logger.exception("babysitter | terminate %s failed", state.instanceId)
                    state.outcome = "budget-terminated"
                    state.endedAt = _now()
                    await self._publish_event(state, "TERMINATED")
                    return
        except Exception:
            logger.exception("babysitter | watch %s died", state.instanceId)

    async def _publish_event(self, state: WatchState, status: str) -> None:
        url = (
            f"http://localhost:{self.dapr_http_port}/v1.0/publish/"
            f"{self.pubsub_name}/{self.events_topic}"
        )
        event = {
            "instanceId": state.instanceId,
            "outcome": state.outcome,
            "runtimeStatus": status,
            "watcherAgentId": self.agent_id,
            "startedAt": state.startedAt,
            "endedAt": state.endedAt,
        }
        try:
            await asyncio.to_thread(self._post, url, event)
        except Exception:
            # Event emission is best-effort observability — never fail the watch over it.
            logger.warning("babysitter | publish for %s failed", state.instanceId)


def register_workflow_route(router: APIRouter, babysitter: WorkflowBabysitter) -> None:
    """The standard agent-service workflow endpoint: 'invoke and babysit this workflow'.

    Non-blocking — 202 with the instanceId as soon as the run is scheduled; the babysitter's
    background task supervises it. The shared contract that makes any agent service a
    workflow entry point. GET /workflow/watches exposes the in-process watch table.
    """

    @router.post("/workflow", status_code=202)
    async def submit(body: WorkflowSubmit):
        if not body.key and not body.steps:
            raise HTTPException(
                status_code=400, detail="body needs a saved-workflow key or inline steps"
            )
        try:
            result = await babysitter.submit(body)
        except Exception as exc:  # scheduling failure — surface, nothing is being watched
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {**result, "watching": True}

    @router.get("/workflow/watches")
    async def watches():
        return babysitter.list()
