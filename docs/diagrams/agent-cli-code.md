# agent-cli — code diagram (C4 level 4)

Zooming into the load-bearing seam of `packages/js/agent-cli`: the `AgentStrategy` contract
and the types that flow through a run. Deliberately NOT an exhaustive member dump — only the
members that tell the story (the [component diagram](./agent-cli-components.md) is the level
above; this level exists because every agent integration is written against exactly these
shapes — the `integrate-agent` skill's "CLI strategy" piece).

```mermaid
classDiagram
  direction LR

  class AgentInvoker {
    <<Effect service>>
    +invoke(params) Effect~InvocationResult~
  }

  class RunProcess {
    <<module run-process.ts>>
    +runAgentProcessEffect(strategy, request)
  }

  class Reaper {
    <<module reaper.ts>>
    +registerLiveRun(pid, subAgentUid) LiveRun
    +killRunGroup(run, signal)
    +reapAll(signal)
  }

  class ParseStream {
    <<module parse-stream.ts>>
    +buildInvocationResult(events, exit, metrics)
  }

  class ClassifyStop {
    <<module classify-stop.ts>>
    +classifyStop(input) StopReason
  }

  class AgentStrategy {
    <<interface>>
    +type AgentType
    +validateEnvironment(effectiveEnv, processEnv)
    +prepareEnvironment(request) env
    +buildInvocation(request) Effect~PreparedAgentInvocation~
    +extractSessionId(events)
    +extractMetrics(events, request) partial result
    +tallyToolCalls(current, event) number
  }

  class claudeStrategy {
    stream-json; partial-usage fold on timeout
  }
  class codexStrategy {
    exec --json; tokens only, never cost
  }
  class openhandsStrategy {
    --file JSONL; error-event vetoes success
  }
  class piStrategy {
    stdin -p; no usage in stream
  }

  class AgentInvocationRequest {
    +taskPrompt, cwd, env, timeout
    +model, llmConfig, onEvent
  }

  class PreparedAgentInvocation {
    +command, args, stdinInput
    +streamParser AgentStreamParser
    +cleanup()
  }

  class InvocationResult {
    +success, exitCode, stdout
    +stopReason StopReason
    +tokenUsage, modelUsage, costUsd
    +costPartial boolean
  }

  class StopReason {
    <<union>>
    completed | usage-limited | timeout | failed
  }

  claudeStrategy ..|> AgentStrategy
  codexStrategy ..|> AgentStrategy
  openhandsStrategy ..|> AgentStrategy
  piStrategy ..|> AgentStrategy

  AgentInvoker --> RunProcess : delegates
  AgentInvoker --> AgentInvocationRequest : merges env into
  RunProcess --> AgentStrategy : validate / build / extract
  AgentStrategy --> PreparedAgentInvocation : builds
  RunProcess --> Reaper : LiveRun register + kill-group
  RunProcess --> ParseStream : events + exit
  ParseStream --> ClassifyStop : exit, signal, stderr, retries
  ParseStream --> InvocationResult : produces
  ClassifyStop --> StopReason : yields
```

## Reading notes

- **`AgentStrategy` is the whole integration surface**: the four realizations differ ONLY in
  what each note says — stream shape, invocation flags, and what usage/cost their CLI reports.
  `integrate-agent` adds a fifth realization; nothing above the interface changes.
- **`extractMetrics` is where accounting honesty lives**: claude's folds partial per-call
  usage when the terminal result event is missing (`costPartial: true`); codex/pi/openhands
  return what their CLIs actually expose — absence stays absent, never a fabricated zero.
- **`StopReason` is orthogonal to `success`** — a usage-limited run can exit 0; the
  classifier reads exit + signal + stderr + the stream's rate-limit retry count, and the
  watcher's fallback/auto-deny machinery keys on it downstream.
- **`PreparedAgentInvocation.cleanup`** runs on every exit path (the openhands temp task
  file); the reaper covers the PROCESS side of the same promise.
