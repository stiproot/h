# Codex on a ChatGPT subscription — host + container auth

Status: Active — Phase 1 (host mode) DONE + validated live on Plus; Phase 2 (container mode) code done, live-validated in the container e2e; CLI `--agent codex` wired
Established: 2026-07-23

## Goal

Today h's `codex-agent` authenticates **only** via `OPENAI_API_KEY` (billed at API pricing, separate from a ChatGPT plan). We want it to also run on a **ChatGPT subscription** (the user has Plus) using Codex's account auth — the `~/.codex/auth.json` credential produced by `codex login`.

Non-goal: the Enterprise-only `CODEX_ACCESS_TOKEN` / `codex login --with-access-token` path (the true analog of `claude setup-token`). That requires a ChatGPT **Enterprise** workspace admin to grant the access-token permission — unavailable on Plus. We may add it opportunistically (it's just another env var) but it is not the target.

## Background — the Codex auth landscape (researched 2026-07-23)

Codex CLI auth methods (sources: [learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth), [.../auth/ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)):

| Method | Command | Headless? | ChatGPT plan? | Produces |
| --- | --- | --- | --- | --- |
| Browser OAuth | `codex login` | No (needs browser) | ✅ incl. Plus | `~/.codex/auth.json` |
| Device code | `codex login --device-auth` | ✅ (enter a code) | ✅ incl. Plus | `~/.codex/auth.json` |
| API key | `printenv OPENAI_API_KEY \| codex login --with-api-key` | ✅ | ❌ (API pricing) | `~/.codex/auth.json` |
| Access token | `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token` | ✅ | Enterprise only | — |

Key properties of `auth.json` (the credential all account flows produce):
- Lives at `$CODEX_HOME/auth.json`, `CODEX_HOME` defaults to `~/.codex`. Contains ChatGPT-managed tokens + a `refresh_token`.
- **Stateful, self-refreshing.** Codex rewrites it in place when `last_refresh` is older than ~8 days or on a 401. So it must be **persistent + writable** across runs; never reseed it read-only every run (that discards refreshed tokens).
- **One `auth.json` per runner / serialized stream.** OpenAI's CI/CD guide explicitly says: do NOT share one file across concurrent jobs or machines — concurrent refresh invalidates the session.
- Treat like a password (plaintext access tokens).

## Findings — how h wires codex today (grounded 2026-07-23)

- **The gate.** `packages/js/agent-cli/src/agents/codex.ts` `validateEnvironment` HARD-REQUIRES `OPENAI_API_KEY` (checks `effectiveEnv` then `processEnv`; returns `createMissingEnvResult("Codex", "OPENAI_API_KEY")` when absent). This is the single thing that fails a keyless run. **This is the blocker.**
- **Env passthrough is already correct.** `packages/js/agent-cli/src/invoker.ts:161 mergeProcessEnv` builds the child env as `{ ...process.env, ...env }`. So the spawned `codex exec` subprocess **inherits the whole parent environment** — including `HOME` and `CODEX_HOME`. In host mode it therefore already resolves `~/.codex/auth.json` with no extra wiring. ✅ This is the load-bearing fact that makes host mode nearly free.
- **Runner injects only the key.** `apps/codex-agent/src/infrastructure/codex-runner.ts:25` reads `OPENAI_API_KEY` (default `""`); line ~90 injects `OPENAI_API_KEY` into the invoke env **only if non-empty**. An empty key injects nothing — fine, the child still inherits `HOME`.
- **Host run script.** `cli/scripts/run-codex-agent.sh:12` `export OPENAI_API_KEY="${OPENAI_API_KEY:-}"` (empty default). The script runs under the host user, so `HOME` → `~/.codex/auth.json` is present for a logged-in user.
- **Container.** `docker-compose.yml` `codex-agent` service: env `OPENAI_API_KEY`, `AGENT_BASE_DIR=/workspace/codex-agent`; volume `../h-workspace:/workspace`; healthcheck `which codex`. **No `~/.codex` / `CODEX_HOME` mount** → container mode has no account creds today. k8s manifest exists at `k8s/apps/codex-agent.yaml`.
- **CLI reachability caveat (dependency).** Firing codex through `h workflow run --agent codex` / `h chain run --agent codex` also needs the `AGENT_IDENTITY` + `AGENT_URLS` entries the CLI lacks — that is hardening-audit Phase 1 (A1/A18/A28), tracked separately in [[hardening-audit]] `docs/plans/hardening-audit/01-drift-fixes.md`. This plan is about the agent's AUTH; add the CLI wiring via that item (or fold a minimal `--agent codex` entry in here if it blocks testing).

## Approach

### Phase 1 — host mode (small, ready)

Make `codex-agent` run on the user's ChatGPT plan when no API key is set but `~/.codex/auth.json` exists.

- Relax `codex.ts` `validateEnvironment`: pass when EITHER `OPENAI_API_KEY` is present OR ChatGPT account auth is available. Decide the detection (see open questions) — leading candidate: an explicit opt-in signal (`CODEX_AUTH_MODE=chatgpt` or a `codexAuthMode` config) so the runner never silently assumes a mode; fall back to `OPENAI_API_KEY` as today. Avoid sniffing `~/.codex/auth.json` from inside `agent-cli` (it shouldn't reach into `$HOME`); prefer the runner passing an explicit flag.
- In `codex-runner.ts`, when the mode is chatgpt, optionally set `CODEX_HOME` explicitly (defaults to `~/.codex` anyway via inherited `HOME`) and skip the key injection.
- `run-codex-agent.sh`: document that a logged-in `~/.codex/auth.json` + unset `OPENAI_API_KEY` runs on the ChatGPT plan; optionally export `CODEX_AUTH_MODE`.
- **Verify:** with `OPENAI_API_KEY` empty and a logged-in `~/.codex/auth.json`, a `codex-agent` host-mode run completes and is billed to the ChatGPT plan (confirm via a real run, not just startup).

### Phase 2 — container mode

Give the container the same account creds, honoring the one-file-per-runner rule.

- Mount host `~/.codex` (or a dedicated `CODEX_HOME` dir) into the `codex-agent` container as a **writable, persistent** volume; set `CODEX_HOME`; leave `OPENAI_API_KEY` empty. Same for `k8s/apps/codex-agent.yaml` (a writable volume/secret — but a k8s Secret is read-only, so a refreshable file needs an `emptyDir`/PVC seeded once, not a Secret).
- **Concurrency guard (design decision).** The auth.json-per-runner rule conflicts with running multiple concurrent codex runs off one file. Options: (a) serialize codex-agent to one in-flight run; (b) per-run copy of auth.json (but concurrent refreshes of copies from one login are exactly what the docs warn against). Resolve in open questions before building.
- **Refresh persistence.** Ensure the mount persists across container recreates so Codex's in-place token refresh survives; never bake auth.json into the image or reseed read-only each run.

## Open questions

1. **Gate detection mechanism.** Explicit `CODEX_AUTH_MODE=chatgpt|apikey` env (fail-closed, no sniffing) vs. runner checks `auth.json` existence and passes a flag vs. accept-either (key wins). Leaning explicit env for a closed, testable contract — matches h's fail-closed conventions (cf. `MCP_CONFIG_MODE`).
2. **Container concurrency.** How to honor one-auth.json-per-runner under h's fleet model — serialize vs. per-runner file vs. document single-concurrency for the chatgpt mode. Needs a decision before Phase 2.
3. **k8s refreshable creds.** A Secret is immutable at runtime; a self-refreshing auth.json needs a writable volume seeded once. Is codex-in-k8s even in scope, or host/compose only for now?
4. **Enterprise access-token path.** Cheap to also support `CODEX_ACCESS_TOKEN` via `--with-access-token` for anyone who has Enterprise — worth adding in the same gate for completeness?

## Cross-links

- [[hardening-audit]] Phase 1 (A1/A18/A28) — the `AGENT_IDENTITY`/`AGENT_URLS` codex CLI wiring this plan depends on for `--agent codex` firing.
- [[agent-local-mode-bringup]] — sibling effort (making host/local mode easy for an agent to stand up); shares the host-mode ergonomics theme.
- Prior integration recipe: `docs/plans/agent-integration-playbook.md` (the per-agent wiring checklist codex should have followed).

## Log

- 2026-07-23 — Plan created. Research on Codex auth done (host `mergeProcessEnv` passthrough is the key enabler; Enterprise access-token path unavailable on Plus). Host-mode change scoped to relaxing the `codex.ts` `OPENAI_API_KEY` gate; container mode scoped to a writable `CODEX_HOME` mount + a concurrency decision.
- 2026-07-23 — **Phase 1 built + validated live on ChatGPT Plus.** Changes: (1) `agent-cli/src/agents/codex.ts` `validateEnvironment` now passes when `CODEX_AUTH_MODE=chatgpt` (or `CODEX_ACCESS_TOKEN`) is set, not only `OPENAI_API_KEY` — explicit opt-in, no `$HOME` sniffing (open question #1 resolved: explicit env). (2) `run-codex-agent.sh` exports `CODEX_AUTH_MODE`/`CODEX_HOME` and, **crucially, defaults `AGENT_MODEL` to empty in chatgpt mode**. (3) `codex.ts buildInvocation` now **omits `--model` when none is set** (was hardcoded `o4-mini`). 8 new + updated unit tests (27 pass). **Validated:** clean codex-agent host-mode run on `~/.codex/auth.json` with `OPENAI_API_KEY` empty — direct `codex exec` emitted `agent_message: CODEX-PLUS-OK` + `turn.completed`; the full `POST /run` path returned `turns:1, output:10 tokens, exit 0, model:""`.
  - **KEY FINDING (the non-obvious blocker): a ChatGPT-account plan REJECTS explicit API model ids** — `o4-mini` AND `gpt-5-codex` both returned `400 "not supported when using Codex with a ChatGPT account"` (and "model metadata not found"). The account default model is only used when `--model` is OMITTED. Hence the two model changes above. In API-key mode the runner still supplies `o4-mini`; an explicit `CODEX_MODEL` always wins.
  - Env-passthrough confirmed working: `invoker.ts mergeProcessEnv` = `{...process.env, ...env}` carried `HOME`/`CODEX_HOME`/`CODEX_AUTH_MODE` to the `codex` subprocess, so no runner plumbing beyond the config was needed.
  - Incidental: `bun install` had never populated a fresh install in this env (isolated `.bun` layout OK once checked); a transient codex-agent turbo build failure cleared after a direct `bun run build`. Not code issues.
- 2026-07-23 — **CLI wiring done ([[hardening-audit]] A1/A18/A28).** `config.py` AGENT_IDENTITY + AGENT_URLS gain codex (`run-codex`/`codex-agent`/:8016); `cli/h/tests/test_agent_identity_sync.py` guards that every shared-input run-* activity (auto-classified: Input has both `cwd` and `model`) is reachable via `--agent` (negative-tested). README port table/map/start-list updated. `h chain run --agent codex` / `h workflow run --agent codex` now resolve. 215 h-cli tests pass.
- 2026-07-23 — **Phase 2 (container mode) code done.** Reuses the existing `../h-workspace:/workspace` mount instead of a new volume: `cli/scripts/seed-codex-auth.sh` copies host `~/.codex/auth.json` (+config.toml) into `<workspace>/codex-home` with group-660 (AGENT_GID 10001) perms; the compose `codex-agent` service defaults `CODEX_AUTH_MODE=chatgpt`, `CODEX_HOME=/workspace/codex-home`, `AGENT_MODEL=` (empty ⇒ plan default). Verified the container runs as gid 10001 (agent-base `agent-svc`/`agent-cli`), so the group-660 file is readable+refreshable by the non-root user AND the dropped CLI user. Concurrency caveat: this seeds ONE container's file — don't run host + container codex on the same plan long-term (independent refreshes of two copies from one login can rotate each other's refresh_token). Live-validated in the container e2e (needs the FULL compose stack — can't mix with a host-configured infra per the docker-compose.local.yml caveat). k8s (writable seeded volume, not a Secret) is deferred (open question #3).
- 2026-07-23 — **MCP parity built + validated (the real unblock for codex in PR workflows).** codex-agent provisioned NO MCP, but the entire PR layer (create_pull_request, review-thread read/reply/resolve) runs on the github MCP — so `--agent codex` on feature-pr/revise would implement then fail at every PR step. Fixed: codex has global config (CODEX_HOME/config.toml), not per-cwd like claude's .mcp.json, so the runner writes a fresh config.toml into a DEDICATED h-managed CODEX_HOME (never the user's ~/.codex). Changes: `apps/codex-agent/src/infrastructure/codex-mcp-config.ts` (`mcpJsonToCodexToml` — translates h's .mcp.json → codex TOML: http→url+bearer_token_env_var, stdio→command/args/env, **sse SKIPPED** — codex uses streamable-http not sse, so dapr/obs/workflows can't be consumed; 7 unit tests); `codex-runner.ts` provisions config.toml into CODEX_HOME each run (non-fatal); `run-codex-agent.sh` CODEX_HOME→`<workspace>/codex-home` (dedicated, seeded) + MCP_CONFIG_SRC default; `seed-codex-auth.sh` seeds auth only (runner owns config.toml); compose mounts the .mcp.json + sets MCP_CONFIG_SRC. **Validated live:** a codex-agent `/run` on the Plus plan generated config.toml and called `github get_me` via MCP (`mcp_tool_call server="github"`). **Feasibility de-risked earlier:** direct `codex exec` with the config used `github list_pull_requests` successfully. Bonus finding: this also gives pi/any-CLI-agent a template for MCP parity. NB codex's `--url` is streamable-HTTP only, so h's SSE MCP servers (state/workflow/obs tools) remain a codex parity gap — fine for PR/coding workflows.
- **Remaining:** open questions 2–4 (container concurrency policy, k8s, Enterprise token path); the SSE-MCP parity gap (dapr/obs/workflows tools for codex) if codex work ever needs them.
