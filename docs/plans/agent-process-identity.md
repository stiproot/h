# Agent process identity & workspace permissions

Status: **design, agreed** (2026-07-13). Supersedes the per-agent claude entrypoint merged in #38.

## Problem

Agent process identity is inconsistent across the fleet, and the inconsistency is load-bearing in the
wrong way:

| agent | runs as |
| --- | --- |
| claude-agent / claude-coder | non-root (UID 1001) |
| openhands, pi, dapr-agent, langgraph, workflow-agent, dapr-claude-loop, claude-managed | **root** |

Only claude is non-root, and only because the claude CLI refuses to run as root — everything else
sidesteps the question by running as root. That is the deeper problem: agents that execute untrusted,
spec-driven work should not be root. The claude CLI's root-refusal is the canary, not a claude quirk.

The permission workaround (#38) was also per-agent (a claude-only entrypoint), and even that was
wrong twice — it chowned a hardcoded `/workspace/claude-agent` (missing claude-coder's
`/workspace/claude-coder`) and used `su-exec` (Alpine) on a Debian base. Both slipped through because
the loop's verify runs unit tests, never the Docker build. This plan replaces point-patching with a
fleet-wide model.

## The model

Two non-root identities plus one shared group:

- **`AGENT_UID`** — the `agent-server` process (trusted: `/run`, `/setup`, `/clone`, `/worktree`,
  run-ledger). Never root.
- **`SUB_AGENT_UID`** — the spawned CLI subprocess (untrusted, spec-driven work: claude / openhands /
  pi). Distinct, lower-trust, non-root. Exists ONLY for CLI-spawning agents.
- **`AGENT_GID`** — a single shared group, fixed across every agent image, that grants access to the
  shared `/workspace` bind mount.

`SUB_AGENT_UID` is the identity of the *spawned subprocess*, not "the untrusted one" in the abstract.
It exists because there's a subprocess to put it on.

### Agent taxonomy — the split only applies where there's a subprocess

- **CLI-spawning agents** (TS: claude, openhands, pi): the `agent-server` runs as `AGENT_UID` and
  spawns the CLI dropped to `SUB_AGENT_UID`. The privilege boundary is real because the untrusted
  work is in a *separate process*. Strong drop-isolation.
- **In-process agents** (Python: dapr-agent, langgraph, workflow-agent, dapr-claude-loop, and the
  standalone claude-managed): the agentic loop runs in-process — there is no subprocess. The whole
  process runs as `AGENT_UID`; `SUB_AGENT_UID` does not apply. **Their untrusted work runs at service
  privilege, undropped** — you cannot drop privilege within a single address space. This is
  acceptable because their tool surface (`search_skills`/`install_skill`/`read_skill`/`write_file`)
  is far narrower than the CLI agents' arbitrary shell, but it is a genuine distinction, not a
  uniform guarantee. Strong drop-isolation is a property of subprocess-spawning agents only; giving a
  Python agent the strong boundary would mean moving its tool execution into a subprocess — a
  separate, larger change.

### UID/GID choices

- `AGENT_GID` is **fixed and load-bearing** — it's what lets a file written by one agent's process
  (`SUB_AGENT_UID:AGENT_GID`, group-writable + `setgid`) stay accessible to another agent's process on
  the shared mount. Cross-agent isolation comes from the **container boundary**, not the UID, so the
  UIDs need not match across agents.
- `AGENT_UID` / `SUB_AGENT_UID` are **per-image knobs**. Common values are simplest; per-agent values
  buy private-by-UID files for each agent's non-shared state. Default per-agent; keep the GID fixed.

## Mechanism

A non-root process cannot change a subprocess's UID by itself (`setuid` needs privilege). So the
drop uses the suEXEC pattern — a scoped, privileged helper — not raw `setuid`:

1. **Root entrypoint — the single privileged moment.** Shared across all agent images (both `oven/bun`
   and `uv:python` are Debian, so `gosu` works for all). It:
   - ensures the workspace roots (`$AGENT_BASE_DIR`, the shared `.runs`, `worktrees`) exist and are
     owned `AGENT_UID:AGENT_GID`, group-writable + `setgid` (new files inherit the group);
   - `exec`s the server dropped to `AGENT_UID` via `gosu`.
2. **Server → CLI drop.** The `agent-server` (running as `AGENT_UID`) launches the CLI via
   `sudo -u SUB_AGENT_UID` with a narrow sudoers rule
   (`AGENT_UID ALL=(SUB_AGENT_UID) NOPASSWD: <cli path>`) — or a minimal setuid helper. sudo is the
   audited, scoped way to let the non-root server drop the subprocess and nothing else.

The privileged surface shrinks to two tiny, auditable things: the entrypoint init and the scoped
sudoers rule. Everything else is non-root.

## Env isolation (the other half of containing an untrusted spec)

The UID split isolates *files and process*; it does not hide secrets, because the runner currently
merges the server's `process.env` into the CLI's env (`agent-cli/src/invoker.ts`), so the CLI
inherits `GH_TOKEN` / API keys regardless of UID. Fold in: the runner passes the CLI **only the env
it needs**, not the full server environment. UID split + env-scrubbing together are what actually
contain an untrusted spec.

## Local-mode invariant (the load-bearing guardrail)

Local (host run-script) mode runs agents as the **host user, no container, no entrypoint** — the host
user already owns the workspace, so none of this must engage. Two rules guarantee it:

1. **Entrypoint, user/group creation, and the sudoers rule live only in the Dockerfiles/images.**
   Local mode never invokes an entrypoint, so it is inherently unaffected.
2. **The drop in the shared runner is config-gated, not unconditional.** The runner is shared code
   used by both modes; if it always ran `sudo -u SUB_AGENT_UID` it would break local runs. Gate it on
   a config signal (`SUB_AGENT_UID` set → wrap the spawn in `sudo -u`; unset → spawn directly as the
   current user — today's path). Docker sets it; the run-scripts do not. **This gate is the single
   most important line in the design** — it keeps container hardening out of the host dev loop.

## Rollout

- One **shared entrypoint script** (single home; `COPY`'d into every agent image).
- One **shared runner change** in `agent-cli` — the config-gated `sudo -u SUB_AGENT_UID` drop.
- Per image: create the `AGENT_UID`/`SUB_AGENT_UID` users + `AGENT_GID` group (build args), set
  `ENTRYPOINT`. claude's bespoke #38 entrypoint collapses into the shared one.
- Compose: pass the UIDs/GID.
- **Verify with an actual `docker compose build` + a run** — the gap that let #38's `su-exec` and
  hardcoded-dir bugs through was that only unit tests ran, never the image build.

## End state: the per-run trust profile (retire claude-coder)

`SUB_AGENT_UID` isolates the untrusted CLI at the **OS layer** (files, UID, inherited env). It does
NOT cover the **capability layer** — which MCP tools and secrets the agent can reach over HTTP. That
capability minimization is exactly what **claude-coder** provides today, at the *service* level:

1. `MCP_CONFIG_MODE=replace` — never inherit the cwd's `.mcp.json` (a target repo can't smuggle in a
   server).
2. github-only MCP surface — no `workflows`/`dapr`/`obs` tools, no `notion`/`linear` secret-bearing
   servers.
3. a scoped token (`GH_CODER_TOKEN`: contents + PR write, no issue write).
4. frozen as pr-review's executor (reviewer-identity-security.md) so no fire re-points it.

claude-coder is a *separate service* only because those restrictions are bound at the service level.
The end state binds the untrusted boundary **per run** instead: when the server drops the CLI to
`SUB_AGENT_UID`, it also hands that spawn a **stripped profile** — replace-mode + github-only MCP,
scoped token, no secret env. A single `claude-agent` then serves both trusted and untrusted tasks by
profile, and **claude-coder as a separate service is retired.**

This is the fleshing-out of `docs/plans/reviewer-identity-security.md`: its "minimal-surface property"
(github-only tools, no secret-bearing MCP, config-replace) becomes a **per-run binding** rather than a
per-service deployment, and the frozen-executor invariant becomes "pr-review runs with the untrusted
**profile**" — the security control is the profile, not a specific service.

### Increments

1. **Process identity** (this plan's core): `AGENT_UID` / `SUB_AGENT_UID` / `AGENT_GID`, entrypoint
   bootstrap, config-gated sudo drop, env-scrubbing. claude-coder unchanged.
2. **Per-run trust profile**: bind {`SUB_AGENT_UID`, replace-mode github-only MCP, scoped token} at
   spawn for untrusted runs; move the untrusted boundary from service to run; **retire claude-coder**.

Related: [[compose-mode-enabled]], [[harden-by-encoding]]; supersedes the #36/#38 entrypoint and
fleshes out docs/plans/reviewer-identity-security.md.
