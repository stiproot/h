**Status:** STUB (2026-07-09) — a placeholder to be fleshed out.
**RELAXED under the trust model (2026-07-14):** claude-coder was retired and pr-review now runs on
the trusted claude-agent — see "Current posture" below. This doc is now the home for reintroducing a
minimal-surface reviewer as a **per-run trust profile** if/when untrusted third-party repos appear.
**Living doc** — flesh out when reviewer-identity flexibility is actually needed.

# Reviewer identity: minimal-surface executors for untrusted-input workflows

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
