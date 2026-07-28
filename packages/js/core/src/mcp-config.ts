type McpConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

const serialize = (cfg: McpConfig) => JSON.stringify(cfg, null, 2) + "\n";

/**
 * Produces the .mcp.json content to write into a run's cwd, per `mode`:
 *
 * - `"merge"` (default): h's MCP servers merge into the workspace's existing config. The
 *   project's own servers and other top-level keys are preserved; h's servers win on a name
 *   conflict (they are the runtime context being provisioned). This is what lets the agent
 *   operate in a worktree that carries its own .mcp.json (e.g. a target repo ships one with
 *   only a `tessl` server) while still gaining h's dapr/obs/workflows servers.
 * - `"replace"`: the existing config is discarded entirely — servers AND other top-level
 *   keys — and only the incoming config survives. A minimal-surface posture: an agent that
 *   executes untrusted specs must never inherit any cwd servers, whatever the target repo
 *   (a hostile third-party repo's .mcp.json is exactly as dangerous as h's own).
 *
 * `existing` is null when no .mcp.json is present, in which case both modes return just the
 * incoming config.
 */
export function mergeMcpConfig(
  existing: string | null,
  incoming: string,
  mode: "merge" | "replace" = "merge",
): string {
  const incomingJson = JSON.parse(incoming) as McpConfig;

  if (existing === null || mode === "replace") return serialize(incomingJson);

  let existingJson: McpConfig;
  try {
    existingJson = JSON.parse(existing) as McpConfig;
  } catch {
    // An unparseable project file can't be merged into; fall back to h's config.
    return serialize(incomingJson);
  }

  return serialize({
    ...existingJson,
    mcpServers: { ...existingJson.mcpServers, ...incomingJson.mcpServers },
  });
}
