# Reviewer identity: minimal-surface executors for untrusted-input workflows

Status: Deferred — **the 2026-07-28 trigger fired, was answered in full, and the answers landed
elsewhere without this doc noticing.** Both requirements that incident produced are built (see
*Validation 2026-08-26*); what remains is the ORIGINAL speculative half, whose own trigger has
not fired. Re-parked rather than closed, because that half is real.
Established: 2026-07-09
Revisit when: (a) h runs against a repo we do not own — the original trigger, still unfired — or
(b) an implement-leg executor's control-plane MCP surface is shown to reach something it should
not. (b) is the live one to watch: a LOCAL-substrate agent inherits the repo's `.mcp.json` and can
therefore fire and terminate durable workflows on any reachable stack, which is this plan's
"strip the control-plane MCP from implementers" concern on the substrate now in daily use. It is
currently unexercised only because no service stack is running.

## The premise this plan was parked on turned out to be wrong (2026-07-28)

This plan was Deferred with the trigger "revisit when h runs against a repo we do not own."
That framed the risk as **malicious third-party input**. An unattended batch on 2026-07-28
showed the real exposure is **accidental self-inflicted damage on repos we DO own**:

Durable rows appeared in two production registries overnight — `chain:sub:x` and the saved
workflow `x-w0` (which became the saved-workflow registry's only entry) — the chain row's
epoch climbing to 4, and a live `review-pr` panel ran **including `codex`, the executor the
operator had explicitly excluded for that batch on exhausted quota**. The codex run completed
with 3 tool calls, so it reached the model and spent quota.

**Root cause, corrected.** The driver first attributed this to an implementing agent choosing
to run `h chain run` against production. That was wrong. The actual cause is a **test**:
`test_chain_roster_accepts_model` (new in PR #99, `cli/h/tests/test_chain.py`) invokes

```
chain run --slug x -w review-pr --agent claude codex --model opus
```

with **no `@respx.mock`**, so it issues a real HTTP call to whatever workflow-svc is
reachable. That accounts for every observation exactly: the chain id is the test's `--slug`,
`x-w0` is its compose-on-fire publish, the epoch increments once per suite run, and `codex`
appears because it is literally in the test's roster. The driver's own verify-at-head runs of
that suite were among the triggers.

**Why this is still this plan's business, and arguably worse.** The finding is not "an agent
went rogue" — it is that **running the CLI test suite on any machine with a live stack fires
real chains, publishes real saved workflows, and invokes real agents on real providers,
silently.** No agency is required; a developer running `pytest` does it. The `x` chain was
harmless only by luck (its dispatch failed). Two properties are missing and both belong here:

1. **Tests must not be able to reach a live control plane.** The immediate fix is the missing
   mock (the #99 review panel caught it independently), but the class needs a guard — a test
   suite should fail closed if an unmocked HTTP call escapes to a real workflow-svc.
2. **An engine-enforced executor allowlist**, so an excluded provider cannot be invoked *by
   any path* — test, agent, or operator typo. "No codex tonight" should be unbreakable rather
   than advisory. This requirement is unchanged by the corrected root cause; if anything the
   correction strengthens it, since the bypass came from a direction nobody was policing.

Separately, the original concern still stands on its own merits — an executing agent *does*
hold the full `workflows`/`dapr` MCP surface and could fire or terminate workflows — it simply
was not what happened here, and should not be justified by this incident.

**What this changes about the design.** The minimal-surface profile is no longer only a
defence against untrusted text; it is *blast-radius control for ordinary work*. Two capabilities
now look load-bearing rather than speculative:

- **Strip the control-plane MCP (`workflows`, `dapr`) from implement-leg executors.** An
  implementer needs `github` and its editor; it does not need to fire or terminate workflows.
  This is the `MCP_CONFIG_MODE=replace` knob that already exists and is currently set nowhere.
- **An engine-enforced executor allowlist at fire time**, so an excluded provider cannot be
  invoked at all — policy that holds regardless of which surface initiates the fire. The
  operator's "no codex tonight" should have been unbreakable, not advisory.

Neither requires a separate service (the claude-coder shape); both fit the per-run profile
sketched below.

Still live from this doc: the **interim ruling** below — `--agent` on a frozen-executor workflow warns and keeps the pin, never erroring and never silently complying. `config.py`, `chain.py` and `workflow.py` all cite this doc at that warning. Its sibling half is [agent-env-propagation](./agent-env-propagation.md) (the env `subset` strategy); both were split out of [agent-process-identity](./impl/agent-process-identity.md) increment 2.


## Validation 2026-08-26 (pick-up pass, per `plan-management` step 2)

**1. Are the CLAIMS still true? Three of five are STALE, all in the good direction.**

- ✅ **DELIVERED, and stronger than asked.** Requirement 1 was "tests must not be able to reach a
  live control plane… the class needs a guard — a test suite should fail closed if an unmocked
  HTTP call escapes to a real workflow-svc." `cli/h/pyproject.toml` now carries `pytest-socket`
  with `addopts = "--disable-socket"`: EVERY socket fails closed, not just one aimed at
  workflow-svc, and a test needing one opts in explicitly. The class is guarded, not just the
  instance.
- ✅ **DELIVERED.** The specific offending test, `test_chain_roster_accepts_model`, now carries
  `@respx.mock` (`cli/h/tests/test_chain.py`).
- ✅ **DELIVERED.** Requirement 2 was "an engine-enforced executor allowlist, so an excluded
  provider cannot be invoked by ANY path… 'No codex tonight' should be unbreakable rather than
  advisory." That is the `exec:` policy registry: `gatedExecutor` wraps every `run-*` activity in
  the registry and refuses a denied executor at fire time on every path — chains, crons, watcher
  re-fires, sched continuations, fallback switches, panel branches — with `h agents deny|allow`
  as the surface. `h agents deny codex` is now exactly the unbreakable instruction this plan
  asked for. It arrived via the cost-containment / usage-limit work, not via this doc.
- ❌ **STALE.** "`config.py`, `chain.py` and `workflow.py` all cite this doc at that warning" —
  they do not, and may not: `scripts/check-plans.mjs` forbids any reference to `docs/plans/**`
  from outside `docs/plans/`, precisely because a plan is written to be archived. The interim
  ruling itself still holds in code (frozen executors warn and keep the pin); only the citation
  is gone, which is the guard working.
- ✅ **STILL TRUE.** `MCP_CONFIG_MODE=replace` is set nowhere — only the `merge` default and the
  fail-closed validation exist. This is the one capability the plan named that remains unbuilt.

**2. Is the GOAL still wanted? The half that was Active is DONE; the half that remains never had
its trigger fire.**

This plan went `Active` because the 2026-07-28 incident refuted its deferral premise. Both
demands that incident produced are now satisfied. What is left is the pre-existing concern — strip
the control-plane MCP from implement-leg executors, and the minimal-surface reviewer allowlist —
which the plan itself is careful to say "should not be justified by this incident."

So the honest status is `Deferred`, not `Active`: nothing here is being worked, and the reason it
stopped being worked is that its trigger was answered rather than abandoned. Leaving it `Active`
asserts work in flight that is not.

One thing the re-read surfaces that the doc did not anticipate: the plan reasons about executors
as SERVICES, and the operator has since moved to the local substrate, where an agent runs as the
operator, with their credentials, no sandbox, and the repo's own `.mcp.json` merged in — so it
holds the `workflows` and `dapr` servers and can fire or terminate durable workflows on any stack
it can reach. That is this plan's exact concern, relocated to a substrate it never considered,
and it is the trigger most likely to fire next. Recorded in the status line above.

## Current posture (2026-07-14) — trust model

We own the repos the loop reviews, so the reviewing agent no longer needs capability isolation.
**claude-coder (the separate minimal-surface service) is retired** (docs/plans/agent-process-identity.md
increment 2). `pr-review`'s executor is now **pinned to claude-agent** — the loop's consistent
reviewer, an *operational* pin (still frozen via `FROZEN_EXECUTOR_KEYS`, `--agent` warns-and-ignores),
not a security boundary. The task prose still frames the PR diff as data-to-review, not instructions —
that hygiene is independent of trust.

## The original invariant (superseded — reinstate per-run if untrusted repos return)

Before the trust model, `pr-review`'s executor was hardcoded to **claude-coder** deliberately: the PR
diff is untrusted third-party text, so the reviewer's surface was minimized — github-only MCP, no
workflows/dapr/obs tools, no Linear/Notion secrets, `MCP_CONFIG_MODE=replace` so it never inherited a
target repo's own servers, and a scoped `GH_CODER_TOKEN`. Those four restrictions were bound at the
*service* level, which is why claude-coder was a separate deployment. If untrusted repos return, the
right shape is **not** a second service but a **per-run trust profile**: bind {replace-mode + github-only
MCP src, scoped token, env `subset` (docs/plans/agent-env-propagation.md)} at spawn — alongside the OS
drop to `SUB_AGENT_UID` (docs/plans/agent-process-identity.md) — so a single claude-agent serves both
trusted and untrusted runs by profile. The frozen-executor invariant then becomes "pr-review runs with
the untrusted **profile**", the security control being the profile, not a specific service.

## Interim ruling (2026-07-09, still in force)

`--agent` on a frozen-executor workflow **logs a warning and defaults to the pinned executor** — it
does not error, and it must never silently comply. The warning names this doc.

## To flesh out later

- An **allowlist of minimal-surface reviewer agents** (the property that qualifies an agent:
  github-only tools, no secret-bearing MCP servers, config-replace mode) — so "review with
  openhands" becomes possible by standing up an openhands deployment with claude-coder's posture.
- Where the allowlist lives (chart values? workflow-svc config?) and who enforces it (CLI warning
  vs engine refusal).
- Whether the same treatment applies to other untrusted-input workflows as they appear (issue
  triage on third-party issue text, etc.).
