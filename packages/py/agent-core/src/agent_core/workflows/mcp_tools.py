"""Connect to the workflow-mcp server over SSE and return its tools.

Moved here from workflow-agent so any Python agent can wire the workflow toolset
(save_workflow / run_workflow / run_saved_workflow / list_workflows / get_workflow /
get_workflow_status / await_workflow) into its ReAct loop, not just the orchestrator.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from dapr_agents.tool.mcp.client import MCPClient

logger = logging.getLogger(__name__)


async def connect_workflows_mcp(url: str) -> tuple[MCPClient, list]:
    """Open an SSE connection to the workflow-mcp server and return (client, tools).

    The caller owns the client and must ``await client.close()`` when done — the MCP
    session must stay alive for the duration of any tool execution. Prefer
    :func:`open_workflow_tools`, which manages the lifecycle.
    """
    client = MCPClient()
    await client.connect_sse("workflows", url)
    tools = client.get_all_tools()
    logger.info("agent-core | connected to workflow-mcp (%d tools)", len(tools))
    return client, tools


class WorkflowTools:
    """A live workflow-mcp toolset: the tool objects to hand the LLM (``tools``) plus
    name-routed dispatch. Lets an agent add workflow orchestration by merging ``tools``
    into its tool list and routing calls it :meth:`handles` to :meth:`run`."""

    def __init__(self, client: MCPClient, tools: list) -> None:
        self._client = client
        self.tools = tools
        self._by_name = {t.name: t for t in tools}

    def handles(self, name: str) -> bool:
        return name in self._by_name

    async def run(self, name: str, args: dict) -> str:
        return str(await self._by_name[name].arun(**args))

    async def aclose(self) -> None:
        await self._client.close()


@asynccontextmanager
async def open_workflow_tools(url: str) -> AsyncIterator[WorkflowTools]:
    """Connect to workflow-mcp for the duration of the block, closing the session on exit.

    The MCP session must stay alive while any tool runs, so scope the whole agent loop
    inside this context.
    """
    client, tools = await connect_workflows_mcp(url)
    workflow_tools = WorkflowTools(client, tools)
    try:
        yield workflow_tools
    finally:
        await workflow_tools.aclose()
