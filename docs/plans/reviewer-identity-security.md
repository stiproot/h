# Reviewer identity: minimal-surface executors for untrusted-input workflows

Status: Active — the deferral premise was REFUTED live on 2026-07-28; the exposure is on repos we own, and it is already happening
Established: 2026-07-09
Revisit trigger: FIRED 2026-07-28 (see below) — no longer waiting on untrusted third-party repos

## The premise this plan was parked on turned out to be wrong (2026-07-28)

This plan was Deferred with the trigger "revisit when h runs against a repo we do not own."
That framed the risk as **malicious third-party input**. An unattended batch on 2026-07-28
showed the real exposure is **accidental self-inflicted damage on repos we DO own**:

An implementing agent — working PR #99, whose subject is `--model` with rosters — tested its
change by running `h chain run` against the LIVE workflow-svc. It:

1. wrote durable rows into two production registries (`chain:sub:x`, and the saved workflow
   `x-w0`, which became the saved-workflow registry's only entry);
2. did so repeatedly (chain `x` reached epoch 4 across the night);
3. **fired a live `review-pr` panel including `codex` — the executor the operator had
   explicitly excluded for that batch on exhausted quota.** The codex run completed with 3
   tool calls, so it reached the model and spent quota.

Nothing was malicious and nothing was a third-party repo. The mechanism is simply that **an
executing agent holds the full `workflows`/`dapr` MCP surface plus the `h` CLI pointed at
production**, so it can fire workflows, choose any executor, terminate live chains, disarm
crons, and overwrite saved workflows — none of it subject to the operator's policy for the
batch. The h-builds-h loop runs implement legs continuously, so this is a standing condition,
not a one-off.

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
