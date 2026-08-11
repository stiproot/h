# Moonshot Kimi as an h executor

Status: Complete — PR #98 MERGED 2026-07-29 (`fb08be6`) on full evidence: gate green on the
merge result, live e2e `run-kimi → kimi-agent → claude CLI → Moonshot` COMPLETED with tool
use ($0.27), PR CI green on the self-hosted runner, review loop (claude+openhands panel →
revise → re-review) finalized CLEAN
Established: 2026-07-28
Lifted to: CLAUDE.md (kimi-agent app-tree entry, `run-kimi` activity, the Moonshot
limitations gotcha — landed with the PR itself); the KIMI_MODEL-not-AGENT_MODEL convention
is encoded at its points of use (`cli/scripts/run-kimi-agent.sh` comment, `.env.example`,
docker-compose.yml); `run-kimi` sits in the gated activity map so the executor policy
(docs/plans/live-state-containment.md §2.3) covers kimi with no extra wiring; Route B/C
research stays in this archived body as the record of the road not taken.

**Resume point: [harness-batch-continuation](./harness-batch-continuation.md) §1.** In short:
#98 is green on the full gate with 19 of 20 review threads resolved, and the model id was
found WRONG by a live call (`kimi-k3[1m]` → 404; the real id is `kimi-k3`) and fixed in
`40c5f72`. Still required before merge: the live end-to-end run through
`run-kimi` → `kimi-agent` → the CLI (this plan's own acceptance criterion — the direct API
call proves the endpoint, not the plumbing), a re-verify at head after the model fix, and a
merge decision on a review loop that capped without reviewing the current head.

## Goal

Make Moonshot's Kimi models available as an h executor, reachable as `--agent kimi` on
`h workflow run` and `h chain run`, without disturbing the existing claude / openhands /
pi / codex executors. `MOONSHOT_API_KEY` and `MOONSHOT_BASE_URL` are already in `.env`.

**Note what `.env` actually carries:** `MOONSHOT_BASE_URL=https://api.moonshot.ai/v1` — the
**OpenAI-compatible** endpoint. The Anthropic-compatible endpoint is a *different path*
(`https://api.moonshot.ai/anthropic`) on the same host. Which of the two we use is the
whole substance of the route choice below, so the value already in `.env` should not be
read as a decision.

## Research findings (2026-07-28)

Three viable routes exist. All three were verified against vendor documentation AND against
h's own source — the code findings are what separate them, and they are not obvious from
the vendor docs.

### Route A — the `claude` CLI against Moonshot's Anthropic-compatible endpoint

Moonshot publishes an **official** Claude Code integration
([platform.kimi.ai](https://platform.kimi.ai/docs/guide/claude-code-kimi)):

| Setting | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.moonshot.ai/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | the Moonshot API key |
| `ANTHROPIC_MODEL` | `kimi-k3` |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` | `kimi-k3` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `kimi-k3` |
| `ENABLE_TOOL_SEARCH` | `false` — **unsupported on this endpoint** |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `1048576` (K3's 1M context) |

Documented limitations: **WebFetch is unavailable** and **Tool Search is unsupported**.
Alternative models `kimi-k2.7-code` / `kimi-k2.7-code-highspeed` exist but *require thinking
enabled* and 400 without it — so `kimi-k3` is the only zero-configuration choice, and the
plan uses it.

Precedent in this repo: the DeepSeek driver does exactly this shape
(`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_AUTH_TOKEN`,
[docs/DRIVER.md](../../DRIVER.md)) and was live-validated through tool use, MCP, and a
cold-start check-in ([model-fallback-continuity](../model-fallback-continuity.md) Phase 1).

**But that precedent runs the HOST claude CLI directly, never through `claude-agent`'s
runner — and the runner path has two blockers the driver path never touches.** Both were
found by reading the code, not the docs:

1. **`validateEnvironment` does not know `ANTHROPIC_AUTH_TOKEN`.**
   `packages/js/agent-cli/src/agents/claude.ts` accepts `ANTHROPIC_API_KEY` **or**
   `CLAUDE_CODE_OAUTH_TOKEN` and nothing else, so a Moonshot-configured run fails the gate
   before spawning. This is the same shape as codex's `OPENAI_API_KEY` gate, which was
   solved with an explicit `CODEX_AUTH_MODE` opt-in.

2. **The LiteLLM preflight breaks on an Anthropic-shaped base URL — this is the sharp one.**
   `adaptToLiteLlmEffect` (`packages/js/agent-cli/src/lib/litellm.ts`) fires whenever
   `llmConfig.baseUrl` is set, and GETs `{baseUrl}/v1/models`, failing the run if the model
   is not listed. With `baseUrl = https://api.moonshot.ai/anthropic` that resolves to
   `https://api.moonshot.ai/anthropic/v1/models`, which is not a models-list endpoint — so
   the run dies in preflight, before the CLI is ever invoked.
   The mismatch is structural: **the preflight assumes the base URL is an OpenAI-shaped
   LiteLLM proxy, while the `claude` CLI requires an Anthropic-shaped one.** Note Moonshot
   *does* serve `https://api.moonshot.ai/v1/models` — the host is fine, the path is not.

### Route B — the Kimi Code CLI as a new agent service

Moonshot ships a real terminal coding agent: **`MoonshotAI/kimi-code`**, MIT, TypeScript,
command `kimi`, `npm i -g @kimi-code/cli`. (`MoonshotAI/kimi-cli` is the **legacy**
predecessor — `kimi migrate` exists precisely to move data off it. Any recipe found online
should be checked against which of the two it targets.)

It clears h's hard bar — a headless mode with a parseable stream
([reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)):

- `-p/--prompt <prompt>` runs a single prompt non-interactively;
  `--output-format text|stream-json` (only valid with `--prompt`).
- `-m/--model`, `-S/--session`, `-c/--continue`, `--add-dir`, `--skills-dir`.
- **Permissions:** `-p` is *incompatible* with `--yolo`/`--auto`/`--plan` because
  non-interactive mode already applies auto-permission ("static deny rules remain active").
  So there is no autonomy flag to pass — unusually clean.
- `KIMI_CODE_HOME` overrides `~/.kimi-code`.

Two properties make it more work than it looks:

- **Auth cannot come from the shell environment.** Provider credentials resolve
  `api_key` field → `[providers.<name>.env]` sub-table → **failure, with no shell-env
  fallback**. So a headless run needs a generated `config.toml`
  (`[providers.kimi] type="kimi" base_url=… api_key=…`). This is precisely the codex
  `config.toml` provisioning pattern, and `KIMI_CODE_HOME` inherits the codex lesson too:
  **it must be container-private**, never the host-shared workspace.
- **The stream-json schema is OpenAI-shaped**, not Claude-shaped:
  `{role, content, tool_calls[]}` and `{role:"tool", tool_call_id, content}`. A new parser
  is needed, and the docs surface **no session id and no token/cost accounting** in print
  mode — so runs would report a `costGap` (which h tolerates by design, and must never
  fabricate as `$0`).

### Route C — openhands (LiteLLM) against Moonshot's OpenAI-compatible endpoint

`openhands.ts` already emits a LiteLLM-style `openai/<model>` against `LLM_BASE_URL`, and
`MOONSHOT_BASE_URL` is already the `/v1` endpoint — so this is **zero new code**. The
catch is that openhands holds exactly one BYOK pair (`LLM_API_KEY`/`LLM_BASE_URL`) and it
is currently DeepSeek's. Pointing it at Moonshot **displaces DeepSeek rather than adding
Kimi**, and DeepSeek is presently the live fallback executor.

## Recommendation — Route A, with B deferred behind a trigger

**Build `kimi-agent`: the `claude` CLI, on the existing claude strategy, against Moonshot's
Anthropic-compatible endpoint, as its own thin service with the env baked.**

Why:

- **It buys a working executor for the least new surface.** No new CLI strategy, no new
  stream parser, no new cost path. The claude CLI is h's most-exercised executor — MCP,
  skills, the whole PR flow (create PR, read/reply/resolve review threads) work on day one,
  which is exactly what pi still cannot do ([pi-chain-participation](../pi-chain-participation.md)).
- **It matches the precedent that already succeeded**, and the shape the fallback plan
  already leaned toward for DeepSeek: "(b) a `<provider>-agent` service — a thin clone with
  the env baked (cleaner isolation, one more service)".
- **Route C is rejected as a build target** because displacing the live DeepSeek fallback to
  gain Kimi is a straight downgrade in availability. It stays available as a zero-cost
  *experiment* (flip openhands' env for one run), and is the right answer only if Kimi
  replaces DeepSeek outright.
- **Route B is deferred, with a named trigger:** build it when we want Kimi's *own* agent
  behaviour (K3 subagents, its skills/hooks system, video input) rather than Kimi-the-model
  — or if Route A's endpoint proves too lossy (see risks). The research above is the head
  start; nothing in Route A blocks it later.

### The honest cost of Route A

It is *not* free — it needs a real change in `agent-cli`, and the plan should not pretend
otherwise. Two decisions to make, both mirroring existing house style:

1. **Auth gate.** Relax `claude.ts` `validateEnvironment` to also accept
   `ANTHROPIC_AUTH_TOKEN`. Prefer an explicit signal over sniffing, matching
   `CODEX_AUTH_MODE` and `MCP_CONFIG_MODE` (fail-closed, no silent mode assumption).
2. **Preflight.** The run must not send `llmConfig.baseUrl` down the LiteLLM path. Two
   candidate shapes — **the reviewer should rule between them**:
   - *(2a) Leave `llmConfig` unset and pass `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`
     through the service environment.* `invoker.ts mergeProcessEnv` is `{...process.env,
     ...env}`, so the child already inherits them — the same mechanism that made codex host
     mode nearly free. Cheapest, no preflight change, but it makes the base URL invisible to
     `llmConfig`, which is where h otherwise models this.
   - *(2b) Make the preflight opt-out explicit* (an Anthropic-compat signal that skips it),
     keeping `llmConfig` truthful. Costs a small change in a shared path used by every agent.

   *Leaning 2a for v1* — it changes no shared code path and is the lower-risk first cut.
   Whichever is chosen, **an empty `ANTHROPIC_API_KEY` must not be injected**, or it will
   shadow the auth token (`prepareEnvironment` already guards this for the OAuth case, and
   the same reasoning applies here).

## Implementation slices

Follow the **`integrate-agent` skill** (`.claude/skills/integrate-agent/`) — it is the
checklist, and its codex worked example is the cautionary tale for skipping the wiring half.

1. **Strategy gate + preflight.** Relax `claude.ts` `validateEnvironment` per decision (1);
   implement decision (2). Unit tests: the gate passes on `ANTHROPIC_AUTH_TOKEN` alone and
   still fails with no credential at all; no preflight fires for a Kimi-shaped run.
2. **The service.** `apps/kimi-agent/` — a thin clone of `claude-agent` (same
   `ClaudeInvokerLive`; the composition root differs only in `agentId`/base dir/tracing
   name). Port block **8017 / 3517 / 36017 / 61018** (next free after codex's
   8016/3516/36016/61017).
3. **The activity.** `run-kimi.activity.ts` invoking app-id `kimi-agent`, registered in
   `activity-registry.ts` (both the array and the `getActivity` switch). It **must** take
   the shared `{task, cwd, model}` input shape, or `test_agent_identity_sync.py` will fail —
   by design.
4. **Identity + deploy.** `AGENT_IDENTITY` (`kimi` and `kimi-agent` → `("run-kimi",
   "kimi-agent")`) and `AGENT_URLS` (`http://localhost:8017`) in `cli/h/src/h_cli/config.py`;
   `cli/scripts/run-kimi-agent.sh` exporting the Moonshot env block; `docker-compose.yml`
   app + `-dapr` sidecar (**diff it key-by-key against `claude-agent`'s** — the codex
   integration's missing `GH_TOKEN` and `H_SKILLS_DIR` are the worked example of what this
   catches); `dapr/resiliency.yaml` + `dapr/local/`; `.env.example`.
5. **Docs.** `README.md` agent list + **port table**, `CLAUDE.md` app tree + the `run-{…}`
   activity list + the agent-cli list. `cli/scripts/_services.sh` if kimi joins a mode's
   service set (guarded by `check-services.mjs`).

## Acceptance

- `bun run lint` and the full test suites green, including `check-ports`, `check-dockerfiles`,
  `check-mcp-parity`, `check-services`, and `test_agent_identity_sync.py`.
- **A live run, not just a green startup:** `h workflow run answer -p task=… --agent kimi`
  completes, and its run ledger shows a real model id and a non-empty output. A startup
  probe is not acceptance — the codex integration was green locally while four container
  wiring bugs were live.
- **A tool-using run**, since tool calls are the actual risk on a third-party
  Anthropic-compat endpoint: a `plan` or `answer` run that reads files in a worktree.
- Cost/usage is either reported truthfully or absent as a `costGap` — **never fabricated as
  `$0`**.
- The two documented gaps (WebFetch unavailable, Tool Search unsupported) are recorded as a
  `CLAUDE.md` gotcha, not discovered later by a confused run.

## Risks

1. **Auth header shape.** Moonshot documents `ANTHROPIC_AUTH_TOKEN` (an `Authorization:
   Bearer` header); h's `prepareEnvironment` models `ANTHROPIC_API_KEY` (an `x-api-key`
   header). Setting both may send both. This is the single most likely live failure, and the
   first thing to check if a run 401s.
2. **Anthropic-compat fidelity.** Tool-use, streaming, and MCP over a third-party
   Anthropic-shaped endpoint are exactly where compat layers fray. Mitigated by the
   tool-using acceptance run; if it frays badly, Route B becomes the answer rather than a
   deferral.
3. **Model-alias sprawl.** The claude CLI resolves several model slots
   (`ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`); missing one silently routes
   a subagent to a nonexistent Anthropic model. Set them all in the run script.
4. ~~**`kimi-k3[1m]` contains brackets.**~~ **RESOLVED, and the risk was real but mis-aimed
   (2026-07-29).** The bracketed id is not a quoting hazard — it is simply WRONG. A live call
   to `https://api.moonshot.ai/anthropic/v1/messages` with `kimi-k3[1m]` returns
   `404 resource_not_found_error: Not found the model kimi-k3[1m] or Permission denied`. The
   account's `/v1/models` lists exactly four ids — `kimi-k2.6`, `kimi-k2.7-code`,
   `kimi-k2.7-code-highspeed`, `kimi-k3` — and plain **`kimi-k3` returns 200** with
   `stop_reason: end_turn`. The `[1m]` suffix came from vendor documentation and was carried
   through the plan, the review panel, and the implementation unchallenged, because **nothing
   in the pipeline ever made a live call**. Corrected everywhere.

## The structural finding (the improvement worth banking)

This is the **third consecutive integration** to hit the same wall: **h binds provider
identity at the SERVICE level — one agent service, one auth, one model — so adding a
provider means standing up another service or displacing an existing one.** Codex hit it
(one `auth.json` per runner), DeepSeek hit it (openhands' single BYOK pair), and Kimi hits
it now (Route C displaces DeepSeek; Route A needs a whole service to carry an env block).

That is precisely what [model-provider-integration](../model-provider-integration.md)
predicted, and it is currently `Deferred`. Three data points is a trigger, and its two
still-accurate gaps are directly implicated here: the Python wire contract carries no
`model` at all, and five of six non-claude run activities silently drop a step's
`input.model`.

**Recommendation: this integration is the evidence to revive that plan** — not to widen
*this* one. Route A ships Kimi; the provider concept is its own piece of work, and doing
them together would fuse an integration with a refactor.

## Open questions

- Decision (2a) vs (2b) on the preflight — flagged for the review panel.
- Does `kimi-k3`'s large context need `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set inside the
  *agent service* env, or is the CLI default adequate for h's typically short runs?
- **`kimi-k3` reasons by default and spends output budget on thinking** — a 64-token
  `max_tokens` returned EMPTY text with `thinking_tokens: 61`. Harmless at agent-scale
  budgets (1024 tokens answered fine), but a low per-step `max_tokens` would silently yield
  no output rather than an error. Worth a note if any step ever caps tokens tightly.
- Should `kimi-agent` join the `h-builds-h` service set, or stay opt-in until it has a
  track record? (Leaning opt-in.)

## Log

- 2026-07-28 — Researched and scoped. Three routes established with vendor evidence, then
  grounded against the tree — which is where the two Route-A blockers came from
  (`validateEnvironment` not knowing `ANTHROPIC_AUTH_TOKEN`; the LiteLLM preflight's
  `{baseUrl}/v1/models` assumption breaking on an Anthropic-shaped base URL). Neither is
  visible from the vendor docs, and the existing DeepSeek precedent hides both because it
  runs the host CLI rather than the runner. Route A recommended, C rejected as a build
  target (it would displace the live DeepSeek fallback), B deferred with a trigger.

## Log

- 2026-07-29 — Driven to merge in one session: main merged into the branch (the one conflict
  was the activity registry — run-kimi joined the new GATED map, auto-covered by the executor
  policy); found+fixed the ambient-AGENT_MODEL bleed (a claude-* id would have routed to
  Moonshot → 404 on every run; now KIMI_MODEL per the repo's per-agent-var convention); full
  gate green on the merge result; the live e2e acceptance run COMPLETED with 2 tool calls;
  the val-98 review loop found real issues in round 1 (dead import, missing compose model
  aliases), the revise leg fixed them unattended, round 2 was CLEAN; PR CI green on
  h-runner-1 at the final head; squash-merged as fb08be6. Litter cleaned: kimi worktrees +
  branches (local, agent-workspace, remote), the /tmp/kimi-live stray agent.
