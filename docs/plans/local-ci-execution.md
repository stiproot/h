# Run the guard surface locally, in a container — CI without Actions quota

Status: Deferred — stub. The operator has a working example of running GitHub Actions locally in a container; it is not yet captured here, and nothing is built
Established: 2026-07-29
Revisit when: we want a reproducible, environment-neutral run of the guard surface — or the next time a defect slips through because local verification was environment-dependent

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

A containerised local run addresses both: a clean, pinned environment, and the ability to run
the gate against the *merge result* rather than the branch.

## What the operator already has (CAPTURE THIS FIRST)

The operator reports a **working example of running our actions locally in a container**.
That example is the starting point and is not recorded anywhere in this repo — capturing it
is the first task when this is picked up, before any design. Likely shape (`act`, or a
hand-rolled container running the same steps), but do not guess: get the real thing.

## Open questions for when it is picked up

- **`act`, or our own container?** `act` reuses `guards.yml` directly so the two paths cannot
  drift; a hand-rolled container is simpler but becomes a second definition of the gate — the
  exact drift class the audit exists to prevent.
- **What runs it, and when?** A `make ci-local` an operator runs before merging is the cheap
  start. A pre-merge step in the driver's protocol is the useful version, since the driver is
  the thing that actually merges.
- **Merge-result verification.** The highest-value property CI has and the hook lacks. The
  driver already does this by hand (worktree at `origin/main` + merge the branch, then run the
  gate) — that procedure is in `docs/DRIVER.md` and could simply be scripted.
- **Cost/time.** The full gate is minutes, not seconds. Decide what runs per-push (fast
  guards) versus per-merge (everything), or the containerised run will be skipped.

## Related

- `docs/plans/hardening-audit/` A0 — shipped the workflow + hook; this plan owns the "and it
  actually runs" half that quota blocked.
- `docs/DRIVER.md` — the merge protocol, including verify-at-head against the merge result,
  which is the manual version of what this would automate.
