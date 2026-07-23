import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { GitClient, type WorktreeOptions } from "git-core";
import { afterEach, describe, expect, it } from "vitest";

import { RunLedger } from "./run-ledger.ts";
import { registerWorktreeRouteEffect } from "./worktree-route.ts";

const noOpLedger = Layer.succeed(RunLedger, {
  createRunDir: () => Effect.void,
  appendEvent: () => Effect.void,
  writeRunFiles: () => Effect.void,
  writeActivitySummary: () => Effect.void,
  mirrorToStatestore: () => Effect.void,
});

describe("POST /worktree defaults", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function harness() {
    const sharedRoot = mkdtempSync(join(tmpdir(), "worktree-route-test-"));
    dirs.push(sharedRoot);
    const calls: WorktreeOptions[] = [];
    const git = Layer.succeed(GitClient, {
      clone: () => Effect.void,
      addWorktree: (opts) =>
        Effect.sync(() => {
          calls.push(opts);
        }),
    });
    const runtime = ManagedRuntime.make(Layer.mergeAll(NodeFileSystem.layer, noOpLedger, git));
    const app = Fastify();
    registerWorktreeRouteEffect(app, { runtime, sharedRoot });
    await app.ready();
    return { app, calls, runtime, sharedRoot };
  }

  it("uses the mode-agnostic repo default and workspaceId-preferred path", async () => {
    const { app, calls, runtime, sharedRoot } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/worktree",
      payload: { workflowInstanceId: "wf", workspaceId: "ws", branch: "feature/x" },
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      repoPath: join(sharedRoot, "repo"),
      worktreePath: join(sharedRoot, "worktrees", "ws"),
      remoteBase: "main",
    });
    await app.close();
    await runtime.dispose();
  });

  it.each([
    [{}, "main"],
    [{ remoteBase: "" }, undefined],
    [{ remoteBase: "develop" }, "develop"],
    // An explicit baseRef always suppresses remoteBase, even when remoteBase is provided.
    [{ baseRef: "abc", remoteBase: "develop" }, undefined],
  ] as const)("resolves remoteBase from %o to %s", async (extra, expected) => {
    const { app, calls, runtime } = await harness();
    await app.inject({
      method: "POST",
      url: "/worktree",
      payload: { workflowInstanceId: "wf", ...extra },
    });
    expect(calls[0]?.remoteBase).toBe(expected);
    await app.close();
    await runtime.dispose();
  });

  it("falls back to workflowInstanceId and is idempotent when the path exists", async () => {
    const { app, calls, runtime, sharedRoot } = await harness();
    const path = join(sharedRoot, "worktrees", "wf");
    mkdirSync(path, { recursive: true });
    const response = await app.inject({
      method: "POST",
      url: "/worktree",
      payload: { workflowInstanceId: "wf" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ worktreePath: path });
    expect(calls).toEqual([]);
    await app.close();
    await runtime.dispose();
  });

  it("returns 400 for a malformed body", async () => {
    const { app, calls, runtime } = await harness();
    expect((await app.inject({ method: "POST", url: "/worktree", payload: {} })).statusCode).toBe(
      400,
    );
    expect(calls).toEqual([]);
    await app.close();
    await runtime.dispose();
  });
});
