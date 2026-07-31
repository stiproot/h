# Diagrams — the visual communication layer

The canonical mermaid diagrams of h's architecture and interactions. Their job is
COMMUNICATION: when a change alters an interaction one of these models, the diagram is updated
in the same change, and the diff of the diagram IS the explanation — reviewable in the PR,
readable on any device (GitHub and IDEs render the fences natively), renderable to an image
for chat.

The protocol lives in the `diagrams` skill (`.claude/skills/diagrams/`). In short:

- **Sources are the truth** — one `<name>.md` per diagram here, a mermaid fence plus a short
  prose frame and reading notes. No duplicate copies elsewhere; other docs link here.
- **Render to images on demand** — `scripts/render-diagrams.sh [<name>]` →
  `docs/diagrams/rendered/<name>.png` (gitignored; the tool provisions itself into the
  gitignored `.diagram-tools/`).
- **Update-with-the-change** — same rule as the cookbook: a stale diagram is worse than none.

## The set

| Diagram | Kind | Models |
| --- | --- | --- |
| [implement-pr-run](./implement-pr-run.md) | sequence | The flagship workflow end to end: fire → watch registration → worktree/setup → gated agent steps → the itest gate → create-pr → arm-revise-pr, with the watcher engine's supervision lane |
| [agent-cli-components](./agent-cli-components.md) | C4 component | Inside `packages/js/agent-cli`: the AgentInvoker port, process runner, the four strategies (the one per-agent seam), pure result/classifier leaves, the reaper, and the consumer/CLI/LiteLLM collaborators |
| [agent-cli-code](./agent-cli-code.md) | C4 code (classDiagram) | The `AgentStrategy` contract + the types that flow through a run (`InvocationResult`, `StopReason`, `PreparedAgentInvocation`) — the exact shapes an `integrate-agent` addition is written against |

## Planned (add as the need arises, one per interaction that keeps needing explaining)

- **chain-run** (sequence) — `h chain run` registration → stage progression on the tick →
  captures/inputs threading → loop-until-clean → atomic teardown
- **cron-siblings** (sequence or state) — recur vs discovery vs one-shot sched: who fires,
  who disarms, the goal handshake
- **system-context / containers** (C4) — the service topology: workflow-svc, the agent fleet,
  the MCP servers, Redis/Dapr, the observability spine
- **cost-accounting** (sequence) — an agent run's usage from CLI events to the day ledger and
  the budget fence
