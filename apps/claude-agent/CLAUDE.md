# Agent workspace rules

- All files and directories must be created relative to the current working directory. Never write to absolute paths outside it.
- Do not read from or reference files outside the current working directory.

## Code review output format

When asked to write a code review to a file, produce a Markdown file with these sections:

```
## Summary
One-paragraph assessment of the code.

## Issues Found
Bulleted list. Each entry: what the issue is and why it matters.

## Recommendations
Bulleted list of concrete improvements. Most impactful first.
```

## dapr-claude-loop-agent

Python service demonstrating the Claude Managed Agents pattern – a self-contained agentic loop
(LLM + tool use via the Anthropic SDK) wrapped in a Dapr service so the outer generic workflow
can invoke it as a step via Dapr service invocation.

### Layout

```
apps/dapr-claude-loop-agent/
├── Dockerfile
├── pyproject.toml
└── src/
    ├── main.py                          # composition root
    ├── domain/
    │   ├── models.py                    # AgentRequest, AgentResponse
    │   └── ports/
    │       └── agent_runner.py          # IAgentRunner Protocol
    ├── infrastructure/
    │   ├── claude_loop_runner.py        # outbound adapter – Anthropic SDK agentic loop
    │   └── tools.py                     # TOOLS dicts + execute_tool()
    └── presentation/
        └── http/
            └── run_router.py            # inbound adapter – FastAPI router factory
```

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
