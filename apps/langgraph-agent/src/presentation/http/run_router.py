from collections.abc import Callable
from pathlib import Path

from agent_server import IAgentRunner, record_run
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from domain.models import AgentRequest, GraphConfig
from domain.ports import IPresetStore

WorkspaceResolver = Callable[[str], Path]


class GraphConfigModel(BaseModel):
    tools: list[str] | None = None
    systemPrompt: str | None = None
    model: str | None = None
    maxIterations: int | None = None

    def to_domain(self) -> GraphConfig:
        return GraphConfig(
            tools=self.tools,
            system_prompt=self.systemPrompt,
            model=self.model,
            max_iterations=self.maxIterations,
        )


class RunRequest(BaseModel):
    input: str
    systemPrompt: str | None = None
    sessionId: str | None = None
    workflowInstanceId: str | None = None
    graph: GraphConfigModel | None = None
    preset: str | None = None


class SaveRequest(BaseModel):
    key: str
    graph: GraphConfigModel


def register_langgraph_routes(
    router: APIRouter,
    runner: IAgentRunner,
    resolve_workspace_dir: WorkspaceResolver,
    presets: IPresetStore,
) -> None:
    """Registers langgraph-agent's app-specific routes: a /run that resolves a graph
    config or named preset, and /save to persist named graph configs. The shared
    /setup and /dapr/subscribe come from agent_server.register_* helpers."""

    @router.post("/run")
    async def run(req: RunRequest):
        workflow_instance_id = req.workflowInstanceId or "default"
        workspace = resolve_workspace_dir(workflow_instance_id)
        workspace.mkdir(parents=True, exist_ok=True)

        graph: GraphConfig | None = None
        if req.graph is not None:
            graph = req.graph.to_domain()
        elif req.preset:
            graph = presets.get(req.preset)
            if graph is None:
                raise HTTPException(status_code=404, detail=f"Preset not found: {req.preset}")

        request = AgentRequest(
            input=req.input,
            system_prompt=req.systemPrompt,
            session_id=req.sessionId,
            workflow_instance_id=req.workflowInstanceId,
            graph=graph,
        )
        try:
            response = await runner.run(request, workspace)
        except Exception as exc:
            record_run(
                agent_id="langgraph-agent",
                request=request,
                response=None,
                workspace=workspace,
                status="failed",
                error=str(exc),
            )
            raise HTTPException(status_code=500, detail=str(exc))
        run_id = record_run(
            agent_id="langgraph-agent",
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

    @router.post("/save", status_code=201)
    async def save(req: SaveRequest):
        try:
            presets.save(req.key, req.graph.to_domain())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"key": req.key}
