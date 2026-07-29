# Run the guard surface locally, in a container — CI without Actions quota

Status: Active — the operator's working example (trxy-v2's self-hosted runner) captured
2026-07-29 and adapted as `tools/ci-runner/`; deploying + live-verifying now
Established: 2026-07-29

## The constraint that defines this plan

**h is out of GitHub Actions quota, and must NOT depend on CI.**

`.github/workflows/guards.yml` exists and is correct (hardening-audit A0, PR #100), but it
does not execute. Measured 2026-07-28 on PR #100:

```
GET /repos/stiproot/h/commits/<sha>/status  →  {"state":"pending","total_count":0}
```

Zero checks *started* — not failed. The same rate limit that took trxy-v2's PR-triggered CI
on 2026-07-27.

**Read the merged A0 posture through this correction.** That work described CI as the
primary mechanism and the pre-push hook as the fallback. With no quota the ordering inverts:

- **`scripts/hooks/pre-push` is the mechanism** (`make install-hooks`). It runs
  `bun run lint` **and** `make lint-py`, has no quota, and is proven to block — a deliberately
  broken guard made it fail `check-steering` and exit 1.
- **The workflow is dormant.** Keep it — it costs nothing and is ready when quota returns —
  but it must never be cited as assurance. **A PR with no red X has not been checked.**
- **Do NOT add branch protection requiring the `guards` check.** It never reports, so every
  merge would block.

## Why this is worth building anyway

A local hook is not equivalent to CI, and the gap is not hypothetical — it bit twice on
2026-07-28:

1. **Environment-dependent passes.** PR #99's new tests lacked `@respx.mock`/`@needs_helm`.
   They passed on a machine that happened to have helm and a reachable workflow-svc, and
   would have failed on a clean one. A green local run proves "correct *in my environment*",
   which is not the same claim.
2. **Failures that exist only in the merged state.** `make lint-py` broke on main with 13
   E501 violations that **neither contributing change produced alone** — the plans-grooming
   archive pass lengthened comment lines with the new `impl/` path segment, and #99
   lengthened two more. Only the merge failed. A pre-push hook runs on a branch and cannot
   see that; CI on the merge result can.
3. **A review panel cannot catch a build failure — so nothing does.** A panel reviews the
   DIFF and accepts the PR body's evidence claims. PR #98 passed FOUR review rounds and
   eighteen findings while `bun run lint` failed on **three separate** `oxfmt` violations,
   each introduced by a revise commit; the revise agent never ran lint, and no number of
   further rounds would have surfaced them. Every one was found by the driver running the
   gate by hand.

   This is the strongest argument for the plan: **an executed gate turns the build result
   into an objective input the review can read, instead of a claim it must trust.** Until
   then the driver is the only thing standing between a false evidence claim and `main` —
   which does not scale and did not hold (the driver also merged a PR after verifying with
   only the JS half of the gate). Whatever runs the guards must run them on the MERGE RESULT
   and report somewhere the loop can see.

A containerised local run addresses all three: a clean, pinned environment; the ability to run
the gate against the *merge result* rather than the branch; and an executed, reportable result
rather than a self-reported claim.

## The captured design (from trxy-v2, 2026-07-29)

The operator's working example is **trxy-v2's `tools/ci-runner`** — not `act`, not a
reimplementation: a **real self-hosted GitHub Actions runner** in Docker
(`myoung34/github-runner:ubuntu-noble` base), registered against the repo via `GH_TOKEN`
(Administration:RW), running the ACTUAL workflows. Validated in trxy through a real billing
lapse (`docs/guides/self-hosted-ci-runner.md` there; also the EPHEMERAL='false' trap —
non-empty means ON — and the shared `Linux-*` cache keys forcing a noble base).

This resolves the open questions wholesale:

- **`act` vs own container** — neither: a genuine runner executes the real `guards.yml`,
  so there is no second definition of the gate to drift.
- **What runs it / when** — GitHub does, on the same triggers as hosted CI. The fleet
  switch is `runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}` + a repo variable; no
  YAML change in either direction.
- **Merge-result verification** — comes back for free: `pull_request` runs execute against
  the merge ref, `push` runs against main, results land as checks the loop can read.
- **Cost/time** — hosted minutes: zero. Wall clock: one runner serialises, acceptable for
  a single-job workflow.

Adapted for h as `tools/ci-runner/` (Dockerfile + compose.yml + README runbook): h's
toolchain is node + bun (pinned to guards.yml's BUN_VERSION) + uv + helm — no deno/yarn/
postgres/docker. No docker socket mounted; persistent named-volume caches (bun, uv,
tool-cache); repo stays private or the runner is deleted first.

## Follow-ups once live-verified

- **Branch protection** requiring the `guards` check becomes safe to add (the old warning
  below assumed the check never reports).
- The A0 posture inverts back: CI is again the primary mechanism, the pre-push hook the
  fast local guard.

## Related

- `docs/plans/hardening-audit/` A0 — shipped the workflow + hook; this plan owns the "and it
  actually runs" half that quota blocked.
- `docs/DRIVER.md` — the merge protocol, including verify-at-head against the merge result,
  which is the manual version of what this would automate.
