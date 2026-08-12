# system-c4-container — h container topology

The topology of the SERVICE substrate inside the `h` system boundary: workflow-svc (the engine),
the agent fleet, the three MCP servers, Redis/Dapr, and the observability spine. For the outer
view see [system-c4-context](./system-c4-context.md).

**This is one of h's two execution substrates.** The same composed definition can instead run on
the LOCAL substrate — agent CLIs as child processes of the `h` CLI, with none of the containers
below. The fork, and what each substrate can and cannot offer, is
[execution-substrates-c4-container](./execution-substrates-c4-container.md).

```mermaid
C4Container
  title h — container topology

  UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")

  Person(op, "Operator", "h CLI / Claude session")
  System_Ext(daprcp, "Dapr control plane", "Placement + scheduler")
  System_Ext(github, "GitHub", "PRs and issues")
  System_Ext(litellm, "LiteLLM proxy", "LLM routing")
  System_Ext(zipkin, "Zipkin", "Distributed tracing")
  System_Ext(loki, "Loki + Alloy", "Log aggregation")

  Container_Boundary(h, "h runtime") {
    Container(wfsvc, "workflow-svc", "TypeScript + Dapr", "Engine: watch/chain/cron/sched")
    Container(redis, "Redis", "Dapr statestore", "Flat keyspace registry")
    Container(claude, "claude-agent", "Node.js + Claude CLI", "Claude Code workflow steps")
    Container(openhands, "openhands-agent", "Node.js + OpenHands", "OpenHands workflow steps")
    Container(codex, "codex-agent", "Node.js + Codex CLI", "Codex workflow steps")
    Container(dapr_agent, "dapr-agent", "Python + ReAct", "Python agent steps")
    Container(wfmcp, "workflow-mcp", "TypeScript/Node.js", "Workflow MCP server")
    Container(daprmcp, "dapr-mcp", "TypeScript/Node.js", "State/pubsub MCP server")
    Container(obsmcp, "obs-mcp", "TypeScript/Node.js", "Observability MCP server")
  }

  Rel(op, wfsvc, "h CLI")
  UpdateRelStyle(op, wfsvc, $offsetX="-180", $offsetY="-120")
  Rel(op, wfmcp, "MCP (SSE)")
  UpdateRelStyle(op, wfmcp, $offsetX="-215", $offsetY="-660")
  Rel(wfsvc, redis, "Dapr state API")
  UpdateRelStyle(wfsvc, redis, $offsetY="-10")
  Rel(wfsvc, daprcp, "workflow invoke")
  UpdateRelStyle(wfsvc, daprcp, $offsetX="60", $offsetY="-60")
  Rel(wfsvc, claude, "sidecar invoke")
  UpdateRelStyle(wfsvc, claude, $offsetX="-265", $offsetY="-10")
  Rel(wfsvc, openhands, "sidecar invoke")
  UpdateRelStyle(wfsvc, openhands, $offsetX="120", $offsetY="-150")
  Rel(wfsvc, codex, "sidecar invoke")
  UpdateRelStyle(wfsvc, codex, $offsetX="-130", $offsetY="10")
  Rel(wfsvc, dapr_agent, "sidecar invoke")
  UpdateRelStyle(wfsvc, dapr_agent, $offsetX="120", $offsetY="60")
  Rel(claude, wfmcp, "MCP (SSE)")
  UpdateRelStyle(claude, wfmcp, $offsetX="-150", $offsetY="-30")
  Rel(claude, github, "HTTPS")
  UpdateRelStyle(claude, github, $offsetX="-100", $offsetY="-260")
  Rel(claude, litellm, "HTTP")
  UpdateRelStyle(claude, litellm, $offsetX="230", $offsetY="-330")
  Rel(wfmcp, wfsvc, "sidecar invoke")
  UpdateRelStyle(wfmcp, wfsvc, $offsetX="60", $offsetY="-330")
  Rel(daprmcp, redis, "Dapr state API")
  UpdateRelStyle(daprmcp, redis, $offsetX="150", $offsetY="-40")
  Rel(wfsvc, zipkin, "OTLP spans")
  UpdateRelStyle(wfsvc, zipkin, $offsetX="-190", $offsetY="-70")
  Rel(obsmcp, zipkin, "HTTP read")
  UpdateRelStyle(obsmcp, zipkin, $offsetX="-230", $offsetY="-560")
  Rel(obsmcp, loki, "HTTP read")
  UpdateRelStyle(obsmcp, loki, $offsetX="290", $offsetY="-500")
```

## Reading notes

- **workflow-svc is the only engine host**: all five cron-sibling scan engines (watch, chain, cron,
  discover, sched) run inside workflow-svc on the `workflow-cron-tick` Dapr binding (60-second
  interval). No other service writes `watch:*`, `chain:*`, or `cron:*` registry keys.
- **Agent fleet shares a pattern**: each agent service (`claude-agent`, `openhands-agent`, etc.)
  implements the same `IAgentRunner` port over its own CLI/subprocess, and registers the shared
  `POST /workflow` babysitter endpoint (which writes a `watch:sub` row before forwarding). The fleet
  is extensible: adding a new agent is one new app + one `run-*` activity registration in
  workflow-svc. Only the four most common agents are shown; pi-agent, kimi-agent, and others follow
  the same shape.
- **Redis is the single shared store**: the flat keyspace (no per-app prefix — `keyPrefix: none`)
  lets any service read each other's registry keys. Single-writer per prefix is the structural
  invariant: only workflow-svc writes `watch:*`/`chain:*`/`cron:*`/`wf:*`; agents write `run:*`.
- **MCP servers are agent-runtime dependencies**: workflow-mcp (workflow orchestration), dapr-mcp
  (state/pub-sub/actor inspection), and obs-mcp (traces/logs/run-ledger) are wired into every
  agent's Claude session via `.mcp.json`. A downed MCP server silently removes those tools from the
  agent — observability is not the only casualty.
- **obs-mcp has no Dapr sidecar**: it reads Zipkin (HTTP) and the run ledger (filesystem) directly;
  it is therefore absent from the Kubernetes deployment and only available in Docker/local. Its
  `--app-port` is an MCP SSE listener, not a sidecar port.
- **Dapr control plane** (placement scheduler) is Helm-managed separately from the app images.
  `actorStateStore: "true"` on the Redis component is load-bearing for Dapr Workflows, which run
  on the actor runtime.
