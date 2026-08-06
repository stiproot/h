# direct-run-sequence — a workflow on the direct substrate, end to end

What happens between `h workflow run <template> --direct -p …` and the answer on stdout: the CLI
renders the template locally, hands the definition to the `h-direct` runner on stdin, and the
runner walks the steps in-process — resolving tokens, cutting worktrees, spawning agent CLIs as
child processes, and validating each output contract. No Dapr, no services, no registries.

The service-substrate counterpart is [implement-pr-run-sequence](./implement-pr-run-sequence.md)
(the same composition, fired at workflow-svc and supervised by the watcher). What one agent
invocation does inside `agent-cli` — shared verbatim by both substrates — is
[agent-cli-sequence](./agent-cli-sequence.md). The structural view of both substrates is
[system-c4-container](./system-c4-container.md).

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator
  participant Cmd as h workflow run (commands/workflow.py)
  participant Helm as helm (subprocess)
  participant Runner as h-direct bin.ts
  participant Exec as runWorkflow (domain/execute.ts)
  participant Core as workflow-core (shared semantics)
  participant Agent as AgentPort → agent-cli
  participant CLI as agent CLI child process

  Op->>+Cmd: --direct -p task=… [--agent a --agent b] [--with-setup]
  Note over Cmd: refuse --cron/--watch/--at/--in/--fallback-*/--fresh/--via<br/>BEFORE rendering — nothing runs when a flag needs an engine

  Cmd->>+Helm: render template (publish mode)
  Helm-->>-Cmd: definition {params, steps, outputs}
  opt --agent roster
    Cmd->>Cmd: panelize → parallel group + pinned judge
  end

  Cmd->>+Runner: spawn `node bin.js`, job JSON on stdin<br/>(env = shell, .env filling gaps)
  Runner->>Runner: Schema.decodeUnknown(DirectJob) — malformed job fails by field name
  Runner->>+Exec: runWorkflow(job)

  loop each step (or parallel group, fanned out together)
    Exec->>+Core: resolveTokenString(activity) · resolveRefs(input)
    Core-->>-Exec: activity name + resolved input (unresolved token throws)
    alt activity is refused (register-cron, write-wf-row, run-itest, service-only agent)
      Exec-->>Exec: FAIL the step, naming the engine/registry/cluster it needs
    else builtin create-worktree
      Exec->>Exec: git worktree off the INVOKING checkout (idempotent)
    else builtin setup
      Exec-->>Exec: skipped unless --with-setup (it provisions the operator's own HOME)
    else run-<agent>
      Exec->>+Agent: AgentRunRequest {agent, task, cwd, model, timeout}
      Agent->>Agent: startRunLedger (run-ledger pkg) — same artifacts as a service run
      Agent->>+CLI: spawn, stream events → ledger
      CLI-->>-Agent: stdout + usage + stopReason
      Agent-->>-Exec: AgentRunReport (a failure is a REPORT, never a throw)
      Exec->>+Core: applyOutputContract(result, step.outputContract)
      Core-->>-Exec: validated `structured`, or FAIL the step
    end
  end

  Exec-->>-Runner: envelope {ok, group, results[, failedStep, error]}
  Runner-->>-Cmd: one JSON line on stdout (progress went to stderr, live)
  Cmd-->>-Op: final step output — exit 1 on a failed step

  Note over Op,CLI: Ctrl-C → SIGINT → fiber interrupt → scope close →<br/>agent-cli's reaper GROUP-KILLS every CLI. An orphan bills invisibly.
```

## Reading notes

- **The wire is the definition** (step 8). What crosses into the runner is the same
  `{params, steps}` artifact the service path would have POSTed — which is what makes the two
  substrates auditably symmetric rather than symmetric by claim.
- **Refusals happen twice, both loud, both before work.** Machinery flags are refused CLI-side
  before the render (step 2); engine/registry/cluster ACTIVITIES are refused per step (step 13).
  Neither is a skip: a silently-skipped `register-cron` would report a recurrence that was never
  armed, and a skipped `run-itest` a gate that never ran.
- **Steps 11–12 are the parity seam.** Token/`$ref` resolution and contract validation are called
  out of `workflow-core`, the same module `generic.workflow.ts` and the run-* activities use. The
  one deliberate difference: engine-side each run-* ACTIVITY applies the contract; here the
  EXECUTOR does, because `AgentPort` is contract-agnostic. Same validator, same consequence.
- **A failed agent run is a report, not a throw** (step 19) — that is what lets `h delegate` keep
  three answers when the fourth agent is missing. The executor converts it to a step failure;
  `runDelegate` does not.
- **No engine brackets.** `generic.workflow.ts` wraps a run in `write-wf-row(running/done)` and an
  `armCron` closing bracket. Neither appears here: both write registries this substrate does not
  have, and the activities behind them are refused by name.
- **The reaper is load-bearing, not incidental** (final note). The interrupt path was validated by
  killing a live run and confirming zero surviving CLI processes — an orphaned agent keeps working
  and keeps billing with nothing recording it.
- **A chain adds one outer loop** around this whole diagram: `runChain` walks stages, runs each
  stage's members through `runWorkflow` concurrently, threads captures/inputs into the chain data
  via `contractFor`, and re-enters at the review stage for `loop-until-clean`. Its stage arithmetic
  and threading contracts come from `workflow-core` too; the durable `decide()` engine does not,
  because it exists only for runs that outlive the process watching them.
