import { join } from "path";

import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

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

/**
 * Provisions the run cwd's `.mcp.json` from `src` per `mode` (exported for tests):
 *
 * - `merge`: h's servers merge into whatever `.mcp.json` the cwd already has (the project's
 *   own servers and top-level keys survive; h's win on a name conflict). A missing `src` is
 *   skipped — merge mode is a convenience, not a guarantee.
 * - `replace`: the cwd's config is discarded entirely and only `src`'s servers survive — the
 *   minimal-surface posture, where the cwd is a target repo whose `.mcp.json` must never reach
 *   an agent executing untrusted specs. Fails CLOSED: a missing `src` is a defect (the run
 *   aborts loudly), because silently skipping the rewrite would leave the target repo's own
 *   servers — potentially h's control-plane set — in place.
 */
export const provisionMcpConfig = (
  cwd: string,
  src: string,
  mode: "merge" | "replace",
): Effect.Effect<void, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mcpDest = join(cwd, ".mcp.json");
    if (!(yield* fs.exists(src))) {
      if (mode === "replace") {
        return yield* Effect.dieMessage(
          `MCP_CONFIG_MODE=replace requires MCP_CONFIG_SRC to exist; missing: ${src}`,
        );
      }
      return;
    }
    // Replace mode never reads the cwd config it would discard.
    const existing =
      mode === "replace"
        ? null
        : (yield* fs.exists(mcpDest))
          ? yield* fs.readFileString(mcpDest)
          : null;
    const incoming = yield* fs.readFileString(src);
    const merged = yield* Effect.try({
      try: () => mergeMcpConfig(existing, incoming, mode),
      catch: (cause) => cause,
    });
    yield* fs.writeFileString(mcpDest, merged);
  });
