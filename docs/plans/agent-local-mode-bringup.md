# Agent-friendly local-mode bring-up

Status: Active — Phases 1–2 landed + validated e2e (ground-up host-mode rebuild, all 7 services UP); Phase 3 docs done, `make check-env-local` deferred
Established: 2026-07-23

## Goal

An agent running in a session (no TTY, no human, no terminal multiplexer) should be able to:
1. stand up the supporting infra, then
2. bring up the h app services in **local / host mode** (services on the host via `dapr run`, infra in Docker Compose), and
3. know when the stack is UP,

using idempotent, detached, returning commands. Today the only multi-service launchers are interactive zellij targets — unusable headless.

## Background — what "local/host mode" is

Host mode = **infra in Docker Compose** + **app services on the host via the `dapr` CLI** (`dapr run`) (README.md:124-126). No `dapr init` is used anywhere (zero matches in scripts/Makefile/docs); the `dapr` CLI binary is still required for `dapr run`/`dapr stop`. Name resolution is the SQLite resolver at `/tmp/dapr-h-nr.db` (README.md:307). The Helm `dapr-install`/`dapr-uninstall` targets (Makefile:140-154) are the k8s/Tilt path — irrelevant here.

## Findings — current bring-up landscape (grounded 2026-07-23 via a repo sweep)

**Already headless-clean:**
- `make infra-up` (Makefile:66-68) = `compose.sh --profile infra … up --build -d` — detached, idempotent, returns cleanly. Starts placement :50006, scheduler :50007 (+etcd volume), redis :6379, zipkin :9411, loki :3100, alloy, grafana :3000 (docker-compose.yml:8-92). `docker-compose.local.yml:1-7` overrides the scheduler broadcast host so host `daprd` can reconnect. **This is the only part of bring-up that already works unattended.**
- Services required-before-services: placement + scheduler + redis. Every run script hard-codes `--placement-host-address localhost:50006 --scheduler-host-address localhost:50007` (e.g. run-workflow-svc.sh:29-30).

**Per-service scripts are idempotent but foreground-blocking:**
- Each `cli/scripts/run-*.sh` sources `.env`, runs the tsc guard + turbo build, sources `_lib.sh`, calls `stop_stale`, then `exec dapr run … -- …` — **foreground, PID-replacing, never returns** (e.g. run-workflow-svc.sh:23-34, run-claude-agent.sh:50).
- `stop_stale` (`_lib.sh:53-77`): `dapr stop --app-id` then frees the pinned ports (SIGTERM→SIGKILL after 3s). Makes every script safe to re-run — the key primitive to build on.
- Group/umask self-heal (`_lib.sh:21-42`, `_agent_enter_group`): re-execs under `sg <grp>` + sets `umask 002` so host runs don't need `newgrp` **if the group already exists** — but only for scripts matching `run-*.sh` and only when the user is a member "on paper".
- Unique port allocation per service (README.md:266-293) — any subset runs simultaneously.

**The blockers for a headless agent (all in the orchestration layer + one-time provisioning):**
1. **No "start all services detached" command that returns.** The only multi-service launchers are four zellij targets — all need a TTY:
   - `make dev` (Makefile:196-202) — refuses outside a plain terminal; creates a zellij session from `.zellij/dev.kdl`.
   - `make dev-tab` (Makefile:204-205), `make h-builds-h` (:214-221), `make h-builds-h-tab` (:223-224) — need an already-running zellij server; use `.zellij/dev.kdl` / `.zellij/h-builds-h.kdl`. No tmux anywhere.
   - The `.kdl` layouts (.zellij/dev.kdl:9-25, .zellij/h-builds-h.kdl:7-22) enumerate one pane per service — i.e. **the authoritative service list per mode already exists as data.**
2. **The pane wrappers block by design.** `_pane.sh:25` drops to `"${SHELL}" -i` (interactive shell) after the service exits; `_supervise.sh:22-44` loops forever restarting the service. Correct for appliance panes, wrong for a call that must return.
3. **No host-mode readiness signal.** Compose healthchecks (docker-compose.yml:266-272, :471) are compose-only. Host `dapr run` has no aggregated "UP" probe — though every agent serves `GET /dapr/subscribe` on its app port and each sidecar serves `/v1.0/healthz` on its `35xx` port, so the signals exist, just unaggregated.
4. **One-time host provisioning needs sudo + re-login.** `setup-agent-workspace.sh:26-29` requires root; the runbook (docs/h-builds-h-runbook.md:64-68) then needs `newgrp agent`/re-login. After the group exists, `_lib.sh`'s `sg` self-heal makes the run step non-interactive — so the residual is only the one-time `sudo` group creation.
5. **Env/auth pre-provisioning.** `.env` must carry `ANTHROPIC_API_KEY` (or a pre-generated `CLAUDE_CODE_OAUTH_TOKEN`), `ANTHROPIC_BASE_URL`, `GH_TOKEN`; run-claude-agent.sh:15-23 hard-fails otherwise. Config, not code — non-interactive if provided as keys.

**Affordances to reuse verbatim:** `make infra-up` (detached), `stop_stale` (idempotent replace), the `sg`/`umask` self-heal, `compose.sh` (deterministic `.env`), the per-mode `.kdl` service lists, and `_supervise.sh`'s restart-backoff logic (2s→30s, give up after 5 fast fails).

## Approach

### Phase 1 — a detached, returning multi-service launcher

Add a headless entrypoint (e.g. `cli/scripts/up-local.sh` + `make up-local` / `make down-local`) that:
- reads the service list for a mode (reuse the `.zellij/*.kdl` enumeration as the single source of truth, or a small shared list both the kdl and the launcher derive from — avoid a second drifting list),
- for each service, launches its existing `run-*.sh` **detached** (`setsid`/`nohup`, or `_supervise.sh` backgrounded to get restart-on-exit) with stdout/stderr to `AGENT_RUNS_DIR`-adjacent log files,
- returns immediately with the PIDs/log paths,
- `make down-local` stops them (reuse `stop_stale` per service).
- Does NOT touch the zellij targets — they stay the human ergonomic path; this is the headless sibling.

### Phase 2 — a host-mode readiness probe

Add `make wait-local` / `cli/scripts/wait-local.sh`: poll each service's `GET /dapr/subscribe` (app port) and/or sidecar `/v1.0/healthz` (`35xx`) until all report ready or a timeout, then exit 0/nonzero. Gives an agent a deterministic "stack UP" gate. Endpoints already exist (README.md:3); this just aggregates them for host mode.

### Phase 3 — provisioning ergonomics (make the one-time setup discoverable + non-interactive-after-first-run)

- Document the one-time `sudo cli/scripts/setup-agent-workspace.sh` as an explicit pre-provisioning step an operator runs ONCE (outside the agent), after which `_lib.sh`'s `sg` self-heal keeps every run non-interactive.
- Codify the `.env` key contract (which keys must be present for a headless bring-up) — ideally a `make check-env-local` that fails loudly listing missing keys before launch, reusing/complementing the hardening-audit `check-env-parity.mjs` idea.

## Open questions

1. **Launcher process model.** `setsid`+`nohup` (simplest, no restart) vs. backgrounded `_supervise.sh` per service (restart-on-exit, matches the supervised zellij layout). Leaning `_supervise.sh` backgrounded — reuses existing logic and gives self-healing, which the unattended cron loop wants.
2. **Service-list single source of truth.** Parse `.zellij/*.kdl`, or extract a shared `services.<mode>.txt`/array both the kdl generation and the launcher consume? A drifting second list is exactly the anti-pattern the [[hardening-audit]] steering guard targets — pick one home.
3. **Scope of "all services".** Minimal loop set (workflow-svc + one agent + the MCP servers) vs. the full dev set. Probably a mode arg mirroring `dev` vs `h-builds-h`.
4. **Where logs go / how the agent reads them.** Reuse `AGENT_RUNS_DIR` conventions, or a dedicated `.local-logs/`? Must be greppable for the readiness/debug path.

## Cross-links

- [[codex-chatgpt-auth]] — sibling effort; both are about making host/local mode first-class. A headless launcher should bring up `codex-agent` too, so the codex auth mode (host) and this launcher compose.
- [[hardening-audit]] — the steering guard + `check-env-parity.mjs` ideas overlap with Phase 3's env-contract check; the "single source of truth for a list" principle applies to the service list.
- docs/h-builds-h-runbook.md — the human runbook this makes an unattended sibling of; the zellij targets stay the interactive path.

## Log

- 2026-07-23 — Plan created from a repo landscape sweep. Key result: infra bring-up + per-service scripts are already idempotent and non-interactive at the process level; the only real gaps are (1) a detached returning multi-service launcher and (2) a host-mode readiness probe, both buildable by reusing existing scripts (`stop_stale`, `_supervise.sh`, the `.kdl` service lists) verbatim. Blockers are the zellij/TTY orchestration layer and the one-time sudo group provisioning.
- 2026-07-23 — **Phases 1–2 built + validated end-to-end.** Added `cli/scripts/_services.sh` (canonical mode→services list; ports/app-ids parsed from run scripts, not duplicated), `up-local.sh` (detached `setsid`+`_supervise.sh` launcher, returns immediately, logs → `.local-logs/`), `wait-local.sh` (TCP app-port readiness gate), `down-local.sh` (kill supervisor process-group → `stop_stale`), and Makefile targets `up-local`/`wait-local`/`up-local-wait`/`down-local` (`MODE=dev|h-builds-h`). **Validated via a genuine ground-up rebuild:** full `compose … down -v --profile all` + cleared `./dapr-etcd` bind + `/tmp/dapr-h-nr.db` → `make infra-up` → `up-local dev` (returned instantly, 7 supervisors detached) → `wait-local dev` (all 7 UP in <330s) → functional checks (`/workflow/list`, `/dapr/subscribe`) green, no supervisor restarts, `dapr list` showed 6 host-mode apps on fresh host ports. **Open question #2 resolved:** `_services.sh` is the single source of truth; drift from the `.zellij/*.kdl` pane set is now caught by `scripts/check-services.mjs` (wired into `bun run lint`, negative-tested). **Phase 3 (docs):** README §4 gained a "Headless / agent-driven bring-up" block; CLAUDE.md gained a "Headless host-mode bring-up" gotcha (incl. the true-from-scratch reset: `down -v --profile all` + `./dapr-etcd` bind clear + `/tmp/dapr-h-nr.db`). Learning: `./dapr-etcd` is a BIND mount, so `compose down -v` does NOT clear it (named-volume only) — a real from-scratch needs it cleared explicitly; and `docker compose down` ignores profile-gated services unless `--profile all`/`COMPOSE_PROFILES=all` is passed. Remaining: `make check-env-local` (Phase 3 env contract) deferred.
