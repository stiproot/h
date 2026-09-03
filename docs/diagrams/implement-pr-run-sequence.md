# implement-pr — one run, end to end

The flagship workflow (`h workflow run implement-pr -p slug=… -p spec=@… --watch`): a feature
worktree is cut, an agent plans and implements, the machine-executed itest gate blocks a red
build BEFORE any PR exists, create-pr pushes and opens the PR, and the run arms its own revise
loop. The watcher engine supervises from outside on the cron tick — a workflow never supervises
itself.

Composed from `implement ⊕ verify ⊕ run-itest ⊕ create-pr ⊕ arm-revise-pr`
(`docs/h-builds-h-runbook.md`). Step order: worktree → setup → plan → implement → itest →
create-pr → arm-revise-pr.

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator<br/>(h CLI)
    participant Router as workflow-svc<br/>HTTP router
    participant Reg as Registries (Redis)<br/>watch: wf: cron: exec: quota: run:
    participant Wf as generic.workflow<br/>(Dapr engine)
    participant Act as Activity layer<br/>(exec-policy gate)
    participant Agent as claude-agent<br/>(service)
    participant CLI as claude CLI<br/>(subprocess)
    participant Watch as Watcher engine<br/>(60s cron tick)

    Op->>+Router: POST /workflow/run/implement-pr {slug, spec, watch}
    Note over Router: fire-time params merge over stored defaults<br/>(identity-as-params: runActivity/agentId/model)
    Router->>Reg: watch:sub:instanceId (mark-BEFORE-fire)
    Router->>Wf: schedule instance
    activate Wf
    Router-->>-Op: 202 {instanceId, watching: true}

    Wf->>Reg: wf: row = running

    Wf->>+Act: create-worktree
    Act->>+Agent: POST /worktree
    Agent-->>-Act: worktreePath (feature/slug off origin/main)
    Act-->>-Wf: worktree ready
    Wf->>+Act: setup
    Act->>Agent: POST /setup (skills + .mcp.json — idempotent spec-hash)
    Act-->>-Wf: setup done

    loop agent steps — plan then implement (verify prose folded in)
        Wf->>+Act: resolve {{params.runActivity}} → run-claude
        Act->>Reg: read exec:config + quota:<executor>
        alt executor denied (operator | usage-limited | cost-budget)
            Act--xWf: REFUSED loudly — step fails before any model call
        else quota gate: last report rejected, or utilization + a step's typical spend > ceiling (fail 100% | wait 90%)
            Act--xWf: REFUSED BY NAME (window, observation, reset, the ways past it) — unless --ignore-quota
        else allowed
            Act->>+Agent: POST /run {task, cwd: worktree}
            Agent->>+CLI: spawn (detached group leader, reaper-registered)
            CLI--)Agent: event stream → events.jsonl (run ledger)
            CLI-->>-Agent: exit + terminal result (or timeout → partial usage fold)
            Agent->>Agent: validate ===OUTPUT CONTRACT=== json block
            Agent->>Reg: run: mirror {costUsd, stopReason, costPartial}
            Agent-->>-Act: AgentResponse
        end
        deactivate Act
    end
    Note over Wf,CLI: implement COMMITS LOCALLY — no push, no PR yet

    Wf->>+Act: run-itest (harness materialised from origin/main, never the worktree)
    alt itest RED
        Act--xWf: nonzero exit — workflow FAILS HERE, no PR is opened
        Wf->>Reg: wf: row = failed
    else itest GREEN
        Wf->>Act: run-claude (create-pr step)
        Act->>+Agent: push feature/slug + open PR (+ itest evidence in body)
        Agent-->>-Act: structured {pr, goal}
        Wf->>Act: register-cron (arm-revise-pr — idempotent ensure-exists)
        Act->>Reg: cron:sub row (the revise loop, armed by the run itself)
        Wf->>Reg: wf: row = done (+ resolved via the goal handshake)
    end
    deactivate Act
    deactivate Wf

    loop every 60s — independent of any run
        activate Watch
        Watch->>Reg: read watch:sub rows + live instance status
        Note over Watch: pure decide(): wait | terminate(budget) |<br/>retry | finalize — epoch-fenced
        Watch->>Reg: on terminal: tally cost off run: mirrors<br/>(per-agent subtotals — a missing cost is a GAP, not $0)
        Watch->>Reg: finalize watch row + bump day ledger
        Watch->>Reg: quota:<executor> ← the run's rate-limit report (every finalize)
        Watch->>Reg: fences: usage-limited auto-deny until the observed reset,<br/>daily cost-budget deny (expiring exec:config entries)<br/>onQuota=wait arms a same-identity cron:sched continuation
        Watch--)Op: publish workflow-events (terminal outcome)
        deactivate Watch
    end
```

## Reading notes

- **Mark-before-fire** (step 2): supervision is registered before the run exists, so a crash
  between the two leaves a `scheduling` row the scan heals — never a silently unsupervised run.
- **The gate** (steps 12–13): every `run-*` activity passes through the exec-policy gate; a
  denied executor is refused on EVERY fire path (chains, crons, re-fires, panels) with no
  per-path code. The QUOTA gate sits in the same place and reads the `quota:` OBSERVATION row
  beside the `exec:` POLICY row: it projects whether this step fits the executor's remaining
  window (utilization + the mean spend of that executor's recent steps) and refuses by name when
  it does not — before anything is paid for. `--on-quota`/`--ignore-quota` ride the fire
  descriptor and reach it as step input, so the gate mode is the same on a chain member, a cron
  re-fire and a sched continuation. A row whose reset has passed never blocks (stale-in-favour).
- **The itest gate** (steps 21–23): the one machine-executed check — a red build fails the
  workflow before a PR exists, so reviewers never see a broken branch.
- **The watcher lane** (bottom loop): the run never supervises itself; budgets, retries, cost
  tallies, and the two auto-fences all live in the engine on the tick.
