# cost-accounting-sequence — agent run usage to day ledger and budget fence

How a single agent run's cost flows from CLI stream events all the way to the daily-budget fence:
the agent-cli metrics extraction, the run-ledger statestore mirror, the watch-scan cost tally, and
the two containment actions (usage-limited auto-deny and the daily-budget fence).

Source files: `packages/js/agent-cli/src/agents/claude.ts`, `packages/js/agent-cli/src/agents/classify-stop.ts`,
`packages/js/agent-server/src/run-ledger.ts`, `packages/js/engine-core/src/watch-scan.ts`,
`packages/js/engine-core/src/exec-policy.ts`.

```mermaid
sequenceDiagram
  autonumber
  participant CLI as claude CLI process
  participant Inv as agent-cli InvokerStream
  participant Leg as run-ledger (agent-server)
  participant SS as Dapr statestore (Redis)
  participant Scan as watch-scan executeFinalize
  participant Pol as exec-policy pure functions

  Note over CLI,Leg: Phase 1 — stream (per JSONL line, fire-and-forget)
  loop each JSONL line from claude CLI stdout
    CLI->>Inv: raw JSONL line (assistant / tool_use / result / system events)
    Inv->>Leg: onEvent(parsed event) — fire-and-forget (chain of appended promises)
    Leg->>Leg: appendEvent(events.jsonl) + observeShape tally
    Note over Leg: best-effort — failure swallowed, next append still runs
  end

  Note over Inv,Leg: Phase 2 — post-run metrics extraction
  Inv->>Inv: extractMetrics(allStreamEvents)
  alt result event present
    Inv->>Inv: normalizeClaudeModelUsage(resultEvent.modelUsage) → costUsd tokens model
  else no result event (timeout / kill mid-stream)
    Inv->>Inv: foldPartialClaudeUsage(events) → costPartial:true costUsd-best-effort
  end
  Inv->>Inv: classifyStop(exit signal stderr resultEvent) → StopReason
  Note over Inv: positive-match-only: usage-limited / timeout / failed / completed
  Inv->>Inv: buildInvocationResult() → InvocationResult{costUsd stopReason}

  Note over Leg,SS: Phase 3 — ledger mirror
  Inv->>+Leg: finish(RunOutcome{status costUsd costPartial stopReason model turns})
  Leg->>Leg: await pendingAppends (events.jsonl complete before summary)
  Leg->>Leg: buildRunSummary() → RunSummary{runId costUsd stopReason agentId}
  Leg->>Leg: writeRunFiles(dir summary.json output.txt)
  Leg->>+SS: mirrorToStatestore → HTTP POST /v1.0/state/statestore
  SS-->>-Leg: 200 (key: run:<group>:<agentId>:<ts> + runs:index updated)
  Note over Leg: best-effort: statestore failure swallowed independently
  Leg-->>-Inv: RunSummary

  Note over Scan,Pol: Phase 4 — watch-scan finalization (next tick after run completes)
  Scan->>+SS: getRow(run:<instanceId>:*) × all mirrors for this instance
  SS-->>-Scan: RunMirrorMeta[] {costUsd stopReason agentId kind}
  Scan->>Scan: tallyCost — sum costUsd exclude kind="activity"
  alt zero matching mirrors
    Note over Scan: costGap:true — never a silent $0 (ledger gap not a zero spend)
  else some mirrors missing costUsd
    Note over Scan: gapRuns++ per mirror with costUsd null or 0
  end
  Scan->>+SS: saveFenced(watch row{status:finalized outcome costUsd costGap})
  SS-->>-Scan: saved
  Scan->>SS: bumpLedger(watch:ledger:<date> {costUsd costByAgent costGapRuns})

  alt outcome = usage-limited (stopReason on any mirror)
    Scan->>Scan: executeAutoDeny
    Scan->>Pol: executorFromAgentId(agentId) → executor shortname
    Scan->>+SS: get(exec:config)
    SS-->>-Scan: ExecPolicy
    Scan->>Pol: mergeAutoDeny(policy executor nowIso DEFAULT_AUTO_DENY_MS=6h)
    Note over Pol: no-op if executor already has an operator entry (never downgrade)
    Scan->>SS: save(exec:config) — DeniedEntry{reason:usage-limited until:now+6h}
    Note over Scan: same-agent deferred continuation is refused at the activity-registry gate
  end

  Note over Scan,Pol: Always: daily-budget fence check
  Scan->>+SS: get(exec:config) budgets table
  SS-->>-Scan: {executor: dailyBudgetUsd}
  Scan->>SS: getLedger(watch:ledger:<date>) → costByAgent subtotals
  Scan->>Pol: spend >= budget?
  alt daily spend >= budget for this executor
    Scan->>Pol: mergeBudgetDeny(policy executor nowIso)
    Scan->>SS: save(exec:config) — DeniedEntry{reason:cost-budget until:endOfUtcDay}
    Note over Scan: expires at next UTC midnight — h agents allow lifts it early
  end
```

## Reading notes

- **Fire-and-forget event appends** (step 3): `onEvent` runs synchronously on the invoker's
  callback but each `events.jsonl` write is chained as a promise — `finish()` awaits the whole chain
  so the file is complete before `summary.json` lands. Failures are individually swallowed; a failed
  append never blocks the next line.
- **Partial path** (step 8): when the process is killed or times out before a `result` event
  arrives, `foldPartialClaudeUsage` folds per-call model usage off `assistant` events. The
  resulting `costPartial: true` flag on the ledger record signals "cumulative-up-to-the-stop, not a
  final accounting" — a partial run with no observable cost still reads as a cost gap, not $0.
- **classifyStop is positive-match-only** (step 9): it returns `usage-limited` ONLY when the exit
  code, signal, or a parsed stream event positively matches; unknown exits default to `failed` or
  `completed`, never inferred as usage-limited. Context-window exhaustion is explicitly excluded.
- **Statestore mirror is best-effort** (step 16 note): the `mirrorToStatestore` call is independently
  `Effect.ignore`d so a Redis or Dapr sidecar outage never breaks the run. The on-disk
  `summary.json` + `events.jsonl` are the source of truth; the mirror is the queryable index.
- **costGap invariant** (step 22): zero matching `run:<instanceId>:*` mirrors is ALWAYS flagged,
  never a silent $0. A gap means the mirror didn't land — the ledger is incomplete, not the cost.
  Gap-run count (`gapRuns`) accumulates separately so the operator can distinguish "truly zero cost"
  from "unknown cost."
- **auto-deny no-downgrade guarantee** (step 27 note): `mergeAutoDeny` checks whether the executor
  already has an operator entry (reason `"operator"`, never-expiring). If so, it is a no-op — the
  engine never replaces a permanent deny with an expiring one. `h agents allow` is the only path
  that lifts either kind.
- **Budget fence UTC reset** (step 33 note): the expiring `DeniedEntry` has `until` set to the
  last millisecond of the current UTC day (midnight). The fence self-lifts at the start of the next
  UTC day with no engine action; `h agents allow` lifts it early.
