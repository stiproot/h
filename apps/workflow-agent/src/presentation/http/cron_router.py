import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from domain.models import Task, TaskStatus
from infrastructure.statestore import StateStore
from infrastructure.workflow_agent_runner import WorkflowAgentRunner

logger = logging.getLogger(__name__)


class RunRequest(BaseModel):
    taskId: str


def create_router(runner: WorkflowAgentRunner, store: StateStore) -> APIRouter:
    router = APIRouter()
    # Tasks can take minutes; the cron binding fires far more often. This lock makes an
    # overlapping tick a no-op rather than re-scanning while a task is mid-flight. (The
    # pending→processing flip is the real guard against double-processing a single task.)
    tick_lock = asyncio.Lock()

    async def _process(task: Task) -> Task:
        task.status = TaskStatus.PROCESSING.value
        await store.save_task(task.to_state())
        try:
            result = await runner.run(task.problem)
            task.result = result.output
            task.status = TaskStatus.DONE.value
            await store.save_task(task.to_state())
        except Exception as exc:
            logger.exception("workflow-agent | task %s failed", task.id)
            task.status = TaskStatus.FAILED.value
            task.result = f"error: {exc}"
            await store.save_task(task.to_state())
        return task

    # Dapr cron binding delivers its trigger as POST /<binding-name>; the binding is named
    # cron-tick, so this route is its target.
    @router.post("/cron-tick")
    async def cron_tick():
        if tick_lock.locked():
            return {"skipped": "previous tick still processing"}
        async with tick_lock:
            processed: list[str] = []
            for task_id in await store.list_task_ids():
                data = await store.get_task(task_id)
                if data and data.get("status") == TaskStatus.PENDING.value:
                    await _process(Task.from_state(data))
                    processed.append(task_id)
            return {"processed": processed}

    @router.post("/run")
    async def run_one(req: RunRequest):
        data = await store.get_task(req.taskId)
        if not data:
            raise HTTPException(status_code=404, detail=f"Task not found: {req.taskId}")
        task = await _process(Task.from_state(data))
        return task.to_state()

    @router.get("/dapr/subscribe")
    async def subscribe():
        # No subscriptions. The plugin-feedback → plugin-improvement flow moved out of this
        # service: it is now the `plugin-improvement` chart family (cli/charts) fired by
        # workflow-svc's generic `workflow-trigger` topic — a family + an event, no domain
        # routes in any agent service. See docs/plans/workflow-unification.md.
        return []

    return router
