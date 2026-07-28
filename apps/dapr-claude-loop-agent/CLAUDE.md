# dapr-claude-loop-agent

Service notes for this app. Relocated 2026-07-28 from `apps/claude-agent/CLAUDE.md`, where it
made up 54 of 74 lines — claude-agent's file is AGENT-FACING workspace steering loaded on every
run, so documenting a different service there taxed every claude-agent run with irrelevant
context (hardening-audit A24).

Python service demonstrating the Claude Managed Agents pattern – a self-contained agentic loop
(LLM + tool use via the Anthropic SDK) wrapped in a Dapr service so the outer generic workflow
can invoke it as a step via Dapr service invocation.

### Layout

```
apps/dapr-claude-loop-agent/
├── Dockerfile
├── pyproject.toml
└── src/
    ├── main.py                          # composition root – registers shared agent-server routes
    └── infrastructure/
        ├── claude_loop_runner.py        # outbound adapter – Anthropic SDK agentic loop (tool-calling)
        └── tools.py                     # search_skills, install_skill, read_skill, write_file
```

This is a **thin** service: its domain contract (`AgentRequest`/`AgentResponse`, the `IAgentRunner`
port) and its `/run` · `/setup` · `/dapr/subscribe` routes come from the shared `agent_server`
package (`packages/py`), so it needs no local `domain/` or `presentation/` layer — only the runner
adapter. Because it has no `domain/`/`presentation/` of its own, it carries no `import-linter`
contract (there is no in-service boundary to guard); the boundaries it does honour live in the
shared package's own layering.

### Local run

```sh
./cli/scripts/run-dapr-claude-loop-agent.sh
```

Registers as Dapr app-id `dapr-claude-loop-agent` on port 8005.

### Docker

```sh
docker compose --profile claude-managed up
```

### Demo workflow (requires workflow + dapr-claude-loop-agent both running)

```sh
./cli/scripts/run-dapr-claude-loop-demo.sh
```

Submits a `run-dapr-claude-loop` step to the generic workflow, which invokes the agent via Dapr
service invocation. The agent runs an agentic tool-use loop and returns a final text response.

### How it fits the stack

The `run-dapr-claude-loop` activity in `apps/workflow-svc/` calls `POST /run` on this service via
Dapr invoke. The service runs its own agentic loop (up to AGENT_MAX_ITERATIONS turns) and returns
an `AgentResult`-compatible JSON response, identical in shape to the other agent services.
