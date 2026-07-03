from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from domain.models import AgentRequest
from domain.ports.agent_runner import IAgentRunner


class RunRequest(BaseModel):
    input: str
    systemPrompt: str | None = None
    sessionId: str | None = None
    workflowInstanceId: str | None = None


def create_router(runner: IAgentRunner) -> APIRouter:
    router = APIRouter()

    @router.post("/run")
    async def run(req: RunRequest):
        request = AgentRequest(
            input=req.input,
            system_prompt=req.systemPrompt,
            session_id=req.sessionId,
            workflow_instance_id=req.workflowInstanceId,
        )
        try:
            response = await runner.run(request)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        return {
            "output": response.output,
            "sessionId": response.session_id,
            "usage": response.usage,
            "model": response.model,
            "turns": response.turns,
        }

    @router.post("/setup")
    async def setup():
        return {"status": "ok"}

    @router.get("/dapr/subscribe")
    async def subscribe():
        return []

    return router
