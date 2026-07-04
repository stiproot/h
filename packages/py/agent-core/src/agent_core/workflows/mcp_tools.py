"""Connect to the workflow-mcp server over SSE and return its tools.

Moved here from workflow-agent so any Python agent can wire the workflow toolset
(save_workflow / run_workflow / run_saved_workflow / list_workflows / get_workflow /
get_workflow_status / await_workflow) into its ReAct loop, not just the orchestrator.
"""

import logging

from dapr_agents.tool.mcp.client import MCPClient

logger = logging.getLogger(__name__)


async def connect_workflows_mcp(url: str) -> tuple[MCPClient, list]:
    """Open an SSE connection to the workflow-mcp server and return (client, tools).

    The caller owns the client and must ``await client.close()`` when done — the MCP
    session must stay alive for the duration of any tool execution.
    """
    client = MCPClient()
    await client.connect_sse("workflows", url)
    tools = client.get_all_tools()
    logger.info("agent-core | connected to workflow-mcp (%d tools)", len(tools))
    return client, tools
