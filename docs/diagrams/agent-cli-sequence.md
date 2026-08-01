# agent-cli — sequence diagram (one agent run)

One invocation through `packages/js/agent-cli`, from the consumer's `invoke(params)` to the
`InvocationResult` it always gets back: env validation, the strategy build (with claude's
LiteLLM preflight), the spawned subprocess with its three concurrent drains, the timeout
path that keeps partial events, the reaper's group-kill guarantee, and the pure
build-and-classify tail. The [C4 component diagram](./agent-cli-c4-component.md) is the
structural view of the same machinery; the [class diagram](./agent-cli-class.md) has the
exact member shapes.

```mermaid
sequenceDiagram
  autonumber
  participant Runner as Agent service runner (consumer)
  participant Invoker as AgentInvoker (invoker.ts)
  participant RunProc as Process runner (run-process.ts)
  participant Strategy as AgentStrategy (claude / codex / openhands / pi)
  participant LiteLLM as LiteLLM proxy (optional)
  participant CLI as Agent CLI subprocess
  participant Reaper as Reaper (reaper.ts)
  participant Builder as Result builder (parse-stream + classify-stop, pure)

  Runner->>+Invoker: invoke(params)
  Note over Invoker: merge params.env over process.env<br/>extract AgentEnv (AGENT_ENV_KEYS)
  Invoker->>+RunProc: runAgentProcessEffect(strategy, request)

  RunProc->>+Strategy: prepareEnvironment?(request) then validateEnvironment(effectiveEnv)
  Strategy-->>-RunProc: null (ok) — or an InvocationResult refusal
  opt env refusal
    RunProc-->>Invoker: InvocationResult (failed — nothing spawned)
  end

  RunProc->>+Strategy: buildInvocation(request)
  opt claude strategy with llmConfig
    Strategy->>+LiteLLM: GET /models — is the model served?
    LiteLLM-->>-Strategy: served — or LiteLlmError (the ONLY error-channel failure)
  end
  Strategy-->>-RunProc: PreparedAgentInvocation (command, args, stdin, parser, cleanup?)

  RunProc->>CLI: spawn detached group (sudo -u SUB_AGENT_UID in container mode + per-uid bun cache)
  activate CLI
  RunProc->>Reaper: registerLiveRun(pid, uid) + scope finalizer
  activate Reaper

  par await exit
    CLI--)RunProc: exit code / signal (or never — timeout wins)
  and drain stdout
    loop each complete JSONL line
      CLI--)RunProc: stdout line
      RunProc->>Builder: parseStreamLine → events[]
      RunProc--)Runner: onEvent(event) → run ledger events.jsonl
    end
  and drain stderr
    CLI--)RunProc: stderr (collected to one string)
  end

  alt wall-clock timeout (request.timeout)
    Note over RunProc: interruption closes the scope — exit resolved as 124<br/>collected events are KEPT (partial usage)
    RunProc->>Reaper: scope-close finalizer
    Reaper->>CLI: SIGTERM the process GROUP (as the dropped uid on the sudo path)
  else normal exit
    RunProc->>Reaper: scope-close finalizer — group-kill anyway
    Reaper->>CLI: SIGTERM group (reaps background children the CLI left running)
  end
  deactivate CLI
  deactivate Reaper

  RunProc->>+Strategy: extractSessionId(events) / extractMetrics(events, request)
  Strategy-->>-RunProc: metrics (usage, cost, model — may VETO success)
  RunProc->>+Builder: buildInvocationResult(events, stderr, exit, signal, metrics)
  Note over Builder: classifyStop(exit, signal, stderr,<br/>result event text, 429-retry count) → stopReason
  Builder-->>-RunProc: InvocationResult (+ stopReason, costPartial?)
  RunProc-->>-Invoker: InvocationResult (prepared.cleanup() ensured on EVERY path)
  Invoker-->>-Runner: InvocationResult (spawn failures folded to exit 1 / 127)
```

## Reading notes

- **The consumer always gets an `InvocationResult`** — the error channel carries only
  `LiteLlmError` (step 8). Timeouts become structured exit-124 results (steps 17–18), spawn
  failures exit-1, command-not-found exit-127 (step 26): the runner never needs a catch-all.
- **A timeout keeps the evidence** (steps 17–18): it is handled where `streamEvents` is
  still in scope, so a throttle-stretched run still reports partial usage and its 429 retry
  count — which is how `classifyStop` (steps 23–24) can call it `usage-limited` rather than
  a bare `timeout`. `stopReason` is orthogonal to `success`; the watcher's fallback/auto-deny
  machinery keys on it downstream.
- **No orphan outlives the run** (steps 11, 17–20): the reaper group-kills on EVERY scope
  close — including exit 0, where the platform's own release skips cleanup — and the
  process-exit hook reaps live groups on app death, so a background child the CLI left
  running can't linger and bill invisibly.
- **All per-agent knowledge sits in the `Strategy` lane** (steps 3–4, 6–9, 21–22): validate,
  build, extract. The other lanes are agent-agnostic machinery — adding an agent touches
  only that lane (the `integrate-agent` seam).
- **The package never persists anything**: events flow OUT through `onEvent` (step 15); the
  consumer's run ledger owns the write.
