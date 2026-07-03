import hashlib
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agent_server.models import AgentRequest
from agent_server.run_ledger import record_run
from agent_server.runner import IAgentRunner

WorkspaceResolver = Callable[[str], Path]

# Marks a workspace as provisioned. Holds a hash of the setup spec, so a reused workspace re-runs
# setup only when the spec changes. A fresh per-run workspace never has it and always provisions.
SETUP_SENTINEL = ".agent-setup-complete"


class RunRequest(BaseModel):
    input: str
    systemPrompt: str | None = None
    sessionId: str | None = None
    workflowInstanceId: str | None = None
    workspaceId: str | None = None


class SetupItem(BaseModel):
    cmd: str
    validateCmd: str | None = None


class SetupRequest(BaseModel):
    workflowInstanceId: str = "default"
    workspaceId: str | None = None
    setup: list[SetupItem] = []


def register_run_route(
    router: APIRouter,
    runner: IAgentRunner,
    resolve_workspace_dir: WorkspaceResolver,
    agent_id: str = "agent",
) -> None:
    @router.post("/run")
    async def run(req: RunRequest):
        # workspaceId pins a reusable dir; otherwise fall back to the per-run instance id.
        workspace_key = req.workspaceId or req.workflowInstanceId or "default"
        workspace = resolve_workspace_dir(workspace_key)
        workspace.mkdir(parents=True, exist_ok=True)
        request = AgentRequest(
            input=req.input,
            system_prompt=req.systemPrompt,
            session_id=req.sessionId,
            workflow_instance_id=req.workflowInstanceId,
            workspace_id=req.workspaceId,
        )
        try:
            response = await runner.run(request, workspace)
        except Exception as exc:
            record_run(
                agent_id=agent_id,
                request=request,
                response=None,
                workspace=workspace,
                status="failed",
                error=str(exc),
            )
            raise HTTPException(status_code=500, detail=str(exc))
        run_id = record_run(
            agent_id=agent_id,
            request=request,
            response=response,
            workspace=workspace,
            status="completed",
        )
        return {
            "output": response.output,
            "sessionId": response.session_id,
            "usage": response.usage,
            "model": response.model,
            "turns": response.turns,
            "workspacePath": str(workspace),
            "costUsd": response.cost_usd,
            "toolCalls": response.tool_calls,
            "runId": run_id,
        }


def register_setup_route(router: APIRouter, resolve_workspace_dir: WorkspaceResolver) -> None:
    @router.post("/setup")
    async def setup(req: SetupRequest):
        workspace_key = req.workspaceId or req.workflowInstanceId
        workspace = resolve_workspace_dir(workspace_key)
        workspace.mkdir(parents=True, exist_ok=True)

        spec = json.dumps([s.model_dump() for s in req.setup], sort_keys=True)
        spec_hash = hashlib.sha256(spec.encode()).hexdigest()
        sentinel = workspace / SETUP_SENTINEL
        if sentinel.exists() and sentinel.read_text() == spec_hash:
            return {"workspacePath": str(workspace), "skipped": True}

        for step in req.setup:
            result = subprocess.run(
                step.cmd, shell=True, capture_output=True, text=True, cwd=str(workspace)
            )
            if result.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"Setup step failed: {step.cmd}\n{result.stderr}",
                )
            if step.validateCmd:
                val = subprocess.run(
                    step.validateCmd, shell=True, capture_output=True, text=True, cwd=str(workspace)
                )
                if val.returncode != 0:
                    raise HTTPException(
                        status_code=500,
                        detail=f"Validation failed: {step.validateCmd}\n{val.stderr}",
                    )
        sentinel.write_text(spec_hash)
        return {"workspacePath": str(workspace), "skipped": False}


def register_subscribe_route(router: APIRouter) -> None:
    @router.get("/dapr/subscribe")
    async def subscribe():
        return []


def register_agent_routes(
    router: APIRouter,
    runner: IAgentRunner,
    resolve_workspace_dir: WorkspaceResolver,
    agent_id: str = "agent",
) -> None:
    """Registers the HTTP contract every workspace-backed agent shares: POST /run,
    POST /setup, GET /dapr/subscribe. Per-instance workspace layout is supplied by
    the caller via resolve_workspace_dir; agent_id labels the run-ledger records.

    Apps with extra routes (e.g. a bespoke /run or /save) can instead compose the
    individual register_* helpers and add their own routes on the same router.
    """
    register_run_route(router, runner, resolve_workspace_dir, agent_id)
    register_setup_route(router, resolve_workspace_dir)
    register_subscribe_route(router)
