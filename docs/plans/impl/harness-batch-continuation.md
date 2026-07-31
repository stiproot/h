# Continuation: the 2026-07-28/29 harness batch

Status: Complete — the 2026-07-28/29 batch fully landed (#98 merged, #97 merged 2026-07-30,
all threads resolved into their owning plans); undecided leftovers carried
Established: 2026-07-29

Lifted to:
- Every open thread's owning plan (the §2 table pointed at them; none restated here)
- [carried-followups](../carried-followups.md) §23–§25 — the pre-push-hook-on-agent-clones
  decision, the AGENT_MODEL stopgap revert decision, the `x-w0` litter row
- Dropped with reason: the "14 finalized chain rows" litter item — finalized rows are
  by-design audit retention, not litter

**Read this FIRST if you are picking up after a session break.** It is the handoff: what is
in flight, what the machine's state actually is, and which plan owns each open thread. It
does not restate work that already has a home — it points at it.

---

## 1. In flight — PR #98 (Kimi integration)

**RESOLVED 2026-07-29: MERGED as `fb08be6`** on full evidence (gate green on the merge
result, live tool-using e2e through the whole plumbing, PR CI green on the new self-hosted
runner, review loop finalized CLEAN after one unattended revise iteration). The stray
:8017 agent, the ephemeral `/tmp/kimi-live` worktree, and every kimi branch/worktree are
cleaned. See [impl/moonshot-kimi-integration](./moonshot-kimi-integration.md). The
only PR of the batch still open is #97 (`h chain rm`, predates the batch, unreviewed).

<details><summary>Original state (historical)</summary>

Branch `feature/kimi-int3` @ `40c5f72`. NOT merged.

State:

- Fully green at head on the **corrected** gate: `bun run lint`, `make lint-py`,
  `bun run build`, 24 JS test groups, all 357 Python tests.
- 20 review threads, 19 resolved; 18 substantive findings addressed across 4 review rounds.
- **The model id was wrong and is now fixed** (`40c5f72`): the integration was built on
  `kimi-k3[1m]`, which returns `404 … Not found the model kimi-k3[1m] or Permission denied`.
  The account's `/v1/models` lists `kimi-k2.6`, `kimi-k2.7-code`,
  `kimi-k2.7-code-highspeed`, `kimi-k3`; plain **`kimi-k3` returns 200**.

### What is left before merging

1. **Finish the live end-to-end run.** The wire is proven (a direct call to
   `https://api.moonshot.ai/anthropic/v1/messages` with `kimi-k3` returned
   `stop_reason: end_turn`), but the **h plumbing is not** — no run has gone through
   `run-kimi` → `kimi-agent` → the CLI. That is the plan's own acceptance criterion ("a live
   run, not just a green startup", plus a tool-using run).
2. **Re-verify at head after the model fix** (the last full verify predates `40c5f72`).
3. **Decide the merge on a capped loop.** The review capped at 2 iterations and its last
   findings were fixed *after* that review, so nothing has reviewed the current head. Per
   `docs/DRIVER.md`, a cap means UNKNOWN — the cheap resolution is one more review round.

**A `kimi-agent` was left RUNNING on :8017**, started from `/tmp/kimi-live` — an **ephemeral
worktree that will not survive a reboot**. Do not treat it as part of the stack. Kill it
(`dapr stop --app-id kimi-agent`) or restart from a real checkout. It is NOT in
`cli/scripts/_services.sh` (deliberately opt-in) and NOT in any compose profile default.

Owning plan: [moonshot-kimi-integration](./moonshot-kimi-integration.md).

</details>

---

## 2. Open work, by owning plan

Nothing below is restated here — go to the plan.

| Thread | Plan | Note |
| --- | --- | --- |
| Exposed PAT; tests firing real chains; executor allowlist | [live-state-containment](./live-state-containment.md) | **All engineering DONE + live-verified 2026-07-29** — PAT rotation (operator) is the one open item |
| CI does not execute; a panel cannot catch a build failure | [impl/local-ci-execution](./local-ci-execution.md) | **DONE 2026-07-29** — self-hosted runner live (tools/ci-runner/); branch-protection follow-up carried |
| Minimal-surface executors / per-run trust profile | [reviewer-identity-security](../reviewer-identity-security.md) | Moved Deferred → Active on this batch's evidence |
| Remaining audit items (phases 2, 4, 5) | [hardening-audit/](../hardening-audit/) | **Re-verify before working any of them** — 5 of 11 phase-1 items were already fixed |
| Kimi integration | [impl/moonshot-kimi-integration](./moonshot-kimi-integration.md) | **MERGED 2026-07-29** — see §1 |
| Member-input validation at registration | [impl/member-input-validation](./member-input-validation.md) | **BUILT 2026-07-29** (operator-approved) — registration refuses unsatisfiable members pre-publish |
| Auto-deny an executor on a usage-limited run |  [impl/usage-limit-auto-deny](./usage-limit-auto-deny.md) | **BUILT 2026-07-29** (green-lit) — watcher auto-fences a usage-limited executor; live-fire on the next real limit |

### Homeless items that still need doing

1. **Member-input validation at registration** — DONE 2026-07-29: spec rescued into
   [impl/member-input-validation](./member-input-validation.md), operator-approved, built
   the same day (all four of the batch's harness defects now resolved or carried).
2. **Decide whether agent pushes run the pre-push hook.** An agent had silently set
   `core.hooksPath` on the SHARED agent clone while testing #100; it would have armed itself
   on the next worktree cut from main, making every agent push run the full lint in an
   untested environment. **Disarmed** for now. Real arguments both ways — #98 broke `oxfmt`
   three times, so a hook would help; but a blocked push mid-run is a failure mode agents
   handle badly. Decide explicitly and set it in provisioning, not by accident.
3. **A first-class `plan` member kind** — [carried-followups](../carried-followups.md) §2,
   now with a concrete failure behind it (item 1 above is its symptom).

---

## 3. Machine state a fresh session must know

**These are real mutations, not incidental.**

- **`.env` `AGENT_MODEL` = `claude-sonnet-4-6`** (was `claude-haiku-4-5`). Raised to stop
  `panelize` silently downgrading panel branches. **#99 fixed that defect properly**
  (the strip is now loud and `--model` works with a roster), so this is a stopgap that can
  probably be reverted — a deliberate decision, not a silent one. Backup: `/tmp/env.bak.*`
  (ephemeral).
- **Pre-push hook INSTALLED on the primary clone** (`core.hooksPath = scripts/hooks`). Runs
  `bun run lint` + `make lint-py`, ~4.6s warm. **Disarmed on the agent clone** (see §2.2).
- **Host stack UP**, started with `make infra-up` + `MODE=dev make up-local` (8 services).
  Zipkin was refusing connections on :9411 late in the batch — worth checking before relying
  on traces.
- **The primary clone was found checked out on a feature branch mid-batch** (reflog:
  `23:57 checkout: moving from main to feature/fix-a0-ci`). Recovered; attribution never
  established, and the agent worktrees belong to a SEPARATE clone so they could not have done
  it. If it recurs, that is a real finding — note it.

### Litter to clean

- **14 chain rows**, all finalized, including six dead `kimi-*` registrations. No
  `h chain rm` until **PR #97** lands — that PR is the cleanup tool.
- **`x-w0`** — a saved workflow published by the unmocked test. Its CAUSE is fixed
  (live-state-containment §2.2, pytest-socket); the row itself remains — deleting it via
  raw state writes was permission-blocked 2026-07-29, so it waits for PR #97's `h chain rm`
  sibling or an operator-allowed `state_delete`.
- ~~18 `/tmp/verify-*` and `/tmp/fix*` git worktrees~~ — CLEANED 2026-07-29 (worktrees
  removed, `tmp-*` branches deleted, pruned).
- ~~A stale `feature/kimi-integration` worktree in the agent workspace~~ — CLEANED
  2026-07-29 along with all kimi worktrees/branches (local, agent-workspace, remote).

---

## 4. What this batch already landed

14 commits on `main` (`41b48e5`..`0899cc5`), two PRs merged:

- **#99** — empty-string model params (broke every non-claude chain member composed without
  an explicit `--model`); silent panel model downgrade, now loud and overridable.
- **#100** — hardening-audit A0: the guard surface runs (CI workflow + pre-push hook), and
  the `make lint-py` regression repaired.
- Plans groomed (19 archived, 5 Deferred, the integration playbook promoted to a skill),
  `check-plans.mjs` added, `make test-py` corrected from 4 suites to all 7 (304 tests were
  outside the standard command), audit items A0/A21/A24/A29/A30 closed, the `linear` skill's
  broken script paths fixed and guarded.

Corrections made to this session's own claims, all recorded in the relevant docs: the
fallback was never armed (chains have no `--fallback-*`); the registry pollution was an
unmocked test, not an agent, and the driver's own runs triggered it; the driver broke
`make lint-py` and did not notice because it verified with `bun run lint` — the JS half only.

## Log

- 2026-07-29 — Created at the operator's request as the resume point for a fresh session,
  because the batch's outstanding items lived in a session task list that does not survive.
