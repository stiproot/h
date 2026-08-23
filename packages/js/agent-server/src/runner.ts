import type { AgentRequest, AgentResponse, AgentRunError } from "core";
import { Context, type Effect } from "effect";

/**
 * The agent-runner port: the contract the shared agent routes invoke to execute a run
 * request, as a `Context.Tag` — a domain port per ARCHITECTURE.md#boundaries-enforced.
 * The workspace dir
 * is resolved by the runner from the request (workspaceId / workflowInstanceId / cwd),
 * exactly as today's Promise-based runners do. Failures surface as `core`'s
 * cross-service `AgentRunError` tag, which the `runHandler` bridge maps to HTTP 500.
 */
export class AgentRunner extends Context.Tag("AgentRunner")<
  AgentRunner,
  {
    readonly run: (request: AgentRequest) => Effect.Effect<AgentResponse, AgentRunError>;
  }
>() {}
