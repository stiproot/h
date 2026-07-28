// AgentRequest/AgentResponse are Schema.Struct values whose derived types share
// the same name — `import type { AgentRequest } from "core"` keeps working, and
// `Schema.decodeUnknown(AgentRequest)` validates a wire body against the same name.
export { AgentRequest, AgentResponse } from "./types/agent.ts";
export { AgentRunError, CloneError, DaprInvokeError, WorkflowError } from "./errors.ts";
export { mergeMcpConfig, provisionMcpConfig } from "./mcp-config.ts";
