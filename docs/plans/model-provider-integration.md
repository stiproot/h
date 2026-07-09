**Status:** EXPLORATORY (2026-07-06) — no code committed. This plan picks a direction for adding configurable model providers (worked example: DeepSeek) while keeping Claude the zero-configuration default. It is grounded in a surface map of every LLM path in the repo and three independent design proposals; the ruling is a deliberate blend.
**Living doc** — update Decisions and add a Progress log as things land.
**Revision 2026-07-06:** §2 crux ruling revised after online research — DeepSeek exposes a *first-party* Anthropic-compatible endpoint and officially supports Claude Code, so claude-CLI-on-DeepSeek is viable (not the no-go originally ruled), though still the worse host for h on cost/telemetry grounds. See §2 and Sources.

# Configurable model providers: naming a provider without demoting Claude

## Framing

The goal is narrow and concrete: make it possible to run an h agent (and an individual workflow step) on a model provider other than Anthropic — DeepSeek is the worked example — **without** touching the out-of-box Claude experience. "Configurable" here means an operator names a provider (`deepseek`) and an agent/step picks it up; it does **not** mean rewriting the Anthropic-locked paths or standing up mandatory new infrastructure. The honest headline, established below: h already has most of the plumbing. The two OpenAI-wire Python agents can reach DeepSeek today with an env change and a smoke test; the missing pieces are a *name* for the provider concept, a per-request/per-step override, and provider-aware cost telemetry. Claude stays first-class by being the default of every seam we add.

---

## 1. What already exists (do not rebuild this)

h is further along than it looks. The provider-agnostic seams already in the tree:

- **A generic `LlmConfig {apiKey, baseUrl}` passthrough, per agent-service.** Neither field carries any Anthropic-specific validation. Set once at runner-layer build from env: `claude-runner.ts:179` (from `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`), `openhands-runner.ts:99` (from `LLM_API_KEY`/`LLM_BASE_URL`). The URL can point anywhere.
- **Genuine OpenAI-wire clients on two Python agents.** `dapr-agent` and `workflow-agent` both run `agent_core.llm.openai.OpenAIChatAdapter` over `dapr_agents.OpenAIChatClient(api_key, base_url, model)` (`packages/py/agent-core/src/agent_core/llm/openai.py:18-45`). This is literally OpenAI Chat Completions — DeepSeek's own protocol. The shared ReAct loop underneath (`react_loop.py:44-59`) depends only on an `LLMClient` Protocol; it is provider-agnostic by construction. The coupling lives in *which adapter a runner constructs*, not in the loop.
- **A `ANTHROPIC_BASE_URL` override that already routes CLI + SDK traffic through a proxy.** Every Anthropic-shaped client reads it; `.env.example` documents it as "api.anthropic.com or your LiteLLM proxy URL". The design intent — plug any backend in behind a base_url — is already the wiring, not an aspiration.
- **OpenHands multi-provider routing, already written.** `openhands.ts:49-55` emits a LiteLLM-style `provider/model` prefix: `anthropic/<model>` if already prefixed, else `openai/<model>`, into `LLM_MODEL` against `LLM_BASE_URL`. This is the one path in the repo with an existing test-of-intent for provider routing; a DeepSeek model reached via `openai/deepseek-chat` needs **zero** code change here.
- **A LiteLLM-shaped preflight check.** `adaptToLiteLlmEffect` (`packages/js/agent-cli/src/lib/litellm.ts:22-66`) GETs `{baseUrl}/v1/models` and fails cleanly (`LiteLlmModelUnavailableError`) if the requested model id isn't served. It is fully generic — it would validate `deepseek-chat` exactly like `claude-*`. Gated on `llmConfig.baseUrl` being set.
- **A per-request model override on the JS wire contract.** `AgentRequest.model` (`packages/js/core/src/types/agent.ts:17-18`) is an untyped optional string, decoded on `POST /run` (`agent-routes.ts:128`), collapsing to `modelOverride ?? cfg.model` in `claude-runner.ts`. `run-claude.activity.ts` already forwards it from a workflow step's `input.model`.
- **An OpenAI-protocol JS client, unused but present.** `packages/js/core-vercel/src/vercel-ai.ts` wraps `@ai-sdk/openai`'s `createOpenAI({apiKey, baseURL})` — no current consumer, but a ready seam.
- **A dead-but-minted `LITELLM_API_KEY` secret alias.** `cli/scripts/gen-k8s-secrets.sh` already produces it (today only wired to the unused Dapr `conversation.openai` components).

**Do not rebuild any of the above.** The DeepSeek-on-Python story is mostly a wiring-and-naming exercise on top of it.

---

## 2. The coupling that remains

Where h is genuinely Anthropic-locked, honestly:

- **The `claude` CLI binary speaks only the Anthropic Messages wire.** `claude.ts:89` spawns the literal closed-source `claude` binary; `:24-52` hard-code `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`CLAUDE_CODE_OAUTH_TOKEN`; the OAuth branch is Claude-Max/Pro-subscription-specific with no non-Anthropic analogue. This constraint lives **outside this repo, in the binary** — nothing here can change it. A non-Anthropic model is reachable through it *only* via a proxy at `ANTHROPIC_BASE_URL` that impersonates the Anthropic API (LiteLLM's `/v1/messages` passthrough, doing anthropic→openai→deepseek translation). No such proxy is deployed anywhere in this repo — compose/k8s only pass `ANTHROPIC_BASE_URL` through as a BYO env var.
- **Two Python agents use native Anthropic SDKs.** `dapr-claude-loop-agent` instantiates raw `anthropic.AsyncAnthropic` (`claude_loop_runner.py:31-35`) — Anthropic tool schemas, `stop_reason`, `block.type == 'tool_use'`. `langgraph-agent` imports `langchain_anthropic.ChatAnthropic` by name (`graph_builder.py:4,17-22`). LangChain ships `ChatOpenAI`, but this app never imports it. Both are code-level coupling, not base_url coupling — reaching DeepSeek natively means swapping the client class.
- **`claude-managed-agent`** uses `claude_agent_sdk.ClaudeAgentOptions` (diagrid's runner) with no base_url parameter in the code path — pure inherited-env coupling.
- **No `provider` concept exists anywhere.** Model is a bare string; "provider" is implicit in which agent service you run. No `LLM_PROVIDER` env, no factory, no registry. `openhands.ts` is the only place that branches on a prefix at all.
- **Model defaults are literal Anthropic ids.** `DEFAULT_CLAUDE_MODEL='claude-sonnet-4-6'` (`claude.ts:18`) and the `AGENT_MODEL` fallbacks (`claude-haiku-4-5`/`claude-sonnet-4-6`) assume the fallback is a real Anthropic model — any path that falls through to the default while pointed at a non-Anthropic backend requests a nonexistent model.
- **The Python wire contract has no model override at all.** `packages/py/agent_server/models.py::AgentRequest` carries only `input/system_prompt/session_id/workflow_instance_id/workspace_id` — no `model`, no `provider`. Every Python agent's model is fixed at process boot from env in `main.py`. A workflow step *cannot* override it.
- **Five of six workflow activities can't forward a model.** Only `run-claude.activity.ts` has a `model?` field. `run-openhands`, `run-dapr-agent`, `run-dapr-claude-loop`, `run-langgraph`, `run-claude-managed` never put one in the invoke body — a step's `input.model` is silently dropped.

### The claude-CLI-via-DeepSeek question (the crux) — REVISED 2026-07-06 after online research

**Original assumption (wrong):** that reaching DeepSeek through the `claude` CLI required a self-hosted LiteLLM `/v1/messages` translation of unverified fidelity.

**Reality (verified against DeepSeek's own docs):** DeepSeek ships a **first-party Anthropic-Messages-compatible endpoint** at `https://api.deepseek.com/anthropic`, and DeepSeek *officially documents* Claude Code integration against it. Tool fields (`name`/`input_schema`/`description`) and `stream` are documented as "fully supported" — there is no home-rolled translation layer to babysit. The documented recipe is env-only:

```
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<deepseek key>
ANTHROPIC_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
```

So **hosting DeepSeek on the `claude` CLI is viable** — not the no-go the first pass assumed. But h's current claude strategy does not wire it, and three real caveats remain:

1. **h sets the wrong knobs.** `claude.ts::prepareEnvironment` sets only `ANTHROPIC_API_KEY` (→ `x-api-key` auth) + `ANTHROPIC_BASE_URL`, and selects the model via the `--model` flag. DeepSeek's recipe uses `ANTHROPIC_AUTH_TOKEN` (→ `Authorization: Bearer`) and the `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` env family, *not* `--model`. Pointing claude-agent at DeepSeek needs the strategy to emit these vars, not just repoint the base URL — a small but real code change, not a pure config swap.
2. **Cost accounting is still poisoned — this is the load-bearing objection.** The CLI computes `total_cost_usd`/`modelUsage` *client-side assuming Anthropic pricing* (`claude.ts::normalizeClaudeModelUsage`). A DeepSeek run reported under a `claude-*`/`deepseek-v4-*` id yields a wrong cost figure into the run ledger → poisons the watcher engine's cost tally (`watch-scan.ts` reads `run:<id>` mirrors; wrong number, or `costGap`). The endpoint being first-party changes nothing here — it's a computation inside the closed binary h can't see into.
3. **Feature gaps to validate against h's usage.** The endpoint documents *no* image/document content, no top-k, and — notably — lists "MCP tool results" among unsupported Anthropic content types. h agents are MCP-heavy; whether that caveat touches *client-side* MCP tool_use (which Claude Code surfaces as ordinary tool_use/tool_result blocks) or only *server-connector* MCP result blocks must be verified before trusting a DeepSeek claude-agent run.

**Revised ruling:** claude-CLI-on-DeepSeek is a *supported, opt-in* option, no longer forbidden — but it is still the *worse* host **for h specifically**, because of the cost-tally poisoning (2) and the unverified MCP caveat (3). Prefer the OpenAI-wire agents (dapr-agent/workflow-agent/openhands) for DeepSeek, where h reads real token usage and speaks DeepSeek's native protocol end to end. Keep claude-CLI-on-DeepSeek as a documented escape hatch for when a task specifically needs Claude Code's *harness behaviour* on a DeepSeek backend — modelled cleanly by the §4 registry as a `deepseek-anthropic` provider (`kind: "anthropic"`, `baseUrl: https://api.deepseek.com/anthropic`, `apiKeyEnv: DEEPSEEK_API_KEY`), with the claude strategy taught to emit `ANTHROPIC_AUTH_TOKEN` + the `ANTHROPIC_*_MODEL` env family, and cost accounting explicitly marked untrusted for that path.

### Cost / ledger implications

Cost telemetry is asymmetric today. Claude's `extractMetrics` parses real Anthropic-CLI cost fields. The OpenAI-wire Python path hard-codes `AgentResponse.model = "dapr-agent"` and zero usage (`dapr_agent_runner.py:60`) — so even a clean provider swap surfaces `costGap` in the watcher tally. And the workflow activity result types (`AgentResult`/`ClaudeResult` in `workflow.model.ts`) carry only `{sessionId, output, workspacePath}` — model/cost never reach orchestration-level consumers regardless of provider; they survive only in the run-ledger `run:<id>` mirror. Provider-aware cost is therefore **load-bearing, not optional**, the moment a non-Anthropic run needs to be costed.

---

## 3. Recommended approach

**A thin `ProviderConfig` registry that names providers and gates them by wire protocol, with DeepSeek served natively on the OpenAI-wire agents (zero new infra for the common case), and a LiteLLM proxy reserved — optional — for centralized auth/observability and the Anthropic-passthrough niche.** Claude stays the default of every seam and stays native on its CLI.

This is a deliberate blend of the three proposed designs:

- From **native per-provider strategies**: route each provider to the code path that already speaks its wire protocol. DeepSeek is OpenAI-Chat-Completions-native, so it hits `api.deepseek.com` directly through `OpenAIChatClient`/openhands-litellm — full tool-calling, real token+cost fields, `deepseek-reasoner`'s `reasoning_content`, none of which reliably survive an Anthropic-format translation. **This is the lowest-effort, highest-fidelity win and it needs no proxy.**
- From **ProviderConfig registry**: put provider naming in exactly two files (JS `core`, Python `agent_core`) instead of smearing `ANTHROPIC_*` reads across every runner. Encode the "claude CLI is Anthropic-wire-locked" constraint as an executable `kind` guard that fails cleanly at the h layer.
- From **LiteLLM-as-gateway**: keep it as an *optional, later* phase — the right tool when an operator wants one process holding all provider keys, cross-provider spend caps, and unified observability, or specifically wants the Anthropic-passthrough door for the CLI/ChatAnthropic paths. It is **not** required to ship DeepSeek.

Why this blend over each alternative alone:

- **Pure LiteLLM gateway** makes a mandatory always-on SPOF that every agent routes through (echoing the "MCP servers are agent-runtime dependencies" gotcha), adds latency on activities already sensitive to the 1h Dapr resiliency timeout, and introduces the two-base_url-shape footgun (`/v1` for OpenAI-wire vs root for Anthropic-wire) — all to solve a problem the OpenAI-wire agents don't have. It also doesn't fix cost telemetry or the missing per-step override by itself. Good as an *option*, wrong as *the* mechanism.
- **Pure native strategies** without a naming layer leaves "provider" smeared across runners and gives no clean failure when someone points `provider: deepseek` at the Anthropic-locked binary. The registry is the cheap fix.
- **Pure ProviderConfig registry** is nearly right but reads as a big cross-ecosystem refactor if landed all at once. Phasing it behind the native DeepSeek win makes each step independently shippable.

The registry is the single home the codebase provably lacks; native routing is the fidelity win; the proxy is the escape hatch, not the foundation.

---

## 4. Design

### 4.1 `ProviderConfig`

```
ProviderConfig {
  id:        string                              // "anthropic" | "deepseek" | ...
  kind:      "anthropic" | "openai-compatible"   // which wire protocol → which runners are legal
  baseUrl?:  string                              // undefined ⇒ client default (Anthropic direct / OAuth)
  apiKeyEnv: string                              // e.g. "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"
  models:    string[]                            // models[0] is the provider default
}
```

Two built-ins, overridable by an `H_PROVIDERS` JSON env blob (decoded through a schema/dataclass so a malformed entry fails loudly, not at first use):

- `anthropic` — `{kind:"anthropic", baseUrl: ANTHROPIC_BASE_URL||undefined, apiKeyEnv:"ANTHROPIC_API_KEY", models:["claude-sonnet-4-6","claude-haiku-4-5"]}`
- `deepseek` — `{kind:"openai-compatible", baseUrl:"https://api.deepseek.com", apiKeyEnv:"DEEPSEEK_API_KEY", models:["deepseek-chat","deepseek-reasoner"]}`

### 4.2 Where it resolves

Exactly two resolvers, one per ecosystem:

- **JS**: `packages/js/core/src/providers.ts` — `resolveProvider(id, env=process.env)` merges `H_PROVIDERS` over built-ins, throws a tagged `UnknownProviderError` on miss; `toLlmConfig(provider, env): LlmConfig` derives `apiKey = env[provider.apiKeyEnv] ?? ""`, `baseUrl = provider.baseUrl`. Re-export from `core/src/index.ts`.
- **Python**: `packages/py/agent-core/src/agent_core/providers.py` — `resolve_provider(id)` + `to_llm_config(provider) → (api_key, base_url, model_default)`.

Each runner calls `resolveProvider(request.provider ?? "anthropic")` in place of reading `ANTHROPIC_*` directly. Model is `request.model ?? provider.models[0]`.

### 4.3 The `kind` guard (the executable constraint)

The Anthropic-wire-locked runners — `claude-runner.ts`, `graph_builder.py` (ChatAnthropic), `claude_loop_runner.py` (raw Anthropic SDK), claude-managed — assert `provider.kind === "anthropic"` and, on an `openai-compatible` provider, return a clean h-level error:

> `provider <id> is openai-compatible; the claude CLI is Anthropic-wire locked — route this step via dapr-agent/workflow-agent/openhands, or register an anthropic-passthrough provider.`

This replaces today's opaque failure deep inside the closed binary with a legible one at the h boundary. The guard is the enforcement point of the §2 ruling.

### 4.4 Threading through the contracts

- **JS `AgentRequest`** (`core/src/types/agent.ts`): add `provider: Schema.optional(Schema.String)`; loosen the `model` JSDoc from "claude-agent only" to "per-step model override; falls back to the provider default".
- **Python `AgentRequest`** (`agent_server/models.py`): add `provider: str | None = None` and `model: str | None = None` (it has neither today).
- **agent-cli plumbing**: thread `provider` through `AgentInvokeParams` (`invoker.ts`), `AgentInvocationRequest` (`agents/types.ts`), into each strategy alongside the existing `model`/`llmConfig`.
- **Workflow activities**: add `provider?: string; model?: string` to the Input types of `run-openhands`, `run-dapr-agent`, `run-dapr-claude-loop`, `run-langgraph`, `run-claude-managed` (and `provider?` to `run-claude`, which already forwards `model`), and include them in the Dapr-invoke body. `generic.workflow.ts` already spreads `step.input`, so a saved step's `input: {provider, model}` reaches the wire once the activity destructures it. A step selects its provider by targeting the activity of an agent that speaks that provider's wire — no `provider → activity` auto-dispatch is required in phase 1 (the author picks the agent), though a `provider`-keyed dispatch on `StepDefinition` is a reasonable later convenience.

### 4.5 Per-agent-family handling

| Family | Wire | DeepSeek path | Change needed |
|---|---|---|---|
| `dapr-agent`, `workflow-agent` | OpenAI (native) | `OpenAIChatAdapter` → `api.deepseek.com` directly | `resolve_provider` in `run()`; per-request `model`/`provider`; fix `AgentResponse.model` + usage |
| `openhands` | OpenAI (native, via internal litellm) | `openai/deepseek-chat` at `LLM_BASE_URL` | source `LLM_*`+model from resolver; **no strategy code change** |
| `claude-agent`, `claude-coder` | Anthropic CLI | **not served natively** | `kind` guard rejects; stays Claude |
| `langgraph`, `dapr-claude-loop`, `claude-managed` | Anthropic SDK | **not served natively** (phase 1) | `kind` guard rejects; a later phase can swap `ChatOpenAI`/OpenAI SDK when `kind` is openai-compatible |

### 4.6 Claude stays first-class (proof)

With `provider` absent, `resolveProvider(undefined)` returns the `anthropic` built-in, `toLlmConfig` collapses to exactly the `{apiKey: ANTHROPIC_API_KEY, baseUrl: ANTHROPIC_BASE_URL}` `claude-runner.ts:179` builds today, and `models[0]` equals the current `claude-sonnet-4-6` default. The OAuth branch is preserved: an unset `ANTHROPIC_API_KEY` yields an empty apiKey, and `claude.ts::prepareEnvironment` still only sets `ANTHROPIC_API_KEY` when non-empty, so `CLAUDE_CODE_OAUTH_TOKEN` keeps winning. `kind:"anthropic"` passes the guard trivially. Every Claude path is byte-for-byte unchanged with no config set. Claude is the default alias, the default binary, and the only path with subscription auth — not "one of N".

---

## 5. Phased rollout

Each phase is independently shippable and dogfoodable.

**Phase 0 — Prove DeepSeek reaches a Python agent (spike, ~½ day).** No abstraction yet. Point a local `workflow-agent` at DeepSeek by hand: `AGENT_MODEL=deepseek-chat`, `ANTHROPIC_BASE_URL=https://api.deepseek.com`, `ANTHROPIC_API_KEY=<deepseek key>`. Run one `/run` with a tool-calling task. **Validates the single riskiest unknown:** that `dapr_agents.OpenAIChatClient`'s `get_tool_calls()`/`arguments_dict` handling actually matches DeepSeek's OpenAI-compatible tool-call response shape. If this fails, the whole native thesis needs rework — so it goes first. Exit criterion: one clean tool-using DeepSeek run.

**Phase 1 — The registry + per-request override, native DeepSeek on OpenAI-wire agents.** Land `providers.{ts,py}`, the `kind` guard, `provider`/`model` on both wire contracts, and the resolver call in `dapr_agent_runner.py`/`workflow_agent_runner.py`/`openhands-runner.ts`. Add `DEEPSEEK_API_KEY` + `H_PROVIDERS` to `.env.example`, the dapr-agent/workflow-agent/openhands env blocks in `docker-compose.yml`, and `cli/scripts/run-*.sh`. Unit-test `resolveProvider` (built-ins, `H_PROVIDERS` merge, apiKey-from-env, unknown-id error, claude-runner rejects openai-compatible) and extend the existing openhands prefix test with a `deepseek-chat` case. Dogfood: a workflow step `run-dapr-agent` with `input:{provider:"deepseek",model:"deepseek-chat"}`. **Claude paths untouched.**

**Phase 2 — Provider-aware cost telemetry.** Fix `dapr_agent_runner.py:60` (`AgentResponse.model` → resolved model; populate real token usage from the `OpenAIChatClient` response) and the Python `record_run` / JS `run-ledger.ts` to compute cost from usage for non-Claude providers (registry price entries or LiteLLM cost headers). Without this the watcher cost tally reports `costGap` for every DeepSeek run. Optionally surface `model`/`cost` on `AgentResult`/`ClaudeResult` so orchestration-level consumers see them, not just the `run:<id>` sidechannel.

**Phase 3 (optional) — LiteLLM proxy as the centralizing gateway.** Only if an operator wants one process holding all provider keys, spend caps, or unified cross-provider observability. Add a pinned `litellm` service to compose + `k8s/apps/litellm.yaml`, a `config/litellm/config.yaml` `model_list` (the registry made deployable), reuse the already-minted `LITELLM_API_KEY` as master key + client bearer, and repoint base_urls (mind the two shapes: `/v1` for OpenAI-wire, root for Anthropic-wire). This *also* opens the Anthropic-passthrough door for claude-agent/langgraph, with the fidelity/cost caveats of §2 flagged loudly. Deferred deliberately — it is a convenience layer, not a prerequisite.

**Phase 4 (optional) — Native OpenAI-wire for the Anthropic-SDK Python agents.** Swap `ChatAnthropic`→`ChatOpenAI` in `graph_builder.py` and the raw Anthropic SDK→OpenAI SDK in `claude_loop_runner.py` when `kind` is openai-compatible, so DeepSeek runs natively there too. Removes the last `kind`-guard rejections outside the CLI.

---

## 6. Open questions / risks

- **Tool-calling parity (Phase 0 gate).** `dapr_agents.OpenAIChatClient` may make Anthropic-specific assumptions under the OpenAI-wire label. Unverified in-repo; the Phase 0 smoke test is the gate. Same question for OpenHands' internal litellm against `deepseek-chat`.
- **Cost accounting for non-Anthropic providers.** DeepSeek returns OpenAI-style `usage`; converting to a dollar figure needs a price source (registry table — which drifts and is a maintenance tax — or LiteLLM cost headers if Phase 3 lands). Until Phase 2, non-Claude runs surface `costGap`. What is the source of truth for pricing?
- **The claude CLI.** Reaffirm: not served natively; passthrough is fidelity-fragile and cost-poisoning (§2). Do we ever want to support "claude-agent's exact behavior, foreign backend"? If so it's Phase 3 proxy-only, with explicit acceptance of bogus CLI cost accounting.
- **`H_PROVIDERS` as a JSON env blob** is a minimal registry, not a validated file. Decode it through a schema/dataclass so malformation fails at startup, not at resolve time.
- **Env-var naming honesty.** `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` on OpenAI-wire agents are Anthropic-branded even where the wire isn't. Functionally fine (they're strings) but confusing for a DeepSeek operator. The `apiKeyEnv` indirection lets each provider name its own key (`DEEPSEEK_API_KEY`) — worth doing rather than repurposing `ANTHROPIC_*`.
- **`kind`-gated agents stay Claude-only** through Phase 3. "Any provider on any agent" is explicitly *not* a phase-1 goal — a deliberate scope cut.
- **What to validate:** (1) DeepSeek tool-call round-trip through both OpenAI-wire paths; (2) `resolveProvider` default equals today's Claude config byte-for-byte; (3) the `kind` guard produces a legible error, not a binary crash; (4) a DeepSeek run produces a real (non-zero, non-`costGap`) cost in the watcher tally after Phase 2; (5) the OAuth/subscription Claude path is untouched.

---

## 7. Decisions to make

1. **Adopt the blend** (registry + native OpenAI-wire DeepSeek + optional proxy) over pure-gateway or pure-native? (Recommended: yes.)
2. **`kind` as the guard mechanism** — encode the Anthropic-wire lock as an executable `kind` check, failing at the h layer? (Recommended: yes.)
3. **Ship without the proxy** — is Phase 1+2 (no LiteLLM container) an acceptable first delivery, with the proxy strictly optional (Phase 3)? (Recommended: yes.)
4. **`H_PROVIDERS` env-blob vs a config file** for provider overrides in phase 1 — and where the DeepSeek pricing figure comes from.
5. **Env-var naming** — introduce provider-named keys (`DEEPSEEK_API_KEY`) via `apiKeyEnv`, or repurpose `ANTHROPIC_*`? (Recommended: provider-named.)
6. **Scope of the guard** — accept that langgraph/dapr-claude-loop/claude-managed stay Claude-only until an optional Phase 4, or pull the `ChatOpenAI` swap forward?
7. **claude-CLI-on-DeepSeek** (new, from §2 revision) — do we want the `deepseek-anthropic` first-party-endpoint provider as an opt-in escape hatch at all, given the cost-telemetry poisoning? (Recommended: register it but mark cost untrusted; do not make it the default DeepSeek path.)

---

## Progress log

- **2026-07-06 — First delivery wired: DeepSeek V4-flash on two agents (OpenHands + dapr-agent), config-only, Claude default untouched.** Scope taken (endorsed): the §5 Phase 1 win *without* the full §4 registry — the pragmatic env-var starting point (a shared provider-neutral `LLM_*` endpoint + a per-agent model knob). Landed:
  - **dapr-agent** (`apps/dapr-agent/src/main.py`) — LLM endpoint/key now resolve provider-neutral first: `LLM_BASE_URL`/`LLM_API_KEY`, falling back to `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` (so the Claude default is byte-for-byte unchanged when the neutral vars are unset). Model via `AGENT_MODEL` (`DAPR_AGENT_MODEL` in compose/scripts). Missing endpoint now fails with a clear error instead of a bare `KeyError`.
  - **dapr-agent response** (`infrastructure/dapr_agent_runner.py`) — `AgentResponse.model` now reports the *real* model instead of the literal `"dapr-agent"` (fixes the §2.3 telemetry stub for the model field; token usage still 0 — cost deprioritized by decision).
  - **OpenHands** (`packages/js/agent-cli/src/agents/openhands.ts`) — `LLM_MODEL` routing generalized: any LiteLLM provider-prefixed id (`deepseek/…`, `anthropic/…`) passes through; a bare id still gets `openai/` for OpenAI-compatible-endpoint routing via `LLM_BASE_URL`. Unit-tested (`openhands.test.ts`, 3 cases). Build + full agent-cli suite green (13 tests).
  - **Config surfaced**: `.env.example` (DeepSeek recipe for both legs), `docker-compose.yml` (dapr-agent `LLM_*` + `DAPR_AGENT_MODEL`), `cli/scripts/run-dapr-agent.sh` (ANTHROPIC_* no longer hard-required; `LLM_*` + `DAPR_AGENT_MODEL` passthrough).
  - **Decisions resolved this pass:** #1 blend (yes, native OpenAI-wire, proxy deferred); #3 ship without proxy (yes); #5 env-var naming — chose a *shared provider-neutral* `LLM_*` endpoint + per-agent model over per-provider `DEEPSEEK_API_KEY` for the starting point (the registry's `apiKeyEnv` indirection remains the path if independent per-agent providers are later needed). Second-agent choice (§decision, prior turn): **dapr-agent** as the validation lead over workflow-agent (same `OpenAIChatAdapter` code path; orchestrator is the higher-risk surface for thinking-mode quirks).
  - **NOT YET VALIDATED against a live DeepSeek endpoint** — wiring only. A real `deepseek-v4-flash` tool-calling run is the acceptance gate (needs a DeepSeek key + the stack up): the Phase 0 smoke test is still owed, and it also confirms `dapr_agents.OpenAIChatClient`'s tool-call parsing against DeepSeek's response shape.
  - **v4-pro (thinking) deferred** — needs `reasoning_content` threaded back verbatim in `agent_core/llm/openai.py::append_assistant` (or confirmation that `dapr_agents` already round-trips it) plus tolerance for the empty-response-on-tool-result quirk (a natural watcher-policy safeguard). Tracked as the next step; OpenHands stays capped at v4-flash regardless (upstream SDK drops reasoning_content, issue #3267).

---

## Sources (§2 revision, 2026-07-06)

- DeepSeek — Integrate with Claude Code: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code (the `ANTHROPIC_BASE_URL=.../anthropic` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_*_MODEL` recipe; claude-model → deepseek-v4 mapping)
- DeepSeek — Anthropic API compatibility: https://api-docs.deepseek.com/guides/anthropic_api (endpoint auth via `x-api-key`; tool fields + `stream` "fully supported"; unsupported: image/document content, top-k, web-search/code-exec/**MCP tool results**, container uploads, most metadata)
- Background on the general pattern (Claude Code via a gateway): LiteLLM "Use Claude Code with Non-Anthropic Models" https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models — note the disclosed LiteLLM PyPI 1.82.7/1.82.8 malware advisory; pin/verify if a proxy is ever adopted (Phase 3).
