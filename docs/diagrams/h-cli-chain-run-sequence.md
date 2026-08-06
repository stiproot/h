# h chain run — sequence diagram (composition, CLI side)

What happens between typing `h chain run --slug s -p spec=@spec.md <EXPR>` and the chain
starting: the hand-parsed expression grammar, per-member resolution (compose-on-fire,
panelize, validate-before-publish), and then the SUBSTRATE FORK — either the single
`POST /chain/run` that hands a durable row to the engine and returns immediately, or
`--direct`, which sequences the identical members in this process and blocks.

The engine-side story — stage progression on the cron tick, epoch fences, D6 teardown — is
[chain-run-engine-sequence](./chain-run-engine-sequence.md). One direct run's steps are
[direct-run-sequence](./direct-run-sequence.md). Structure of the same code: the
[class diagram](./h-cli-class.md).

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator
  participant Cmd as chain.run (commands/chain.py)
  participant Parser as chain_expr (pure)
  participant Compose as compose_templates (template.py + overlay)
  participant Helm as helm binary (subprocess)
  participant Panel as panelize (pure)
  participant SvcCli as workflow_svc client (httpx)
  participant Svc as workflow-svc
  participant Direct as h-direct runner (--direct)

  Op->>+Cmd: h chain run with slug / -p seeds / strategy / gates + EXPR tokens [--direct]
  Note over Cmd: Typer consumes only the chain-identity flags —<br/>EXPR flag names stay UNDECLARED so position survives in ctx.args
  opt --direct
    Note over Cmd: refuse the activation gates (--after / --at / --in): they wait on a<br/>durable row. Every member is forced INLINE — there is no store to read.
  end
  Cmd->>+Parser: parse_expr(ctx.args)
  Parser-->>-Cmd: ChainExpr (chain-wide defaults + ordered stages) — ExprError exits 1
  Note over Cmd: flatten stages — effective_config per member<br/>explicit stage index wins over position<br/>-p seeds parse into the chain data (@path splices a file)

  loop each member in expression order
    alt composed member (a -t group / any roster member)
      Cmd->>+Compose: compose_templates(atoms)
      Compose->>+Helm: helm template atom with publish+composable values
      Helm-->>-Compose: rendered YAML (params slots open)
      Note over Compose: overlay() merges atoms by step id —<br/>exactly ONE atom may declare outputs
      Compose-->>-Cmd: one definition (steps, params, outputs, panelSynthesis)
      opt roster — several agents on one member
        Cmd->>+Panel: panelize(definition, roster_pairs, model_override)
        Panel-->>-Cmd: parallel branch per agent + pinned-judge synthesis under the ORIGINAL id and contract
      end
      Note over Cmd: input validation BEFORE any publish — every params token<br/>the definition references must be satisfiable (gaps refuse the chain)
      alt inline, cron, or --direct member
        Note over Cmd: steps EMBED in the chain row (D1) — nothing published
      else publish default
        Cmd->>SvcCli: save(slug-wN, steps, params, outputs)
        SvcCli->>Svc: POST /workflow/save
      end
    else saved -w key
      Note over Cmd: well-known name maps to its kind — else the member needs a kind flag<br/>identity slots + inputs validated off the chart render or stored definition
      opt --direct
        Note over Cmd: resolve through the member's CHART TEMPLATE instead —<br/>a published key with no template (implement-pr) is REFUSED,<br/>naming the -t atom composition that does work
      end
    end
    Note over Cmd: capture + until mappings checked against the declared outputs schema —<br/>a broken thread fails at registration and never fires
  end

  Note over Cmd: assemble the row — members with stage / id / cron and fire params<br/>data seeds + defaultData slug (lowest precedence)<br/>budgetMs and gates (after / at / in) — loop startCursor = the review member's STAGE
  alt default — register with the engine
    Cmd->>+SvcCli: chain_run(body)
    SvcCli->>+Svc: POST /chain/run
    Svc-->>-SvcCli: chainId (chain:sub row registered)
    SvcCli-->>-Cmd: result
    Cmd-->>Op: chain registered — NON-BLOCKING, the engine sequences it on the cron tick
  else --direct — sequence it here
    Note over Cmd: same members, stages, captures/inputs/until and loop —<br/>engine-only fields (key, instanceId, fresh, cron) dropped
    Cmd->>+Direct: chain job on stdin
    Direct->>Direct: stage by stage: members concurrent, join, capture,<br/>loop back to the review stage until CLEAN or the budget
    Direct-->>-Cmd: envelope {ok, status, data, runs}
    Cmd-->>Op: BLOCKS to completion — prints the threaded chain data
  end
  deactivate Cmd
```

## Reading notes

- **Position IS the grammar** (steps 1–3): a flag binds to the workflow it *follows*; before
  the first workflow it's a chain-wide default. That only works because Typer never declares
  the EXPR flag names — click would consume them wherever they sat in argv.
- **A refused chain leaves no durable footprint**: member-input validation and the
  capture/until schema checks (the notes before and after the publish branch) run BEFORE the
  publish (steps 10–11) and the registration (steps 12–13) — an unsatisfiable member fails
  the whole command while nothing has been written anywhere.
- **The panel is invisible below the contract** (steps 8–9): panelize replicates the
  contract-carrying step into per-agent branches (contract stripped) and re-hangs the pinned
  judge's synthesis under the member's ORIGINAL step id + contract, so captures,
  loop-until-clean, and the watcher see an unchanged member.
- **The CLI registers; the engine executes** (steps 12–16): `h chain run` returns at step 16
  with only registry writes done — the chain engine fires stage after stage on the
  workflow-cron-tick, joins concurrent members, threads structured outputs through the chain
  data, and survives a closed laptop.
- **One kind table on both sides**: the kinds named here (`implement-pr`, `review-pr`,
  `revise-pr`, `answer`) are the closed `MEMBER_KINDS` vocabulary — the CLI validates against
  the same contract halves the engine's `chain-members.ts` executes (`test_kind_sync` pins
  the pairing).
