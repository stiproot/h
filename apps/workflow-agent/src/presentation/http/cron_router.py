import asyncio
import json
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from domain.models import Task, TaskStatus
from infrastructure.statestore import StateStore
from infrastructure.workflow_agent_runner import WorkflowAgentRunner

logger = logging.getLogger(__name__)

PLUGIN_FEEDBACK_TOPIC = "plugin-feedback"


class RunRequest(BaseModel):
    taskId: str


def _improvement_problem(feedback: str, repo: str, tile: str, plugin: str, branch: str) -> str:
    """Plain-English task: worktree the target repo and apply the plugin improvement on it."""
    return (
        f"Improve the {plugin} plugin using triage feedback. The plugin source lives at {tile} "
        f"in the {repo} repository. Build and start an EPHEMERAL workflow with run_workflow (do NOT "
        f"save_workflow). Steps:\n"
        f"(1) create-worktree with id 'worktree': input {{ agentId: 'claude-agent', branch: "
        f"'{branch}' }} off the shared pre-cloned repo.\n"
        f"(2) run-claude with id 'improve', input {{ cwd: '{{{{worktree.worktreePath}}}}', task: "
        f"'You are in a git worktree of the plugin repository (your current directory). Trace the "
        f"current {plugin} plugin source under {tile} (SKILL.md, references/, scripts/) "
        f"before editing — the installed copy can lag the source. Apply this improvement:"
        f"\\n\\n{feedback}\\n\\nMake a focused change to the plugin source and bump the version "
        f"in {tile}.tessl-plugin/plugin.json. Do not commit. Summarize what you changed.' }}.\n"
        f"Await the instance; when COMPLETED, return the improve step output verbatim."
    )


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
        # Route plugin-feedback events (published by the triage diagnosis step) to the handler
        # below, which turns each into a plugin-improvement task. route matches the POST path.
        return [
            {
                "pubsubname": "pubsub",
                "topic": PLUGIN_FEEDBACK_TOPIC,
                "route": "plugin-feedback",
            }
        ]

    @router.post("/plugin-feedback")
    async def plugin_feedback(request: Request):
        # Dapr delivers a CloudEvents envelope; the published payload is in `data`. Parse it
        # defensively since the agent may publish data as an object or a JSON string.
        envelope = await request.json()
        data = envelope.get("data", envelope) if isinstance(envelope, dict) else envelope
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError:
                data = {"feedback": data}
        if not isinstance(data, dict):
            return {"skipped": "event data is not an object"}

        feedback = (data.get("feedback") or "").strip()
        if not feedback:
            return {"skipped": "empty feedback"}

        issue_id = data.get("issueId")
        # Plugin targeting comes from the event, falling back to deployment config — there is
        # deliberately no in-code default, since repo/plugin names are org-specific.
        repo = data.get("repo") or os.getenv("PLUGIN_FEEDBACK_REPO", "")
        tile = data.get("tilePath") or os.getenv("PLUGIN_FEEDBACK_TILE_PATH", "")
        if not repo or not tile:
            logger.warning(
                "workflow-agent | plugin-feedback event lacks repo/tilePath and no "
                "PLUGIN_FEEDBACK_REPO / PLUGIN_FEEDBACK_TILE_PATH configured — skipping"
            )
            return {"skipped": "no repo/tilePath in event and no PLUGIN_FEEDBACK_* env configured"}
        plugin = tile.rstrip("/").split("/")[-1]
        suffix = issue_id or envelope.get("id", "event")
        task_id = f"{plugin}-improve-{suffix}"
        branch = f"improve/{plugin}-{suffix}"

        # Seed a pending task; the cron tick picks it up and drives the improvement workflow.
        # Seeding (not processing inline) keeps the ack fast so Dapr does not redeliver.
        await store.seed_task(
            {
                "id": task_id,
                "status": TaskStatus.PENDING.value,
                "problem": _improvement_problem(feedback, repo, tile, plugin, branch),
                "issueId": issue_id,
                "result": None,
            }
        )
        logger.info("workflow-agent | seeded plugin-improvement task %s", task_id)
        return {"seeded": task_id}

    return router
