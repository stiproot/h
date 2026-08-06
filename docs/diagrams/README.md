# Diagrams — the visual communication layer

The canonical mermaid diagrams of h's architecture and interactions. Their job is
COMMUNICATION: when a change alters an interaction one of these models, the diagram is updated
in the same change, and the diff of the diagram IS the explanation — reviewable in the PR,
readable on any device (GitHub and IDEs render the fences natively), renderable to an image
for chat.

The protocol lives in the `diagrams` skill (`.claude/skills/diagrams/` — h's where-and-when
policy), composed with the `generated-diagrams` plugin skill (code-comprehension plugin —
the toolkit mechanics). In short:

- **Sources are the truth** — one `<name>.md` per diagram here, a mermaid fence plus a short
  prose frame and reading notes. No duplicate copies elsewhere; other docs link here.
- **Render to images on demand** — via the `generated-diagrams` plugin skill's `render.sh`
  (`bash "${CLAUDE_PLUGIN_ROOT}/skills/generated-diagrams/scripts/render.sh" docs/diagrams
  docs/diagrams/rendered`, or a single doc as the first arg; no plugin: `bunx -p
  @mermaid-js/mermaid-cli mmdc --quiet -i <doc.md> -o rendered/<name>.png --scale 2
  --backgroundColor white`) → `docs/diagrams/rendered/<name>.png` (gitignored; mermaid-cli
  runs ephemerally via bunx/npx — nothing to install).
- **Update-with-the-change** — same rule as the cookbook: a stale diagram is worse than none.

## Naming — the kind lives in the file name

`<scope>-<kind>.md`, where `<kind>` names the diagram type so files differentiate at a
glance: `-sequence`, `-class` (UML class / C4 code, mermaid `classDiagram`),
`-c4-component`, `-uml-component`, `-c4-container`, `-c4-context`, `-state`. Sequence and
class diagrams are the primary kinds — reach for those first; the others earn their place
when structure (not interaction) is the question. A `-class` doc is GENERATED from the AST
(TS and Python extractors — the `@stiproot/code-comprehension` package's `gen-code-diagram
--dir docs/diagrams`; drift is a lint failure via `--check`) — never hand-drawn;
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
| [workflow-svc-class](./workflow-svc-class.md) | class, **generated** (Schema structs) | The engine spine: the five cron-siblings as row models + pure `decide` engines over the shared tick, the `Trigger` fire descriptor every carrier embeds/projects, the invoker/source-reader ports |
| [workflow-svc-tick-sequence](./workflow-svc-tick-sequence.md) | sequence | One workflow-cron-tick: CAS gate → due-schedule fires (watch-before-fire) → the five scans' shared shape (rows → observe → pure decide → epoch-fenced act), each failure isolated to its report |
| [chain-run-engine-sequence](./chain-run-engine-sequence.md) | sequence | The chain engine's stage progression on the tick: registration → activation gates (after/notBefore) → stage fire → observe every current-stage member → join → captures into chain data → next stage → loop-until-clean → D6 atomic teardown |
| [cron-siblings-state](./cron-siblings-state.md) | state | The five cron-sibling engine rows' lifecycles side-by-side: watch (scheduling→watching→finalized), chain (scheduling→running→finalized), recur cron (active→inactive), discovery cron (active→inactive), scheduled-fire (armed→fired/expired/disarmed) |
| [system-c4-context](./system-c4-context.md) | C4 context | h as a black box: the operator, the h runtime, and the external systems it integrates with (GitHub, LiteLLM proxy, Zipkin, Loki+Alloy) |
| [system-c4-container](./system-c4-container.md) | C4 container | The SERVICE substrate's topology: workflow-svc (engines), agent fleet (claude/openhands/codex/dapr-agent), three MCP servers, Redis/Dapr, and the observability spine |
| [execution-substrates-c4-container](./execution-substrates-c4-container.md) | C4 container | One composition, two executors: the shared `h` CLI front door, the LOCAL substrate (runner + agent CLI children, no infrastructure) beside the SERVICE substrate, what `workflow-core` makes structurally symmetric, and the edge by which a local agent fires durable work |
| [local-run-sequence](./local-run-sequence.md) | sequence | One `--local` run end to end: render → job on stdin → step walk (token resolution, refused activities, worktree, setup-skip, agent spawn, contract validation) → envelope; plus the Ctrl-C reap path |
| [cost-accounting-sequence](./cost-accounting-sequence.md) | sequence | An agent run's usage from CLI stream events → run-ledger mirror → watch-scan tallyCost → watch:ledger day rows → usage-limited auto-deny → daily-budget fence |

## Planned (add as the need arises, one per interaction that keeps needing explaining)
