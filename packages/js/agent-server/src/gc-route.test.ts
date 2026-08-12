import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { GitClient, type GcOptions } from "git-core";
import { afterEach, describe, expect, it } from "vitest";

import { RunLedger } from "run-ledger";
import { registerGcRouteEffect } from "./gc-route.ts";

const noOpLedger = Layer.succeed(RunLedger, {
  createRunDir: () => Effect.void,
  appendEvent: () => Effect.void,
  writeRunFiles: () => Effect.void,
  writeActivitySummary: () => Effect.void,
  mirrorToStatestore: () => Effect.void,
});

const post = (app: ReturnType<typeof Fastify>, payload: unknown) =>
  app.inject({ method: "POST", url: "/worktree/gc", payload: payload as object });

describe("POST /worktree/gc", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function harness() {
    const sharedRoot = mkdtempSync(join(tmpdir(), "gc-route-test-"));
    dirs.push(sharedRoot);
    const calls: GcOptions[] = [];
    const git = Layer.succeed(GitClient, {
      clone: () => Effect.void,
      addWorktree: () => Effect.succeed(""),
      gcWorktrees: (opts) =>
        Effect.sync(() => {
          calls.push(opts);
          return {
            removed: [
              { path: "/ws/worktrees/old", outcome: "removed" as const, untracked: [], bytes: 10 },
            ],
            kept: [
              {
                path: "/ws/worktrees/busy",
                outcome: "kept" as const,
                reason: "uncommitted changes",
                untracked: [],
              },
            ],
            bytesReclaimed: 10,
          };
        }),
    });
    const runtime = ManagedRuntime.make(Layer.mergeAll(NodeFileSystem.layer, noOpLedger, git));
    const app = Fastify();
    registerGcRouteEffect(app, { runtime, sharedRoot });
    await app.ready();
    return { app, calls, runtime, sharedRoot };
  }

  it("sweeps this service's own workspace — the caller cannot name a directory", async () => {
    const { app, calls, runtime, sharedRoot } = await harness();
    const response = await post(app, {});
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.roots).toEqual([join(sharedRoot, "worktrees")]);
    expect(calls[0]?.repoPath).toBe(join(sharedRoot, "repo"));
    await runtime.dispose();
    await app.close();
  });

  it("defaults to collecting nothing extra: no pruning, no dry run", async () => {
    const { app, calls, runtime } = await harness();
    await post(app, {});
    expect(calls[0]?.pruneUntracked).toBeUndefined();
    expect(calls[0]?.dryRun).toBeUndefined();
    await runtime.dispose();
    await app.close();
  });

  it("always spares the CALLER'S own workspace, which it is running inside", async () => {
    const { app, calls, runtime } = await harness();
    await post(app, { workspaceId: "my-run", keep: ["something-else"] });
    expect(calls[0]?.keep).toEqual(["something-else", "my-run"]);
    await runtime.dispose();
    await app.close();
  });

  it("returns the full report, including what it refused to take and why", async () => {
    const { app, runtime } = await harness();
    const response = await post(app, { pruneUntracked: true, dryRun: true });
    const body = response.json();
    expect(body.removed).toHaveLength(1);
    expect(body.kept[0].reason).toBe("uncommitted changes");
    expect(body.bytesReclaimed).toBe(10);
    await runtime.dispose();
    await app.close();
  });

  it("passes the caller's narrowing options through", async () => {
    const { app, calls, runtime } = await harness();
    await post(app, { pruneUntracked: true, minAgeMs: 3600_000, dryRun: true });
    expect(calls[0]?.pruneUntracked).toBe(true);
    expect(calls[0]?.minAgeMs).toBe(3600_000);
    expect(calls[0]?.dryRun).toBe(true);
    await runtime.dispose();
    await app.close();
  });

  it("400s a malformed body rather than sweeping on a guess", async () => {
    const { app, calls, runtime } = await harness();
    const response = await post(app, { pruneUntracked: "yes please" });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
    await runtime.dispose();
    await app.close();
  });
});
