import { execFileSync, spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { WorkflowActivityContext } from "@dapr/dapr";

// Hard timeout: ~20 minutes. The harness exits with its own taxonomy; this is the
// backstop if the harness hangs (e.g. kubectl wait stalls, registry unreachable).
const HARD_TIMEOUT_MS = 20 * 60 * 1000;

// Exit-code taxonomy (docs/plans/worktree-integration-gate.md §B):
//   0  — all assertions passed
//   10 — assertion failure (workflow not COMPLETED, wf row wrong, watch not finalised)
//   11 — infra failure (cluster/build/push/deploy/pod-ready timeout)
type ItestClass = "passed" | "assertion" | "infra" | "timeout" | "skipped";

export type ItestResult = {
  passed: boolean;
  class: ItestClass;
  exitCode: number;
  treeHash: string;
  durationMs: number;
  outputTail: string;
};

function classifyExit(code: number): ItestClass {
  if (code === 0) return "passed";
  if (code === 10) return "assertion";
  return "infra";
}

function getTreeHash(worktreePath: string): string {
  try {
    return execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

// Materialises the harness from the trusted base ref (origin/main), NOT from the worktree
// (D7: the worktree cannot neuter its own gate). Writes it to a temp dir and returns the path.
function materializeHarness(worktreePath: string, runId: string): string {
  const tmpDir = join(tmpdir(), `h-itest-harness-${runId}`);
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, "run-itest.sh");
  let scriptContent: string;
  try {
    scriptContent = execFileSync(
      "git",
      ["-C", worktreePath, "show", "origin/main:scripts/itest/run-itest.sh"],
      { encoding: "utf8", timeout: 15_000 },
    );
  } catch (err) {
    // Fallback: if origin/main doesn't have the harness yet (first deploy), use HEAD.
    scriptContent = execFileSync(
      "git",
      ["-C", worktreePath, "show", "HEAD:scripts/itest/run-itest.sh"],
      { encoding: "utf8", timeout: 15_000 },
    );
  }
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  return scriptPath;
}

type Input = {
  worktreePath: string;
  skip?: boolean;
  skipReason?: string;
  traceparent?: string;
};

export async function runItestActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<ItestResult> {
  const { worktreePath, skip, skipReason, traceparent: _tp } = input as Input;

  // Break-glass: itest.skip=true writes SKIPPED into the evidence, never executes.
  if (skip === true) {
    return {
      passed: true,
      class: "skipped",
      exitCode: 0,
      treeHash: "",
      durationMs: 0,
      outputTail: skipReason ?? "itest.skip=true (break-glass engaged)",
    };
  }

  const startMs = Date.now();
  const runId = `${Date.now()}-${process.pid}`;
  const treeHash = getTreeHash(worktreePath);

  let harnessPath: string;
  try {
    harnessPath = materializeHarness(worktreePath, runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;
    throw new Error(
      `run-itest: harness materialisation failed (infra): ${msg}\n` +
        `treeHash=${treeHash} durationMs=${durationMs}`,
    );
  }

  const outputChunks: string[] = [];
  let exitCode = -1;
  let timedOut = false;

  await new Promise<void>((resolve) => {
    const controller = new AbortController();
    const hardTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, HARD_TIMEOUT_MS);

    const proc = spawn("bash", [harnessPath, worktreePath], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      outputChunks.push(text);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("close", (code) => {
      clearTimeout(hardTimer);
      exitCode = code ?? -1;
      resolve();
    });
    proc.on("error", () => {
      clearTimeout(hardTimer);
      resolve();
    });
  });

  const durationMs = Date.now() - startMs;
  const fullOutput = outputChunks.join("");
  const outputTail = fullOutput.slice(-2000);

  if (timedOut) {
    throw new Error(
      `run-itest: hard timeout after ${durationMs}ms ` + `(treeHash=${treeHash})\n\n${outputTail}`,
    );
  }

  const cls = classifyExit(exitCode);
  if (exitCode !== 0) {
    throw new Error(
      `run-itest: ${cls} failure (exit=${exitCode}, treeHash=${treeHash}, durationMs=${durationMs})\n\n${outputTail}`,
    );
  }

  return { passed: true, class: "passed", exitCode: 0, treeHash, durationMs, outputTail };
}
