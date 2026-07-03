type McpConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/**
 * Merges h's MCP servers into a workspace's existing .mcp.json content, returning the JSON to
 * write. The project's own servers and other top-level keys are preserved; h's servers win on a
 * name conflict (they are the runtime context being provisioned). `existing` is null when no
 * .mcp.json is present, in which case the result is just the incoming config.
 *
 * This is what lets the agent operate in a worktree that carries its own .mcp.json (e.g. a target
 * repo ships one with only a `tessl` server) while still gaining h's dapr/obs/workflows servers.
 */
export function mergeMcpConfig(existing: string | null, incoming: string): string {
  const incomingJson = JSON.parse(incoming) as McpConfig;
  const serialize = (cfg: McpConfig) => JSON.stringify(cfg, null, 2) + "\n";

  if (existing === null) return serialize(incomingJson);

  let existingJson: McpConfig;
  try {
    existingJson = JSON.parse(existing) as McpConfig;
  } catch {
    // An unparseable project file can't be merged into; fall back to h's config.
    return serialize(incomingJson);
  }

  return serialize({
    ...existingJson,
    mcpServers: { ...(existingJson.mcpServers ?? {}), ...(incomingJson.mcpServers ?? {}) },
  });
}
