import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import type { AgentInvokeParams } from "./invoker.ts";
import { AgentInvoker, layerAgentInvoker } from "./invoker.ts";
import type { AgentStrategy, StreamEvent } from "./agents/types.ts";

const TestPlatform = Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer);

// A strategy that runs `node -e <script>` — a real trivial subprocess — so the
// Command.start + decodeText + splitLines pipeline is exercised end to end.
function nodeStrategy(script: string, overrides: Partial<AgentStrategy> = {}): AgentStrategy {
  return {
    type: "claude",
    name: "TestAgent",
    validateEnvironment: () => null,
    buildInvocation: () => Effect.succeed({ command: "node", args: ["-e", script] }),
    extractSessionId: (events: StreamEvent[]) =>
      events.find((event) => event.session_id)?.session_id,
    extractMetrics: () => ({}),
    ...overrides,
  };
}

function baseParams(overrides: Partial<AgentInvokeParams> = {}): AgentInvokeParams {
  return {
    systemPrompt: "",
    taskPrompt: "task",
    cwd: process.cwd(),
    env: {},
    timeout: 0,
    ...overrides,
  };
}

function invoke(strategy: AgentStrategy, params: AgentInvokeParams) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      return yield* invoker.invoke(params);
    }).pipe(Effect.provide(layerAgentInvoker(strategy).pipe(Layer.provide(TestPlatform)))),
  );
}

describe("AgentInvoker layer (Command.start pipeline)", () => {
  it("parses JSONL split across chunks and flushes a trailing line without a newline, firing onEvent incrementally", async () => {
    // Line 1 is written in two chunks (split mid-JSON); line 2 has no trailing
    // newline and only becomes visible via the close-time flush.
    const script = `
      const line1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }) + "\\n";
      process.stdout.write(line1.slice(0, 12));
      setTimeout(() => {
        process.stdout.write(line1.slice(12));
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ type: "result", session_id: "sess-1" }));
          process.exit(0);
        }, 400);
      }, 50);
    `;

    const arrivals: Array<{ type: string; at: number }> = [];
    const result = await invoke(
      nodeStrategy(script),
      baseParams({
        onEvent: (event) => arrivals.push({ type: String(event["type"]), at: Date.now() }),
      }),
    );
    const doneAt = Date.now();

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.sessionId).toBe("sess-1");
    // Both events observed, in stream order.
    expect(arrivals.map((a) => a.type)).toEqual(["assistant", "result"]);
    // Incremental delivery: the first event arrived while the child was still
    // running (well before the invocation resolved), not after process exit.
    expect(doneAt - arrivals[0]!.at).toBeGreaterThanOrEqual(300);
  });

  it("maps a timeout to the legacy exit-124 structured result instead of failing the call", async () => {
    const script = `setTimeout(() => {}, 30000);`;
    const startedAt = Date.now();

    const result = await invoke(nodeStrategy(script), baseParams({ timeout: 500 }));

    expect(result).toEqual({
      success: false,
      stopReason: "timeout",
      stdout: "Task timed out after 500ms",
      stderr: "Task timed out",
      exitCode: 124,
    });
    // The subprocess was killed by the scope, not awaited to completion.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("timeout with a partial stream keeps the collected events: partial usage folded, throttle classified (B1/C3)", async () => {
    // Emits claude-shaped events — 2 API calls' usage + 3 rate-limit retries — then hangs past
    // the timeout. The result must carry the partial fold and classify usage-limited, not lose
    // everything to a bare synthetic 124 (docs/plans/cost-containment.md).
    const { claudeStrategy } = await import("./agents/claude.ts");
    const script = `
      const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      emit({ type: "assistant", message: { id: "m1", model: "kimi-k3", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: "partial answer" }] } });
      emit({ type: "assistant", message: { id: "m2", model: "kimi-k3", usage: { input_tokens: 200, output_tokens: 20 }, content: [] } });
      for (let i = 0; i < 3; i++) emit({ type: "system", subtype: "api_retry", attempt: i + 1, error_status: 429, error: "rate_limit" });
      setTimeout(() => {}, 30000);
    `;

    const result = await invoke(
      nodeStrategy(script, { extractMetrics: claudeStrategy.extractMetrics }),
      baseParams({ timeout: 1500 }),
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stopReason).toBe("usage-limited");
    expect(result.tokenUsage).toEqual({ input: 300, output: 30 });
    expect(result.model).toBe("kimi-k3");
    expect(result.costPartial).toBe(true);
    expect(result.stdout).toBe("partial answer");
    expect(result.stderr).toBe("Task timed out");
  });

  it.runIf(process.platform === "linux")(
    "timeout kills the whole process GROUP — a grandchild the CLI spawned dies too (B2)",
    async () => {
      // The orphan hole (docs/plans/cost-containment.md B2): the CLI spawns children; killing only
      // the direct child on timeout leaves grandchildren billing invisibly. With setsid group
      // leadership the scope finalizer takes the group. Linux-only: macOS has no setsid.
      const script = `
        const { spawn } = require("child_process");
        const c = spawn("node", ["-e", "setTimeout(() => {}, 30000)"]);
        console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: String(c.pid) }] } }));
        setTimeout(() => {}, 30000);
      `;

      const result = await invoke(nodeStrategy(script), baseParams({ timeout: 1500 }));
      expect(result.exitCode).toBe(124);
      const grandchildPid = Number(result.stdout);
      expect(Number.isInteger(grandchildPid)).toBe(true);

      // Give SIGTERM delivery a beat, then probe: signal 0 throws ESRCH once the process is gone.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    },
  );

  it("resolves a non-zero exit as an unsuccessful result with stderr captured", async () => {
    const script = `console.error("boom"); process.exit(3);`;

    const result = await invoke(nodeStrategy(script), baseParams());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("Process exited with code 3");
    expect(result.stderr).toContain("boom");
  });

  it("resolves exit 127 when the command does not exist", async () => {
    const strategy = nodeStrategy("", {
      buildInvocation: () => Effect.succeed({ command: "definitely-not-a-real-cmd-xyz", args: [] }),
    });

    const result = await invoke(strategy, baseParams());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toContain("Command not found");
  });

  it("resolves exit 127 on the sudo path when the inner command does not exist", async () => {
    // Real sudo requires a password in most test environments; use a fake sudo script that exits 127
    // to simulate the OS-level "command not found" outcome without needing real auth.
    const tmpDir = await mkdtemp(join(tmpdir(), "agent-cli-test-"));
    const fakeSudo = join(tmpDir, "sudo");
    await writeFile(fakeSudo, "#!/bin/sh\nexit 127\n", { mode: 0o755 });

    const origPath = process.env.PATH;
    const origUid = process.env.SUB_AGENT_UID;
    process.env.PATH = `${tmpDir}:${origPath ?? ""}`;
    process.env.SUB_AGENT_UID = "0";

    try {
      const strategy = nodeStrategy("", {
        buildInvocation: () =>
          Effect.succeed({ command: "definitely-not-a-real-cmd-xyz", args: [] }),
      });
      const result = await invoke(strategy, baseParams());
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.stdout).toContain("Command not found");
    } finally {
      if (origPath !== undefined) process.env.PATH = origPath;
      else delete process.env.PATH;
      if (origUid === undefined) delete process.env.SUB_AGENT_UID;
      else process.env.SUB_AGENT_UID = origUid;
      await rm(tmpDir, { recursive: true }).catch(() => {});
    }
  });

  it("feeds stdinInput to the child and closes stdin", async () => {
    const script = `
      let input = "";
      process.stdin.on("data", (d) => (input += d));
      process.stdin.on("end", () => {
        console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "got:" + input }] } }));
      });
    `;
    const strategy = nodeStrategy(script, {
      buildInvocation: () =>
        Effect.succeed({
          command: "node",
          args: ["-e", script],
          stdinInput: "ping",
        }),
    });

    const result = await invoke(strategy, baseParams());

    expect(result.success).toBe(true);
    expect(result.stdout).toBe("got:ping");
  });

  it("routes lines through a strategy streamParser, including the trailing partial line", async () => {
    const script = `process.stdout.write("alpha\\nbeta");`;
    const strategy = nodeStrategy(script, {
      buildInvocation: () =>
        Effect.succeed({
          command: "node",
          args: ["-e", script],
          streamParser: {
            parseLine(line, events, onEvent) {
              if (!line.trim()) return;
              onEvent?.({ type: "output", text: line });
              events.push({
                type: "assistant",
                message: { content: [{ type: "text", text: line }] },
              });
            },
          },
        }),
    });

    const seen: string[] = [];
    const result = await invoke(
      strategy,
      baseParams({ onEvent: (event) => seen.push(String(event["text"])) }),
    );

    expect(result.success).toBe(true);
    expect(result.stdout).toBe("alpha\nbeta");
    expect(seen).toEqual(["alpha", "beta"]);
  });

  it("short-circuits with the strategy's environment-validation result without spawning", async () => {
    const strategy = nodeStrategy("", {
      validateEnvironment: () => ({
        success: false,
        stdout: "SOME_KEY is required",
        stderr: "Missing SOME_KEY",
        exitCode: 1,
      }),
    });

    const result = await invoke(strategy, baseParams());

    expect(result).toEqual({
      success: false,
      stdout: "SOME_KEY is required",
      stderr: "Missing SOME_KEY",
      exitCode: 1,
    });
  });
});
