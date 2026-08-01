# Diagrams — the visual communication layer

The canonical mermaid diagrams of h's architecture and interactions. Their job is
COMMUNICATION: when a change alters an interaction one of these models, the diagram is updated
in the same change, and the diff of the diagram IS the explanation — reviewable in the PR,
readable on any device (GitHub and IDEs render the fences natively), renderable to an image
for chat.

The protocol lives in the `diagrams` skill (`.claude/skills/diagrams/`). In short:

- **Sources are the truth** — one `<name>.md` per diagram here, a mermaid fence plus a short
  prose frame and reading notes. No duplicate copies elsewhere; other docs link here.
- **Render to images on demand** — `tools/diagrams/render.sh [<name>]` →
  `docs/diagrams/rendered/<name>.png` (gitignored; the toolkit provisions mermaid-cli into
  its gitignored `.deps/` via bun).
- **Update-with-the-change** — same rule as the cookbook: a stale diagram is worse than none.

## Naming — the kind lives in the file name

`<scope>-<kind>.md`, where `<kind>` names the diagram type so files differentiate at a
glance: `-sequence`, `-class` (UML class / C4 code, mermaid `classDiagram`),
`-c4-component`, `-uml-component`, `-c4-container`, `-c4-context`, `-state`. Sequence and
class diagrams are the primary kinds — reach for those first; the others earn their place
when structure (not interaction) is the question. A `-class` doc is GENERATED from the AST
(TS and Python extractors, `tools/diagrams/`; drift is a lint failure) — never hand-drawn;
`-sequence` docs are hand-authored and verified against the code (no AST holds a runtime
interaction).

## The set

| Diagram | Kind | Models |
| --- | --- | --- |
| [implement-pr-run-sequence](./implement-pr-run-sequence.md) | sequence | The flagship workflow end to end: fire → watch registration → worktree/setup → gated agent steps → the itest gate → create-pr → arm-revise-pr, with the watcher engine's supervision lane |
| [agent-cli-sequence](./agent-cli-sequence.md) | sequence | One agent run through `packages/js/agent-cli`: invoke → validate → build (LiteLLM preflight) → spawn → the three concurrent drains → timeout-keeps-partial-events → reaper group-kill → build + classify |
| [agent-cli-c4-component](./agent-cli-c4-component.md) | C4 component | Inside `packages/js/agent-cli`: the AgentInvoker port, process runner, the four strategies (the one per-agent seam), pure result/classifier leaves, the reaper, and the consumer/CLI/LiteLLM collaborators |
| [agent-cli-uml-component](./agent-cli-uml-component.md) | UML component (classDiagram encoding) | The interface-centric view: what each agent-cli component PROVIDES vs REQUIRES (`IAgentStrategy` as the integration seam; `IEventSink` inverting the ledger dependency; `IPlatform` as the only outward requirement) |
| [agent-cli-class](./agent-cli-class.md) | class (C4 code level), **generated** | The `AgentStrategy` contract + the types that flow through a run (`InvocationResult`, `StopReason`, `PreparedAgentInvocation`) — the exact shapes an `integrate-agent` addition is written against |
| [h-cli-class](./h-cli-class.md) | class, **generated** (Python AST) | The `h` command's structure: Typer command groups over the pure core (`chain_expr` grammar types, `overlay`, `panelize`) and the thin adapters (helm subprocess, httpx clients) — composes and registers, never executes |
| [h-cli-chain-run-sequence](./h-cli-chain-run-sequence.md) | sequence | `h chain run` CLI-side: hand-parsed expression → per-member resolve (compose-on-fire, panelize, validate-before-publish) → one `POST /chain/run`; ends where the engine takes over |

## Planned (add as the need arises, one per interaction that keeps needing explaining)

- **chain-run-sequence** — `h chain run` registration → stage progression on the tick →
  captures/inputs threading → loop-until-clean → atomic teardown
- **cron-siblings** (sequence or state) — recur vs discovery vs one-shot sched: who fires,
  who disarms, the goal handshake
- **system-c4-context / -c4-container** — the service topology: workflow-svc, the agent
  fleet, the MCP servers, Redis/Dapr, the observability spine
- **cost-accounting-sequence** — an agent run's usage from CLI events to the day ledger and
  the budget fence
- **workflow-svc-class / -sequence** — the next core component after the cli: the engines'
  decide/scan split and a tick's walk across watch/chain/cron/discover/sched
