# agent-cli — component diagram (C4 level 3)

Inside `packages/js/agent-cli`, the shared library every agent SERVICE uses to drive its
CLI subprocess. One `AgentStrategy` per CLI carries all per-agent knowledge; everything else
is agent-agnostic machinery. The consumer (an agent service's runner, e.g. claude-agent's)
provides the Effect platform layers and receives both the final `InvocationResult` and the
live event stream (which it feeds to its run ledger).

```mermaid
C4Component
  title agent-cli components (inside an agent service process)
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

  Container(runner, "Agent service runner", "agent-server + runner.ts", "owns the run ledger")
  System_Ext(clisub, "Agent CLI subprocess", "claude / codex / openhands / pi binary")
  System_Ext(litellm, "LiteLLM proxy", "optional model gateway")

  Container_Boundary(agentcli, "agent-cli") {
    Component(invoker, "AgentInvoker port", "invoker.ts", "invoke(params) → InvocationResult")
    Component(runproc, "Process runner", "run-process.ts", "spawn + pipeline + in-scope timeout")
    Component(strategies, "Agent strategies ×4", "claude/codex/openhands/pi.ts", "ALL per-CLI knowledge")
    Component(builder, "Result builder", "parse-stream.ts, pure", "events + exit → result")
    Component(classifier, "Stop classifier", "classify-stop.ts, pure", "WHY the run stopped")
    Component(reaper, "Reaper", "reaper.ts", "group-kill: scope close, app death")
    Component(shape, "Event-shape observer", "event-shape.ts", "observed vocab; tool tally")
    Component(preflight, "LiteLLM preflight", "lib/litellm.ts", "model served? pre-spawn")

    Rel(invoker, runproc, "runAgentProcessEffect")
    Rel(runproc, strategies, "build / parse / extractMetrics")
    Rel(strategies, preflight, "adaptToLiteLlm")
    Rel(runproc, builder, "events + exit")
    Rel(builder, classifier, "classifyStop")
    Rel(runproc, reaper, "register; kill-group finalizer")
    UpdateRelStyle(runproc, reaper, $offsetX="30", $offsetY="40")
  }

  Rel(runner, invoker, "invoke(params)")
  Rel(runner, shape, "toolCallTallyFor")
  UpdateRelStyle(runner, shape, $offsetX="-160", $offsetY="60")
  Rel(preflight, litellm, "GET /models", "HTTP")
  Rel(runproc, clisub, "spawn + signal; JSONL stream + exit back", "process group")
  UpdateRelStyle(runproc, clisub, $offsetX="-70", $offsetY="-20")
  Rel(runproc, runner, "onEvent → events.jsonl", "run ledger")
  UpdateRelStyle(runproc, runner, $offsetX="40", $offsetY="20")
  Rel(reaper, clisub, "SIGTERM/KILL group (sudo for dropped uid)")
  UpdateRelStyle(reaper, clisub, $offsetX="-40", $offsetY="-60")
```

## Reading notes

- **All agent-specific knowledge lives in one component** — the strategies. Adding an agent is
  one new `AgentStrategy` (+ a Live layer line in invoker.ts); nothing else changes. This is
  the seam the `integrate-agent` skill builds on.
- **The runner owns the subprocess lifecycle end to end**: spawn (with the container-mode sudo
  uid drop), the timeout (handled where the collected events are still in scope — a timed-out
  run still reports partial usage), and teardown via the reaper (no orphan can outlive its run
  and bill invisibly).
- **Two pure leaves** — result builder and stop classifier — carry the accounting-critical
  logic (partial results, usage-limit detection) and are unit-tested without any process.
- **The package never touches the ledger or the statestore**: events flow OUT through the
  consumer's `onEvent`; the consumer (agent-server's runner) owns persistence. That keeps
  agent-cli dependency-free of h's runtime.
