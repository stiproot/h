import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentInvoker, toolCallTallyFor } from "agent-cli";
import { AgentRunner, RunLedger, startRunLedgerEffect } from "agent-server";
import { AgentRunError } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Config, type ConfigError, Data, Effect, Layer, Option } from "effect";
import { LoggerTag } from "logger";

import { mcpJsonToCodexToml } from "./codex-mcp-config.ts";

/** Default workspace root. */
export const DEFAULT_AGENT_BASE_DIR = "/workspace/codex-agent";

const AGENT_ID = "codex-agent";

export class CodexRunError extends Data.TaggedError("CodexRunError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

const codexConfig = Effect.gen(function* () {
  const apiKey = yield* Config.withDefault(Config.string("OPENAI_API_KEY"), "");
  const model = yield* Config.withDefault(Config.string("AGENT_MODEL"), "o4-mini");
  // Auth mode gates model handling: a ChatGPT-account plan REJECTS every explicit model id
  // (o4-mini, gpt-5-codex, claude-sonnet-4-6, …), so in chatgpt mode we drop ANY model — including
  // a per-step modelOverride the workflow passes — and let codex use the account default.
  const authMode = yield* Config.withDefault(Config.string("CODEX_AUTH_MODE"), "");
  const baseDir = yield* Config.withDefault(
    Config.string("AGENT_BASE_DIR"),
    DEFAULT_AGENT_BASE_DIR,
  );
  const runsDir = yield* Config.withDefault(
    Config.string("AGENT_RUNS_DIR"),
    join(baseDir, "..", ".runs"),
  );
  const chatgptAuth = authMode.toLowerCase() === "chatgpt";
  const daprHttpPort = yield* Config.option(Config.string("DAPR_HTTP_PORT"));
  const runTimeoutMs = yield* Config.withDefault(Config.number("AGENT_RUN_TIMEOUT_MS"), 1_800_000);
  // MCP parity: h's .mcp.json source (same one claude-agent provisions) + the dedicated CODEX_HOME
  // the runner writes the translated config.toml into. Both optional — provisioning is skipped
  // (logged) when either is unset, so codex still runs (just without h's MCP tools).
  const mcpConfigSrc = yield* Config.option(Config.string("MCP_CONFIG_SRC"));
  const codexHome = yield* Config.option(Config.string("CODEX_HOME"));
  // Container mode: a read-only mount of the host's auth.json; the runner copies it into the
  // private CODEX_HOME (which codex then writes state/refresh into). Unset in host mode (auth
  // already lives in CODEX_HOME), so the copy is skipped.
  const codexSeedAuth = yield* Config.option(Config.string("CODEX_SEED_AUTH"));
  return {
    apiKey,
    model,
    chatgptAuth,
    baseDir,
    runsDir,
    daprHttpPort,
    runTimeoutMs,
    mcpConfigSrc,
    codexHome,
    codexSeedAuth,
  };
});

export const CodexRunnerLive: Layer.Layer<
  AgentRunner,
  ConfigError.ConfigError,
  AgentInvoker | RunLedger | LoggerTag | FileSystem.FileSystem
> = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    const cfg = yield* codexConfig;
    const invoker = yield* AgentInvoker;
    const ledger = yield* RunLedger;
    const logger = yield* LoggerTag;
    const fs = yield* FileSystem.FileSystem;

    const run = (request: AgentRequest): Effect.Effect<AgentResponse, CodexRunError> =>
      Effect.gen(function* () {
        const {
          input,
          workflowInstanceId,
          workspaceId,
          cwd: cwdOverride,
          model: modelOverride,
        } = request;
        const workspaceKey = workspaceId ?? workflowInstanceId;
        const cwd = cwdOverride ?? (workspaceKey ? join(cfg.baseDir, workspaceKey) : cfg.baseDir);
        // chatgpt mode: drop any model (workflow slots pass claude-sonnet-4-6 etc., all rejected by
        // a ChatGPT account) so codex uses the account default. api-key mode honours the override.
        const model = cfg.chatgptAuth ? "" : (modelOverride ?? cfg.model);

        if (workspaceKey) {
          yield* fs
            .makeDirectory(cwd, { recursive: true })
            .pipe(Effect.mapError((cause) => new CodexRunError({ cause })));
        }

        const log = yield* logger.child({ workflowInstanceId, workspaceId, agent: "codex" });

        // MCP parity: write h's servers (translated from .mcp.json) into $CODEX_HOME/config.toml so
        // the codex CLI has the github (+ other supported) MCP tools — the PR workflows depend on
        // them. Non-fatal: a failure here just leaves codex without h's MCP, it doesn't kill the run.
        const src = Option.getOrNull(cfg.mcpConfigSrc);
        const home = Option.getOrNull(cfg.codexHome);
        yield* Effect.gen(function* () {
          if (!src || !home) {
            yield* log.info(
              { src, home },
              "codex mcp: not provisioning (MCP_CONFIG_SRC/CODEX_HOME unset)",
            );
            return;
          }
          yield* fs.makeDirectory(home, { recursive: true }).pipe(Effect.ignore);
          // Seed auth.json into the private CODEX_HOME from the read-only mount, if not already
          // there (container mode). Group-accessible (0660) so the dropped codex CLI can read +
          // refresh it. Skipped in host mode (CODEX_SEED_AUTH unset, auth already in CODEX_HOME).
          const seed = Option.getOrNull(cfg.codexSeedAuth);
          if (seed) {
            const authDest = join(home, "auth.json");
            if ((yield* fs.exists(seed)) && !(yield* fs.exists(authDest))) {
              yield* fs.copyFile(seed, authDest).pipe(Effect.ignore);
              yield* fs.chmod(authDest, 0o660).pipe(Effect.ignore);
              yield* log.info({ authDest }, "codex: seeded auth.json into CODEX_HOME");
            }
          }
          if (!(yield* fs.exists(src))) {
            yield* log.info({ src }, "codex mcp: MCP_CONFIG_SRC missing — skipping provisioning");
            return;
          }
          const { toml, included, skipped } = mcpJsonToCodexToml(yield* fs.readFileString(src));
          const configPath = join(home, "config.toml");
          // codex rewrites config.toml (adding a [projects] trust block) as the dropped uid, so a
          // prior run's file is owned by that uid and can't be truncated by this runner — remove it
          // first (the group-writable dir permits it) so re-provisioning always refreshes the MCP set.
          yield* fs.remove(configPath).pipe(Effect.ignore);
          yield* fs.writeFileString(configPath, toml);
          // The codex CLI runs as the DROPPED sub-agent uid (container process-identity model), which
          // differs from this runner's uid — so config.toml must be group-readable/writable (like the
          // seeded auth.json at 0660) or codex fails with "config.toml: Permission denied". Host mode
          // (same uid) is unaffected; the chmod is harmless there.
          yield* fs.chmod(configPath, 0o660).pipe(Effect.ignore);
          yield* log.info({ included, skipped, home }, "codex mcp: provisioned config.toml");
        }).pipe(
          Effect.catchAll((cause) =>
            log.info({ cause: String(cause) }, "codex mcp: provisioning failed (non-fatal)"),
          ),
        );

        const handle = yield* startRunLedgerEffect({
          agentId: AGENT_ID,
          runsDir: cfg.runsDir,
          workflowInstanceId,
          workspaceId,
          workspacePath: cwd,
          input,
          daprHttpPort: Option.getOrUndefined(cfg.daprHttpPort),
          // codex counts its OWN stream shape; see agent-cli event-shape.ts.
          tallyToolCalls: toolCallTallyFor("codex"),
        }).pipe(Effect.provideService(RunLedger, ledger));

        const result = yield* invoker
          .invoke({
            systemPrompt: "",
            taskPrompt: input,
            cwd,
            env: {
              ...(cfg.apiKey ? { OPENAI_API_KEY: cfg.apiKey } : {}),
              ...(workflowInstanceId ? { WORKFLOW_INSTANCE_ID: workflowInstanceId } : {}),
            },
            timeout: cfg.runTimeoutMs,
            model,
            onEvent: (event) => {
              Effect.runSync(log.info(event, "agent output"));
              handle.onEvent(event);
            },
          })
          .pipe(
            Effect.withSpan("codex cli", { attributes: { "codex.model": model } }),
            Effect.mapError((cause) => new CodexRunError({ cause })),
            Effect.catchAllDefect((cause) => Effect.fail(new CodexRunError({ cause }))),
            Effect.tapError((err) =>
              handle.finish({ status: "failed", output: "", error: String(err.cause) }),
            ),
          );

        if (result.exitCode !== undefined && result.exitCode !== 0) {
          const msg = result.stderr ?? `Agent exited with code ${result.exitCode}`;
          yield* handle.finish({
            status: "failed",
            output: result.stdout ?? "",
            error: msg,
            stopReason: result.stopReason ?? null,
          });
          return yield* Effect.fail(new CodexRunError({ cause: new Error(msg) }));
        }

        const summary = yield* handle.finish({
          status: "completed",
          output: result.stdout,
          sessionId: result.sessionId ?? null,
          model: result.model ?? model,
          turns: result.numTurns ?? 1,
          tokens: result.tokenUsage ?? { input: 0, output: 0 },
          costUsd: result.costUsd ?? null,
          stopReason: result.stopReason ?? null,
        });

        return {
          output: result.stdout,
          sessionId: result.sessionId ?? null,
          usage: result.tokenUsage ?? { input: 0, output: 0 },
          model: result.model ?? model,
          turns: result.numTurns ?? 1,
          workspacePath: cwd,
          costUsd: result.costUsd,
          toolCalls: summary.toolCalls,
          runId: summary.runId,
        };
      });

    return {
      run: (request) =>
        run(request).pipe(
          Effect.mapError((cause) => new AgentRunError({ cause, agentId: AGENT_ID })),
        ),
    };
  }),
);
