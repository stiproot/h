**Status:** STUB (2026-07-14) — captures a strategy the user asked for while retiring claude-coder
(docs/plans/agent-process-identity.md). The "propagate everything" half is the current behaviour;
the "subset" half is the deferred follow-up. Not yet designed in detail.

# Agent env propagation: service → CLI subprocess

## The two strategies

When a CLI agent service (claude/openhands/pi) spawns its CLI subprocess, it must decide **which of
its own environment variables the child inherits**. Two strategies, selectable:

- **`all` (current, default).** The child gets the full service environment. Useful for **trusted**
  work — running the loop against repos we own — and for **experimenting** (any tool/credential the
  service holds is available to the CLI without ceremony). This is what h does today.
- **`subset` (deferred).** The child gets only what the CLI needs: LLM keys, a (possibly scoped)
  git token, `PATH`/`HOME`, model/base-url, `WORKFLOW_INSTANCE_ID`. Everything else — `LINEAR_API_KEY`,
  `NOTION_API_KEY`, `AWS_*`, `TESSL_TOKEN`, a broad `GH_TOKEN` — is withheld. This is the "env
  isolation" half of containing an untrusted spec: the UID split (increment 1) isolates *files and
  process*; env-subsetting isolates *secrets*.

## Where it stands today (the mechanics to change)

Everything the service holds flows to the CLI through two points, both currently pass-through:

- `packages/js/agent-cli/src/invoker.ts` — `mergeProcessEnv` builds the child env as
  `{ ...process.env, ...overrides }` (the whole service env).
- `packages/js/agent-cli/src/agents/run-process.ts` — the container-mode privilege drop wraps the
  spawn in `sudo --preserve-env`, so the drop to `SUB_AGENT_UID` does **not** narrow the env either.

Note: `AGENT_ENV_KEYS` in `packages/js/agent-cli/src/agents/types.ts` already enumerates the LLM keys,
but today it is used only for **validation** (`validateEnvironment`), not to scope what is passed. The
subset strategy would make it (extended with the git token + the runtime essentials) the actual
allowlist, applied at both points above.

## To flesh out later

- **Where the selector lives.** A per-run field on `AgentRequest` (`envStrategy: "all" | "subset"`),
  or folded into the per-run **trust profile** (docs/plans/reviewer-identity-security.md) so
  `trust: untrusted` implies `subset` — one binding, not two knobs. The profile framing is likely
  cleaner: env-subsetting, replace-mode MCP, and a scoped token are one capability-minimization
  decision, bound together at spawn.
- **The exact allowlist** for `subset`, and whether it is per-agent (claude vs openhands vs pi need
  different keys) or a shared core + per-strategy extension.
- **Fail-closed behaviour** — a `subset` run missing a required key must fail loudly at spawn, not
  silently run half-credentialed (the MCP-servers-down failure mode, CLAUDE.md "MCP servers are
  agent-runtime dependencies").
- **Local mode** — the drop is container-only; the env strategy should apply in both modes (a subset
  is a capability decision, not an OS one), gated the same config-signal way so host dev is unaffected.

Related: [[agent-process-identity]] (the UID split this complements), [[reviewer-identity-security]]
(the trust profile that would own the `subset` selection).
