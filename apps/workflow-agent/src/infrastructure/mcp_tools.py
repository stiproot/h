import logging

from dapr_agents.tool.mcp.client import MCPClient

logger = logging.getLogger(__name__)


async def connect_workflows_mcp(url: str) -> tuple[MCPClient, list]:
    """Open an SSE connection to the workflow-mcp server and return (client, tools).

    The caller owns the client and must `await client.close()` when done — the MCP
    session must stay alive for the duration of any tool execution.
    """
    client = MCPClient()
    await client.connect_sse("workflows", url)
    tools = client.get_all_tools()
    logger.info("workflow-agent | connected to workflow-mcp (%d tools)", len(tools))
    return client, tools
