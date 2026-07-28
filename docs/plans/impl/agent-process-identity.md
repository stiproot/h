# Agent process identity & workspace permissions

Status: Complete — increment 1 (the fleet-wide OS process-identity model) landed and was validated end to end 2026-07-14; increment 2 was resolved by simplification rather than built, and its two halves are parked as their own Deferred plans
Established: 2026-07-13

Lifted to:
- The non-root fleet model (`AGENT_UID` server / `SUB_AGENT_UID` dropped CLI / shared `AGENT_GID`) → the CLAUDE.md host⇄compose workspace-interchangeability gotcha + the auto-memory `agent-process-identity`.
- The one-time provisioning step and the group self-heal → `cli/scripts/setup-agent-workspace.sh` and `cli/scripts/_lib.sh`, both citing this doc; operator steps in [docs/h-builds-h-runbook.md](../../h-builds-h-runbook.md).
- The privilege-drop spawn path and its env consequences → `packages/js/agent-cli/src/agents/run-process.ts` + `docker/agent-entrypoint.sh`, both citing this doc.
- The per-uid bun-cache isolation this surfaced → the CLAUDE.md toolchain-guard gotcha.
- Increment 2's two halves → [reviewer-identity-security](../reviewer-identity-security.md) (the capability binding) and [agent-env-propagation](../agent-env-propagation.md) (the env `subset` strategy), both Deferred with the same revisit trigger.

**Increment 2 — resolved by SIMPLIFICATION, not built (2026-07-14).** Rather than build the per-run trust profile, the user chose to embrace the trust model (we own the repos the fleet works in) and **retire claude-coder outright** — review-pr and the h-builds-h loop now run on the trusted claude-agent. The OS process-identity model (this plan's core) is unchanged and still carries the untrusted CLI's file/UID isolation.

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
  uniform guarantee. **That narrowness is now ENFORCED, not merely assumed** (2026-07-28, audit
  item A16): `write_file`/`read_skill` take a MODEL-supplied path, and `cwd / path` is not
  containment — an absolute path or `..` walked straight out of the workspace. All three apps now
  route through `agent_core.workspace_paths.contained_path` / `safe_name`, which resolve (so a
  symlink pointing out is caught too) and fail loud. Without it, "narrower tool surface" was doing
  load-bearing work in this trust argument while the tools could write anywhere the service uid
  could reach. Strong drop-isolation is a property of subprocess-spawning agents only; giving a
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

1. **Process identity** (this plan's core, DONE): `AGENT_UID` / `SUB_AGENT_UID` / `AGENT_GID`,
   entrypoint bootstrap, config-gated sudo drop. (Env-scrubbing was scoped OUT — see increment 2 —
   and is now the env-propagation stub.) claude-coder unchanged at this point.
2. **Per-run trust profile — DEFERRED, superseded by simplification (2026-07-14).** The intent was
   to bind {`SUB_AGENT_UID`, replace-mode github-only MCP, scoped token, env `subset`} at spawn for
   untrusted runs and move the boundary from service to run. Instead we **embraced the trust model
   and retired claude-coder** (owned repos need no per-run isolation). What actually landed: delete
   the claude-coder service + activity + wiring, repoint pr-review/the loop to claude-agent. The
   profile itself is documented for later in docs/plans/reviewer-identity-security.md (the capability
   binding) + docs/plans/agent-env-propagation.md (the env `subset` half).

## Validated on openhands (2026-07-13) + migration requirements it surfaced

Proven end-to-end on openhands-agent: the server runs non-root as `agent-svc` (10001), the runner
drops the CLI to `agent-cli` (10002) via `sudo`, and a real feature run implemented + pushed a PR,
editing files in the group-writable worktree. The isolated proof surfaced requirements a fleet-wide
rollout must honour:

1. **Common `AGENT_UID`/`SUB_AGENT_UID`/`AGENT_GID` across ALL agents — required, not optional.** Each
   agent's entrypoint chowns the SHARED roots (`.runs`, `worktrees`) to its own `AGENT_UID`, so a
   half-migrated fleet with different UIDs *fights over the shared dirs* (observed: openhands@10001 vs
   the stopgap claude-coder@1001, last-writer-wins). Cross-agent isolation is the container boundary,
   not the UID, so a common UID is both correct and necessary. (Defaults chosen: UID 10001 / sub 10002
   / GID 10001 — high, to dodge the `bun` user at 1000.)
2. **The shared clone (`clonePath`) needs the same ownership as the workspace roots.** `git worktree`
   writes the clone's `.git`, so the clone must be `AGENT_UID:AGENT_GID`, group-writable + setgid — but
   it is NOT one of the entrypoint's per-agent dirs, so provisioning (whoever clones the repo) must set
   it, or the entrypoint must be told the clone path.
3. **One-time recursive migration chown of the existing workspace.** Months of root/1000/1001-era runs
   left `../h-workspace` littered with mixed-owner dirs the non-root `agent-svc` can't write. Migrating
   needs a one-time `chown -R AGENT_UID:AGENT_GID` + `chmod -R g+w` + setgid-on-dirs of the workspace;
   thereafter setgid + `umask 002` keep new files consistent.
4. **Migration is all-agents-at-once**, a consequence of (1) — the fleet shares the workspace, so agents
   can't be migrated one at a time in a running stack.

Rollout order, therefore: apply the model with the COMMON UIDs to every agent image (CLI agents get the
full split; Python agents get the baseline), do the one-time workspace + clone chown, then bring the
whole stack up together and validate a full chain.

Related: [[compose-mode-enabled]], [[harden-by-encoding]]; supersedes the #36/#38 entrypoint and
fleshes out docs/plans/reviewer-identity-security.md.
