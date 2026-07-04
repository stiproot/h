"""The workflow-MCP toolset: connect to workflow-mcp and expose its tools (save/run/
monitor/await) to an agent. Requires the ``dapr`` extra (``agent-core[dapr]``), which
provides ``dapr_agents``' MCP client.
"""

from agent_core.workflows.mcp_tools import (
    WorkflowTools,
    connect_workflows_mcp,
    open_workflow_tools,
)

__all__ = ["WorkflowTools", "connect_workflows_mcp", "open_workflow_tools"]
