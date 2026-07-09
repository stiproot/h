**Status:** STUB (2026-07-09) — a placeholder to be fleshed out; captures a ruling made during the
chain-composition-surface work so it isn't lost. Not yet designed.
**Living doc** — flesh out when reviewer-identity flexibility is actually needed.

# Reviewer identity: minimal-surface executors for untrusted-input workflows

## The invariant (what exists)

`pr-review`'s executor is hardcoded to **claude-coder** deliberately: the PR diff it reads is
untrusted third-party text, so the reviewing agent's tool surface is minimized — github-only MCP,
no workflows/dapr/obs tools, no Linear/Notion secrets, and `MCP_CONFIG_MODE=replace` so it never
inherits a target repo's own servers. Identity-as-params (chain-composition-surface §1.9) applies
to every other template, but making pr-review's executor a fire-time param would let any fire
re-point the reviewer at a full-tool agent. It got the `modelReview` param only.

## Interim ruling (2026-07-09)

`--agent` on a frozen-executor hop **logs a warning and defaults to the hardcoded executor** — it
does not error, and it must never silently comply. The warning names the invariant and this doc.

## To flesh out later

- An **allowlist of minimal-surface reviewer agents** (the property that qualifies an agent:
  github-only tools, no secret-bearing MCP servers, config-replace mode) — so "review with
  openhands" becomes possible by standing up an openhands deployment with claude-coder's posture.
- Where the allowlist lives (chart values? workflow-svc config?) and who enforces it (CLI warning
  vs engine refusal).
- Whether the same treatment applies to other untrusted-input workflows as they appear (issue
  triage on third-party issue text, etc.).
