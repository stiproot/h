import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerAgentRoutesEffect } from "./agent-routes.ts";
import { RunLedger } from "run-ledger";
import { AgentRunner } from "./runner.ts";

const noOpLedger = Layer.succeed(RunLedger, {
  createRunDir: () => Effect.void,
  appendEvent: () => Effect.void,
  writeRunFiles: () => Effect.void,
  writeActivitySummary: () => Effect.void,
  mirrorToStatestore: () => Effect.void,
});
const noOpRunner = Layer.succeed(AgentRunner, {
  run: () => Effect.die("unused"),
});

describe("POST /setup idempotency", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function harness() {
    const root = mkdtempSync(join(tmpdir(), "agent-setup-test-"));
    dirs.push(root);
    const runtime = ManagedRuntime.make(Layer.mergeAll(NodeContext.layer, noOpLedger, noOpRunner));
    const app = Fastify();
    registerAgentRoutesEffect(app, {
      runtime,
      resolveWorkspaceDir: (key) => join(root, key),
    });
    await app.ready();
    return { app, root, runtime };
  }

  it("skips commands for an identical spec and reruns after a spec change", async () => {
    const { app, root, runtime } = await harness();
    const counter = join(root, "count");
    const first = {
      workflowInstanceId: "wf",
      setup: [{ cmd: `printf x >> ${counter}` }],
    };
    expect((await app.inject({ method: "POST", url: "/setup", payload: first })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: "POST", url: "/setup", payload: first })).statusCode).toBe(
      204,
    );
    expect(readFileSync(counter, "utf8")).toBe("x");
    const changed = {
      workflowInstanceId: "wf",
      setup: [{ cmd: `printf y >> ${counter}` }],
    };
    expect((await app.inject({ method: "POST", url: "/setup", payload: changed })).statusCode).toBe(
      204,
    );
    expect(readFileSync(counter, "utf8")).toBe("xy");
    await app.close();
    await runtime.dispose();
  });

  it("leaves no sentinel after failure so the next call retries", async () => {
    const { app, root, runtime } = await harness();
    const body = { workflowInstanceId: "wf", setup: [{ cmd: "exit 7" }] };
    expect((await app.inject({ method: "POST", url: "/setup", payload: body })).statusCode).toBe(
      500,
    );
    expect((await app.inject({ method: "POST", url: "/setup", payload: body })).statusCode).toBe(
      500,
    );
    expect(() => readFileSync(join(root, "wf", ".agent-setup-complete"))).toThrow();
    await app.close();
    await runtime.dispose();
  });

  it("pins JSON.stringify hashing of the decoded JS setup shape", async () => {
    const { app, root, runtime } = await harness();
    const cmd = "true";
    const body = { workflowInstanceId: "wf", setup: [{ validateCmd: "true", cmd }] };
    expect((await app.inject({ method: "POST", url: "/setup", payload: body })).statusCode).toBe(
      204,
    );
    // Python's sibling test intentionally pins sorted-key JSON; JS currently hashes JSON.stringify.
    const expected = createHash("sha256")
      .update(JSON.stringify([{ cmd, validateCmd: "true" }]))
      .digest("hex");
    expect(readFileSync(join(root, "wf", ".agent-setup-complete"), "utf8")).toBe(expected);
    await app.close();
    await runtime.dispose();
  });
});
