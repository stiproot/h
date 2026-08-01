# Core-component diagrams — sequence + class coverage for every core component

Status: Active — remaining diagrams handed to an h feature chain (see Handoff below)
Established: 2026-08-01

The operator communicates through diagrams. This plan tracks giving every CORE component a
canonical diagram pair — a **class diagram (generated)** and a **sequence diagram
(hand-authored, code-verified)** — plus the cross-cutting views, under the conventions that
now live in their durable homes:

- **Protocol + rules**: the `diagrams` skill (`.claude/skills/diagrams/SKILL.md`) — kind-in-
  filename naming (`<scope>-<kind>.md`), the "class diagrams are GENERATED, never
  hand-drawn — extend the toolkit if a language/symbol kind isn't covered" rule, mermaid
  syntax traps, activation-bar requirements, the register-in-index rule.
- **Tooling**: `tools/diagrams/` (see its README) — `gen-code-diagram.mjs` over manifest-
  managed docs; extractors: TS (`ts-extract.mjs`, kinds interface/union/const/module/
  schema — the `schema` kind reads Effect `Schema.Struct` consts) and Python
  (`py-extract.py` + bridge, kinds class/module). Drift is a lint failure.
- **Index**: `docs/diagrams/README.md` — the set + planned list.

## Done (2026-08-01, commits 2fa54ea + 607952d)

| Component | Pair |
| --- | --- |
| `packages/js/agent-cli` | `agent-cli-class` (generated, TS) + `agent-cli-sequence`; also the pre-existing `agent-cli-c4-component` / `agent-cli-uml-component` |
| `cli/h` (the h CLI) | `h-cli-class` (generated, Python) + `h-cli-chain-run-sequence` |
| `apps/workflow-svc` | `workflow-svc-class` (generated, schema kind) + `workflow-svc-tick-sequence` |
| flagship workflow | `implement-pr-run-sequence` (pre-existing, renamed) |

## Remaining (the handed-off work)

Work items, in priority order. For each: author per the `diagrams` skill, register in
`docs/diagrams/README.md`'s table (remove from its planned list), and meet the acceptance
gate below.

1. **`chain-run-engine-sequence`** — the ENGINE side of `h chain run` (the CLI side is
   `h-cli-chain-run-sequence`; link them): registration → activation gates (`after` /
   `notBefore`) → stage fire on the tick → observe every current-stage member → join →
   captures into the two-level chain data → next stage → `loop-until-clean` re-fire →
   terminal-failure teardown (terminate siblings + `cron-disarm`, D6). Verify against
   `apps/workflow-svc/src/domain/chain-scan.ts`, `chain-members.ts`, `chain-engine.ts`.
2. **`cron-siblings-state`** — one state diagram of the five siblings' row lifecycles
   (watch `scheduling→watching→finalized`, chain `scheduling→running→finalized`, cron/
   discover `active→inactive`, sched `armed→fired|expired` — READ THE MODELS for the true
   status literals, don't trust this line). One diagram if the shared shape is the story,
   split if it muddles.
3. **`system-c4-context` + `system-c4-container`** — the service topology: workflow-svc,
   the agent fleet, the MCP servers, Redis/Dapr, the observability spine. Use the
   c4-mermaid-plugin skills' syntax + validation; mind the C4 layout traps in the
   `diagrams` skill (short descriptions, `UpdateLayoutConfig` at top, LOOK at the render).
4. **`cost-accounting-sequence`** — an agent run's usage from CLI events to the day ledger
   and the budget fence: agent-cli `extractMetrics` → run ledger `run:<id>` mirror
   (`packages/js/agent-server/src/run-ledger.ts`) → watch-scan `tallyCost` (zero matches ⇒
   `costGap`) → `watch:ledger:<date>` → the daily-budget fence in `exec-policy.ts`
   (`h agents budget`). Verify against those files.

## Acceptance gate (every item)

- Registered in `docs/diagrams/README.md` (and removed from its planned list).
- `tools/diagrams/render.sh <name>` succeeds AND the PNG is visually inspected (C4
  especially — a compiling diagram can still collapse to one-shape-per-row).
- Sequence diagrams: activation bars present; reading notes name the invariants with step
  numbers that MATCH the autonumbered render (re-check after edits).
- Any new class diagram is generated (manifest + `gen-code-diagram.mjs`), never hand-drawn;
  `node tools/diagrams/gen-code-diagram.mjs --check` and `bun run lint` stay green.
- Modeled from the CODE (or a live run), not from docs — where a doc and the code disagree,
  the code wins and the discrepancy is worth noting in the PR.

## Handoff

- Fired as an h feature chain (default implement-pr → review-pr → revise-pr,
  `loop-until-clean`), slug `core-diagrams`, 2026-08-01 — watch with `h chain list` /
  `h status`, branch `feature/core-diagrams`.
- The chain's spec points the implementing agent at THIS plan; this doc stays the tracking
  log — the implementer should append findings/decisions here in the same PR.
- When all four items land: lift anything durable (new tooling kinds → tools README +
  skill; new conventions → the `diagrams` skill), set `Status: Complete`, archive to
  `docs/plans/impl/` per the plan-management skill.

## Trail

- 2026-08-01 — plan established after the first three pairs landed by the repo session
  (naming convention + py-extract + schema-kind extraction built en route; steering
  hardened: generated-vs-hand-authored split now explicit in the `diagrams` skill).
