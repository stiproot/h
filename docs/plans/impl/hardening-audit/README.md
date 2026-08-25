# Hardening audit — encode the unguarded invariants

Status: Complete — all 29 findings closed; every phase doc reads Complete. Closed 2026-08-25.
Lifted to: the guard set itself is the deliverable and it lives in `scripts/check-*.mjs`, chained
into root `package.json`'s `lint` and tabulated in [CLAUDE.md](../../../../CLAUDE.md)'s *The guards*
section (each script's header comment carries the live incident that motivated it — that is the
durable home for a finding's "why"). The A0 hook/CI outcome is in README's *Git hooks* + *CI*
sections and CLAUDE.md's *CI (self-hosted runner)*; the codex integration recipe became the
`.claude/skills/integrate-agent/` skill; the pattern learnings fold into *Harden by encoding*
(ARCHITECTURE.md#principles).
Established: 2026-07-23

## Phase docs

Work them in order; within a phase, items are independent. Each doc carries its own
status line — this index + those status lines are the plan's state.

| Doc | Scope | Items |
| --- | --- | --- |
| [01-drift-fixes.md](./01-drift-fixes.md) | Live drift & bug fixes (quick wins, no new machinery) | A16, A1, A18, A28, A22, A23, A20, A21, A24, A29, A30 |
| [02-guards-fire.md](./02-guards-fire.md) | Make the guards fire (pre-push hook + CI — the high-severity meta-gap) | A0 |
| [03-sync-guards.md](./03-sync-guards.md) ✅ **Complete** (PR #55) | Cross-stack sync guards (dual-maintained surfaces) | A2, A19 |
| [04-content-guards.md](./04-content-guards.md) | Content-invariant `check-*.mjs` guard scripts | A3, A4, A5, A6, A7, A9, A10, A11, A26 |
| [05-test-gaps.md](./05-test-gaps.md) | Test-coverage gaps (pure logic, ranked by blast radius) | A8, A12, A13, A14, A15, A17 |

## Context


Produced by a multi-agent audit workflow (2026-07-22/23): 5 parallel finders (arch-lint
enforcement, content-invariant guards, test gaps, steering drift, doc gaps) → dedup →
one adversarial verifier per finding (37 agents total). 34 raw findings → 31 deduped →
**29 confirmed, 2 refuted**. Every "Do:" below is the verifier's refined proposal — it
already checked evidence paths on disk, searched for existing guards, and corrected the
finder's proposal with exact file paths. Trust but re-verify line numbers: the repo has
moved since 2026-07-23 if you are reading this later.

This plan operationalizes the *Harden by encoding* principle (ARCHITECTURE.md#principles):
every finding is either (a) drift that already happened because an invariant was
documentation-only, or (b) a documented "MUST" no machine checks.

**For the executing agent:**
- Work phase by phase; within a phase, items are independent. Tick `[ ]` → `[x]` and
  append findings/learnings/decisions to the Log section as you go (this doc is the
  living tracking log — see the `plan-management` skill).
- Every new guard goes into an existing runner: `scripts/check-*.mjs` chain into root
  `package.json` `lint`; Python sync tests into `cli/h/tests` (run by
  `uv run --package h-cli pytest`); JS tests beside their subjects (vitest).
- After adding each guard, run it against the repo and fix (or explicitly allowlist)
  what it flags — a guard that fails on main must not land failing.
- Acceptance per phase: `make lint` green, `bun run test` green,
  `uv run --package h-cli pytest` green.
- Line numbers in evidence were verified 2026-07-22/23 and may have drifted; the file
  paths and invariants are the durable part.

## Refuted findings (do NOT implement — verified as non-gaps)


- **Six plans marked SHIPPED/DONE/IMPLEMENTED still sit in active docs/plans/, and nothing checks** — Evidence paths check out and no machine guard exists, but the gap is intentional design, not drift. The plan-management discipline was adopted 2026-07-22 (commit 41f4121, one day before the audit) and its skill explicitly grandfathers older plans: .claude/skills/plan-management/SKILL.md:46-47 says plans predating 2026-07-22 don't carry the new status lines and should be retrofitted "only when you touch one" — all six cited plans predate the convention (2026-07-05..07-19). Moreover, most cited plans are not archivable per the skill's own gate (SKILL.md:111-132 requires Status: Complete + lifted context): schedule-and-fallback.md has explicit Outstanding items and is marked "Living doc"; watcher-primitive.md is marked "Living doc"; chain-composition-surface.md says slices E and F remain; inline-chain-cron-composition.md holds an open sub-question (loop-until-clean × stages) that CLAUDE.md itself cites as living in "the plan doc's open sub-questions" — the repo deliberately keeps it active. The proposed regex on SHIPPED|DONE|IMPLEMENTED|BUILT would fail lint on exactly these deliberately-live plans and would fight the grandfather clause; archiving is gated on the human lift-then-archive judgment a headline regex cannot proxy. At most two plans (workflow-watcher-registry.md, structured-workflow-outputs.md) look genuinely terminal, and the stated policy for them is retrofit-on-touch.
- **h-builds-h runbook does not cover the chain-driven loop that superseded it** — The runbook does lack chain/panel/loop-until-clean content (verified: docs/h-builds-h-runbook.md:10-14, grep clean), but the finding's premise — that the chain-driven loop "superseded" the two-cron flow — is wrong. The chain runs (PR #52, #53) were hand-fired e2e validations of new chain machinery, while the standing autonomous loop the repo actually runs remains the two-cron discovery/revise path the runbook documents; docs/plans/workflow-registry-followups.md:38-45 explicitly rules that the revise-until-merged loop's home is the recur cron, NOT a chain. The chain-variant recipes are documented in their designated homes: the grammar in CLAUDE.md's chain section, cli/README.md:97, ARCHITECTURE.md:59; the validated panel expression in the still-active docs/plans/multi-agent-panel.md (~line 110). The repo's plan-management discipline already encodes the lift-before-archive step that moves lasting recipes to a long-lived home when those plans close, so nothing is lost and no operator is misled about the standing loop.

## Lift-before-archive obligations

When this plan completes, before moving the whole directory to `docs/plans/impl/hardening-audit/`:
- Each new `check-*.mjs` guard: add/adjust the corresponding CLAUDE.md "Key gotchas" or
  lint note so the doc points at the guard (rule + pointer, not restated prose).
- The hooks/CI decision (A0): record the outcome (hook path, CI workflow, what runs where)
  in README dev-commands + a CLAUDE.md note.
- The codex integration (A1/A18/A28): the worked example belongs in
  docs/plans/agent-integration-playbook.md (its stated purpose).
- New invariant-guard pattern learnings: fold into the *Harden by encoding* entry.

## Log

- 2026-07-23 — Plan created from the verified audit output (workflow run wf_580b2f94-226).
- 2026-07-23 — Split from a single 74KB doc into this per-phase directory.
- 2026-08-25 — **Closed.** Re-verification of the 9 items still marked open found 7 of them
  already resolved by later, unrelated work that never touched this doc (A18/A28 by
  codex-chatgpt-auth, A20/A22-part by `check-vocabulary` + `check-steering`, A23 by package
  documentation, A24, A26 by `check-plans`'s citation rule, A30). Only A21 and the observe-h half
  of A22 still reproduced, and both were fixed in the closing pass — A21 having drifted past its
  own description into a live falsehood, since `cli/README.md` still listed
  `--cron/--watch/--at/--in` as refused on the local substrate after the engine host made them
  work. Two things are worth carrying out of that:
  - **A hardening backlog decays in the GOOD direction, and that is exactly what makes working it
    from the list dangerous.** Seven of nine items would have been re-implemented, or their
    absence puzzled over, by anyone starting at step one. This is the concrete case behind
    CLAUDE.md's *validate a plan before picking it up* rule: check the TREE, not the doc.
  - **A guard closes its finding permanently; a doc edit does not.** Every item that closed
    itself did so because someone encoded the invariant (`check-steering`, `check-vocabulary`,
    `check-plans`). The two that were still open — both pure prose with no guard — were the two
    that had rotted, and A21 had rotted into telling an operator a working capability did not
    exist. That asymmetry is the audit's own strongest evidence for *Harden by encoding*.
