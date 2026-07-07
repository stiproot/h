type OhMcpConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/**
 * Resolve an OpenHands MCP config source into the file content to write at
 * `$HOME/.openhands/mcp.json` for a run.
 *
 * Unlike the `claude` CLI (which reads `.mcp.json` from its cwd and expands `${VAR}`
 * from the process env), OpenHands reads a single HOME-keyed file and does NOT expand
 * `${...}` placeholders. So the runner substitutes the referenced env vars here — today
 * that is `GH_TOKEN` in the github server's `Authorization` header — before writing.
 *
 * A `${VAR}` whose env value is unset collapses to an empty string (e.g. no `GH_TOKEN`
 * yields `Bearer `, leaving the github server present but unauthenticated; the other
 * servers still work). The source must be valid JSON — a malformed file throws, failing
 * the run fast rather than handing OpenHands an unparseable config.
 */
export function resolveOpenhandsMcpConfig(
  source: string,
  env: Record<string, string | undefined>,
): string {
  const substituted = source.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_match, name: string) => env[name] ?? "",
  );
  const parsed = JSON.parse(substituted) as OhMcpConfig;
  return JSON.stringify(parsed, null, 2) + "\n";
}
