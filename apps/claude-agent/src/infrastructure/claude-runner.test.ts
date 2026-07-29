import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionMcpConfig } from "core";

const H_SERVERS = JSON.stringify({
  mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/" } },
});

const CWD_SERVERS = JSON.stringify({
  mcpServers: { dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" } },
  someProjectSetting: true,
});

describe("provisionMcpConfig", () => {
  let cwd: string;
  let srcDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prov-cwd-"));
    srcDir = mkdtempSync(join(tmpdir(), "prov-src-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const run = (src: string, mode: "merge" | "replace") =>
    Effect.runPromiseExit(
      provisionMcpConfig(cwd, src, mode).pipe(Effect.provide(NodeContext.layer)),
    );

  it("replace mode overwrites the cwd config with only the source's servers", async () => {
    const src = join(srcDir, ".mcp.src.json");
    writeFileSync(src, H_SERVERS);
    writeFileSync(join(cwd, ".mcp.json"), CWD_SERVERS);
    const exit = await run(src, "replace");
    expect(Exit.isSuccess(exit)).toBe(true);
    const result = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(Object.keys(result.mcpServers)).toEqual(["github"]);
    expect(result.someProjectSetting).toBeUndefined();
  });

  it("replace mode FAILS CLOSED when the source file is missing (defect, run aborts)", async () => {
    // Silently skipping would leave the target repo's own .mcp.json — potentially h's
    // control-plane servers — in place for the agent executing untrusted specs.
    writeFileSync(join(cwd, ".mcp.json"), CWD_SERVERS);
    const exit = await run(join(srcDir, "nope.json"), "replace");
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("MCP_CONFIG_MODE=replace requires");
      expect(Cause.pretty(exit.cause)).toContain("nope.json");
    }
    // And the hostile config was not touched — but the run died before spawning the agent.
    const untouched = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(untouched.mcpServers.dapr).toBeDefined();
  });

  it("merge mode keeps the skip behavior when the source is missing", async () => {
    writeFileSync(join(cwd, ".mcp.json"), CWD_SERVERS);
    const exit = await run(join(srcDir, "nope.json"), "merge");
    expect(Exit.isSuccess(exit)).toBe(true);
    const untouched = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(untouched.mcpServers.dapr).toBeDefined();
  });

  it("merge mode preserves the cwd's servers and top-level keys (h's servers win)", async () => {
    const src = join(srcDir, ".mcp.json");
    writeFileSync(src, H_SERVERS);
    writeFileSync(join(cwd, ".mcp.json"), CWD_SERVERS);
    const exit = await run(src, "merge");
    expect(Exit.isSuccess(exit)).toBe(true);
    const result = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(Object.keys(result.mcpServers).sort()).toEqual(["dapr", "github"]);
    expect(result.someProjectSetting).toBe(true);
  });
});
