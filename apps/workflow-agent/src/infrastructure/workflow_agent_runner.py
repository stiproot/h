import asyncio
import json
import logging
import os

import httpx
from dapr_agents import OpenAIChatClient

from domain.models import AgentResult
from infrastructure.mcp_tools import connect_workflows_mcp

logger = logging.getLogger(__name__)

_TERMINAL = {"COMPLETED", "FAILED", "TERMINATED"}

# Local tool (not from MCP): lets the agent block on a slow workflow in a single tool
# call instead of busy-polling get_workflow_status across many LLM turns. Passed to the
# LLM as a raw OpenAI schema alongside the MCP AgentTool objects.
_AWAIT_WORKFLOW_SCHEMA = {
    "type": "function",
    "function": {
        "name": "await_workflow",
        "description": (
            "Block until a running workflow instance reaches a terminal state "
            "(COMPLETED / FAILED / TERMINATED) and return its final runtimeStatus and "
            "output. Call this once after run_saved_workflow or run_workflow, passing the "
            "returned instanceId — do not poll get_workflow_status in a loop yourself."
        ),
        "parameters": {
            "type": "object",
            "properties": {"instanceId": {"type": "string"}},
            "required": ["instanceId"],
        },
    },
}


class WorkflowAgentRunner:
    """Drives a ReAct loop (dapr_agents OpenAIChatClient) over the workflow-mcp tools.

    The agent builds/looks-up a workflow for the task, saves it, runs it, waits for it to
    finish (via the await_workflow helper), repairs and re-runs on failure, and returns the
    completed workflow's output.
    """

    def __init__(
        self,
        *,
        model: str,
        system_prompt: str,
        max_iterations: int,
        workflows_mcp_url: str,
        dapr_http_port: str,
    ) -> None:
        self._model = model
        self._system = system_prompt
        self._max_iterations = max_iterations
        self._mcp_url = workflows_mcp_url
        self._dapr_base = f"http://localhost:{dapr_http_port}"
        self._llm = OpenAIChatClient(
            api_key=os.environ["ANTHROPIC_API_KEY"],
            base_url=os.environ["ANTHROPIC_BASE_URL"],
            model=model,
        )

    async def _await_workflow(
        self, instanceId: str, max_wait_s: int = 900, interval_s: int = 5
    ) -> dict:
        url = f"{self._dapr_base}/v1.0/invoke/workflow-svc/method/workflow/status/{instanceId}"
        waited = 0
        async with httpx.AsyncClient(timeout=30) as client:
            while waited < max_wait_s:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("runtimeStatus") in _TERMINAL:
                        return data
                await asyncio.sleep(interval_s)
                waited += interval_s
        return {"instanceId": instanceId, "runtimeStatus": "TIMEOUT"}

    async def run(self, problem: str) -> AgentResult:
        client, mcp_tools = await connect_workflows_mcp(self._mcp_url)
        tool_map = {t.name: t for t in mcp_tools}
        tools_arg = [*mcp_tools, _AWAIT_WORKFLOW_SCHEMA]
        messages: list = [
            {"role": "system", "content": self._system},
            {"role": "user", "content": problem},
        ]
        try:
            for turn in range(1, self._max_iterations + 1):
                logger.info("workflow-agent | turn %d", turn)
                response = await asyncio.to_thread(self._llm.generate, messages, tools=tools_arg)
                msg = response.get_message()
                tool_calls = msg.get_tool_calls() if hasattr(msg, "get_tool_calls") else None

                if not tool_calls:
                    return AgentResult(output=msg.content or "", turns=turn)

                messages.append(msg)
                for tc in tool_calls:
                    name = tc.function.name
                    args = tc.function.arguments_dict
                    logger.info("workflow-agent |   -> %s(%s)", name, json.dumps(args)[:160])
                    if name == "await_workflow":
                        result = json.dumps(await self._await_workflow(**args))
                    elif name in tool_map:
                        result = str(await tool_map[name].arun(**args))
                    else:
                        result = f"Unknown tool: {name}"
                    messages.append(
                        {"role": "tool", "tool_call_id": tc.id, "content": str(result)[:8000]}
                    )

            return AgentResult(
                output="Agent reached max iterations without finishing.",
                turns=self._max_iterations,
            )
        finally:
            await client.close()
