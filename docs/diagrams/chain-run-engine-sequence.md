# chain-run-engine-sequence — chain engine stage progression (one tick)

The ENGINE side of `h chain run`: from the operator's `POST /chain/run` registration through
every cron-tick stage advance, the loop-until-clean body, to terminal finalization. The CLI side
(expression parsing → one `POST /chain/run`) is modeled separately in
[h-cli-chain-run-sequence](./h-cli-chain-run-sequence.md) — this diagram begins where that one ends.

Source files: `packages/js/engine-core/src/chain-scan.ts`,
`chain-engine.ts`, `chain-members.ts`.

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator / h CLI
  participant CS as ChainStore
  participant WS as WorkflowStore
  participant Inv as WorkflowInvoker
  participant Eng as decide() chain-engine
  participant Pub as pub/sub

  Op->>+CS: POST /chain/run — validateChain + getRow(slug)
  Note over CS: epoch bump if slug already exists (fence any in-flight scan)
  CS-->>-Op: saveRow(status:"scheduling" epoch:N cursor:0) + 202 {chainId firing:true}
  Note over Op,CS: Registration is persist-only — stage 0 fires on the NEXT tick (issue #79a)

  loop each cron tick — scanChainsEffect
    CS->>CS: heartbeat + getConfig (kill-switch read)
    CS->>+CS: listRows() → filter status ≠ "finalized"
    CS-->>-CS: active rows

    loop each active chain row
      alt status = "scheduling" — activation branch
        CS->>CS: decideActivation(row nowMs)
        Note over CS: notBefore gate: hold if nowMs < notBefore
        CS->>CS: getRow(row.after) if after set
        alt parent absent
          Note over CS: unknownStreak++ → orphaned after streak limit
          CS->>CS: saveFenced(epoch stamp)
        else parent not finalized
          Note over CS: legitimate hold — no streak bump no budget
        else parent finalized != completed
          CS->>CS: executeFinalize(terminated)
        else parent completed (or no after gate)
          Note over CS: re-stamp startedAt at activation (budget resets — issue #78)
          CS->>+WS: get(member.key) — resolve saved definition
          WS-->>-CS: StoredWorkflow
          CS->>+Inv: invokeWithWatch(member request workspaceId=chainId fresh?)
          Note over Inv: mark-before-fire — watch:sub row written BEFORE invoke
          Inv-->>-CS: instanceId fired
          CS->>CS: saveFenced(epoch status:"running" lastStatus:"SCHEDULED")
        end
      else status = "running" — observe stage
        CS->>+Inv: observeMember × each member of current stage
        Note over Inv: cron member reads wf:<repo>:<slug>:<kind>.resolved (not runtime status)
        Inv-->>-CS: MemberRead[] {runtimeStatus done failed output}
        CS->>+Eng: decide(row observations nowMs)
        Eng-->>-CS: ChainDecision

        alt decision = wait
          CS->>CS: saveFenced(epoch stamp) if changed
        else decision = advance — all members done next stage exists
          CS->>CS: captureCompleted(reads) → ChainData (structured output)
          Note over CS: declarative captures write under member id namespace (D5)
          CS->>CS: saveFenced(epoch next{epoch+1 cursor++ status:"scheduling"})
          CS->>Inv: fireStage(next stage members forceFresh=false)
          CS->>CS: saveFenced(next.epoch status:"running")
          Note over CS: loop-until-clean: cursor===startCursor → loopIsClean? → executeFinalize(completed) : fall through to advance above (forceFresh=false)
        else decision = finalize/completed — last stage done
          CS->>CS: captureCompleted(reads) → final ChainData
          alt strategy = loop-until-clean AND iterations + 1 < max — revise done, loop back
            CS->>CS: saveFenced(epoch cursor=startCursor iterations+1 status:"scheduling")
            CS->>Inv: fireStage(startCursor forceFresh=true)
            CS->>CS: saveFenced(epoch status:"running")
          else
            CS->>CS: executeFinalize(row completed)
          end
        else decision = finalize/orphaned — after-gate parent missing past streak limit
          CS->>Pub: publish(cron-disarm {repo slug workflow}) × cron members
          CS->>CS: executeFinalize(row orphaned)
        else decision = finalize/failed or terminated — D6
          CS->>Inv: terminate(still-running siblings)
          CS->>Pub: publish(cron-disarm {repo slug workflow}) × cron members
          CS->>CS: executeFinalize(row failed|terminated)
        else decision = budget-terminate
          CS->>Inv: terminate(all stage members)
          alt all down
            CS->>Pub: publish(cron-disarm) × cron members
            CS->>CS: executeFinalize(row budget-terminated)
          else some not down
            CS->>CS: saveFenced(stamp "terminate rejected retrying")
          end
        end
      end
    end
  end

  Note over CS,Pub: executeFinalize path (all outcomes)
  CS->>CS: tallyChainCost — sum run:<id>:* mirrors (costGap if zero matches)
  CS->>CS: saveFenced(epoch status:"finalized" outcome costUsd)
  CS->>CS: bumpLedger(date {chainsFinalized costUsd costByAgent})
  CS->>Pub: publish("workflow-events" {chainId outcome costUsd costGap})

```

## Reading notes

- **Mark-before-fire** (step 3): registration persists the `scheduling` row BEFORE the operator gets
  202, but stage 0 does NOT fire in the request handler — it fires on the next tick's activation
  branch (issue #79a). A crash between registration and the tick leaves a healable `scheduling` row.
- **Epoch fence** (step 18 `saveFenced`): every row-mutating action re-reads the row and no-ops
  when the epoch moved. A concurrent re-registration creates epoch N+1; this tick's decision at epoch
  N becomes a no-op — safe.
- **Activation gates** (steps 7–15, issues #78/#79a): `notBefore` holds without a streak; `after` a
  missing parent counts as UNKNOWN and streaks to `orphaned`; a parent finalized non-completed →
  `terminated` immediately; a completed parent seeds the child's chain data (step 14), and the
  `startedAt` is re-stamped at activation so the wall-clock budget counts work time, not wait time.
- **Cron member observation path** (step 20 note): a cron member self-armed its own recurrence via
  the §10 `arm-*` pattern — the chain never fired it and never reads its flaky runtime instance
  status. It reads `wf:<repo>:<slug>:<kind>.resolved` instead; `done` ↔ goal met on that row.
  Transient run failures never fail the chain — the member retries on its own clock.
- **Declarative captures / D5 namespace** (step 28): `captureCompleted` writes each completed
  member's structured output into the chain data. A member with an `id` writes under `data[id]` so
  concurrent stage members never clobber; a downstream member's dotted `inputs` path (`id.field`)
  reads it back.
- **Loop-until-clean intercepts** (two scan-side branches; the engine is strategy-agnostic): (1)
  **advance / review stage done**: when `cursor === loop.startCursor` and `loopIsClean`, the scan
  calls `executeFinalize(completed)` — stopping the loop; when NOT clean it falls through to
  `executeAdvance(nextStage, false)` to fire the revise stage with `forceFresh=false`. (2)
  **finalize/completed / revise stage done**: the revise stage is the last stage in the loop segment,
  so the engine reports `finalize/completed`; if `iterations + 1 < maxIterations` the scan calls
  `executeAdvance(startCursor, forceFresh=true)` + `loop.iterations++` to loop back to the review
  stage. The iteration budget is the backstop.
- **D6 atomic teardown** (finalize/failed branch): a non-completed finalize terminates the still-running
  siblings first, THEN publishes `cron-disarm` for every cron member (the chain never writes `cron:sub`;
  the subscriber is the cron scan's single writer), THEN finalizes the chain row — in that order, never
  the reverse.
- **costGap** (step 47): zero matching `run:*` mirrors is flagged `costGap: true`, never silently $0.
  A gap means the run ledger mirror didn't land (best-effort write, MCP server down) — the ledger is
  wrong, not the cost.
