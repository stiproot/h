import { execFileSync, spawn } from "child_process";
import { rmSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runItestActivity } from "./run-itest.activity.ts";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("os", () => ({
  tmpdir: () => "/tmp",
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);
const mockRmSync = vi.mocked(rmSync);

function makeSpawnResult(exitCode: number, output = "") {
  const stdout = {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") cb(Buffer.from(output));
    }),
  };
  const stderr = { on: vi.fn() };
  const proc: Record<string, unknown> = { stdout, stderr };
  proc.on = vi.fn((event: string, cb: (code?: number) => void) => {
    if (event === "close") setTimeout(() => cb(exitCode), 0);
  });
  return proc;
}

// Mock execFileSync calls for the full harness path:
//   1. getTreeHash  — git rev-parse HEAD^{tree}
//   2. showFromMain — git show origin/main:scripts/itest/run-itest.sh
//   3. showFromMain — git show origin/main:scripts/itest/smoke-workflow.json
function setupExecMocks(treeHash: string, scriptContent = "#!/bin/bash\n", smokeContent = "{}") {
  mockExecFileSync
    .mockReturnValueOnce(`${treeHash}\n` as never)
    .mockReturnValueOnce(scriptContent as never)
    .mockReturnValueOnce(smokeContent as never);
}

const fakeDaprCtx = {} as never;

describe("runItestActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skip path: returns skipped result without spawning a process", async () => {
    const result = await runItestActivity(fakeDaprCtx, {
      worktreePath: "/fake/worktree",
      skip: true,
      skipReason: "break-glass: itest.skip=true set",
    });
    expect(result.class).toBe("skipped");
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.outputTail).toContain("break-glass");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("exit 0: returns passed result", async () => {
    setupExecMocks("abc1234");
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "[itest] ALL ASSERTIONS PASSED.") as never);

    const result = await runItestActivity(fakeDaprCtx, {
      worktreePath: "/fake/worktree",
    });
    expect(result.passed).toBe(true);
    expect(result.class).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.treeHash).toBe("abc1234");
  });

  it("exit 10: throws assertion failure without retry", async () => {
    setupExecMocks("def5678");
    mockSpawn.mockReturnValueOnce(
      makeSpawnResult(10, "ASSERTION FAIL: workflow not COMPLETED") as never,
    );

    await expect(runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" })).rejects.toThrow(
      /assertion failure/,
    );
    // No retry — spawn called exactly once.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("exit 11: retries once and throws infra failure if retry also fails", async () => {
    setupExecMocks("");
    mockSpawn
      .mockReturnValueOnce(makeSpawnResult(11, "ERROR: cluster not reachable") as never)
      .mockReturnValueOnce(makeSpawnResult(11, "ERROR: cluster not reachable (retry)") as never);

    await expect(runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" })).rejects.toThrow(
      /infra failure/,
    );
    // Retried once — spawn called twice.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("exit 11 then exit 0: retries once and returns passed on recovery", async () => {
    setupExecMocks("aaa1111");
    mockSpawn
      .mockReturnValueOnce(makeSpawnResult(11, "ERROR: cluster not reachable") as never)
      .mockReturnValueOnce(makeSpawnResult(0, "[itest] ALL ASSERTIONS PASSED.") as never);

    const result = await runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" });
    expect(result.passed).toBe(true);
    expect(result.class).toBe("passed");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("materializeHarness: falls back to HEAD when origin/main is unavailable", async () => {
    // getTreeHash, then origin/main throws for both files, HEAD fallback succeeds for both.
    mockExecFileSync
      .mockReturnValueOnce("bbb2222\n" as never) // getTreeHash
      .mockImplementationOnce(() => {
        throw new Error("unknown revision: origin/main");
      }) // origin/main run-itest.sh
      .mockReturnValueOnce("#!/bin/bash\n" as never) // HEAD fallback run-itest.sh
      .mockImplementationOnce(() => {
        throw new Error("unknown revision: origin/main");
      }) // origin/main smoke-workflow.json
      .mockReturnValueOnce("{}" as never); // HEAD fallback smoke-workflow.json

    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "[itest] ALL ASSERTIONS PASSED.") as never);

    const result = await runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" });
    expect(result.passed).toBe(true);
    expect(result.class).toBe("passed");
    expect(result.treeHash).toBe("bbb2222");
  });

  it("tmpdir cleanup: rmSync called on the harness dir regardless of outcome", async () => {
    setupExecMocks("ccc3333");
    mockSpawn.mockReturnValueOnce(makeSpawnResult(10, "ASSERTION FAIL") as never);

    await expect(runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" })).rejects.toThrow(
      /assertion failure/,
    );
    // The tmpdir (/tmp/h-itest-harness-<runId>) must be removed regardless of failure.
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining("/tmp/h-itest-harness-"), {
      recursive: true,
      force: true,
    });
  });
});
