import { execFileSync, spawn } from "child_process";
import { describe, expect, it, vi } from "vitest";

import { runItestActivity } from "./run-itest.activity.ts";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("os", () => ({
  tmpdir: () => "/tmp",
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);

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

const fakeDaprCtx = {} as never;

describe("runItestActivity", () => {
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
    mockExecFileSync.mockReturnValueOnce("abc1234\n" as never);
    mockExecFileSync.mockReturnValueOnce("#!/bin/bash\necho ok\n" as never);
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "[itest] ALL ASSERTIONS PASSED.") as never);

    const result = await runItestActivity(fakeDaprCtx, {
      worktreePath: "/fake/worktree",
    });
    expect(result.passed).toBe(true);
    expect(result.class).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.treeHash).toBe("abc1234");
  });

  it("exit 10: throws with class=assertion in message", async () => {
    mockExecFileSync.mockReturnValueOnce("def5678\n" as never);
    mockExecFileSync.mockReturnValueOnce("#!/bin/bash\n" as never);
    mockSpawn.mockReturnValueOnce(
      makeSpawnResult(10, "ASSERTION FAIL: workflow not COMPLETED") as never,
    );

    await expect(runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" })).rejects.toThrow(
      /assertion failure/,
    );
  });

  it("exit 11: throws with class=infra in message", async () => {
    mockExecFileSync.mockReturnValueOnce("" as never);
    mockExecFileSync.mockReturnValueOnce("#!/bin/bash\n" as never);
    mockSpawn.mockReturnValueOnce(makeSpawnResult(11, "ERROR: cluster not reachable") as never);

    await expect(runItestActivity(fakeDaprCtx, { worktreePath: "/fake/worktree" })).rejects.toThrow(
      /infra failure/,
    );
  });
});
