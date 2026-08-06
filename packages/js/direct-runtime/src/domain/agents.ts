import { DIRECT_AGENT_TYPES, type DirectAgentType } from "./models.ts";

/**
 * User-facing `--agent` name → the agent this substrate runs.
 *
 * This mirrors the CLI's `AGENT_IDENTITY` table (cli/h/src/h_cli/config.py), which maps the SAME
 * names onto `{runActivity, agentId}` for the service substrate. One name, one executor, both
 * substrates — that symmetry is the point, so the two tables are kept in step deliberately:
 * `--agent codex` renders `activity: "run-codex"` over there and selects the codex strategy here.
 *
 * A CLOSED table on purpose. An unknown name fails loud, naming what is available, rather than
 * quietly falling back to a default agent and billing the wrong provider.
 */
const AGENT_ALIASES: Readonly<Record<string, DirectAgentType>> = {
  claude: "claude",
  "claude-agent": "claude",
  codex: "codex",
  "codex-agent": "codex",
  openhands: "openhands",
  "openhands-agent": "openhands",
  pi: "pi",
  "pi-agent": "pi",
};

/** An `--agent` name this substrate cannot run. */
export class UnknownAgentError extends Error {
  constructor(readonly agent: string) {
    super(
      `unknown agent '${agent}' — direct execution runs: ${DIRECT_AGENT_TYPES.join(", ")}. ` +
        "Agents that exist only as a service (kimi, dapr-agent, langgraph, claude-managed) run " +
        "on the service substrate; drop --direct to use them.",
    );
    this.name = "UnknownAgentError";
  }
}

/** Resolve one `--agent` name to its canonical agent, or throw {@link UnknownAgentError}. */
export function resolveAgent(name: string): DirectAgentType {
  const resolved = AGENT_ALIASES[name.trim().toLowerCase()];
  if (!resolved) throw new UnknownAgentError(name);
  return resolved;
}
