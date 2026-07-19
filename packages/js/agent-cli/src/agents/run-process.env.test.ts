import { describe, expect, it } from "vitest";

import { isolatedSubAgentEnv } from "./run-process.ts";

// The dropped-uid bun-cache isolation (docs/plans/agent-process-identity.md): when the untrusted
// CLI runs as SUB_AGENT_UID, its `bun install` must use a per-uid cache it OWNS — never one shared
// with a different uid, which under fs.protected_hardlinks=1 would leave 0-byte stubs that break the
// native toolchain (the `Toolchain guard` gotcha in CLAUDE.md). The helper is pure, so this is a
// spawn-free unit test of the whole contract.
describe("isolatedSubAgentEnv (dropped-uid bun cache isolation)", () => {
  it("is a no-op when no uid drop is active (SUB_AGENT_UID unset) — local/host mode untouched", () => {
    const env = { HOME: "/home/stiproot", PATH: "/usr/bin" };
    expect(isolatedSubAgentEnv(env, undefined)).toBe(env); // same reference — no copy, no change
  });

  it("redirects bun's cache to a per-uid dir when SUB_AGENT_UID is set", () => {
    const out = isolatedSubAgentEnv({ HOME: "/home/claude" }, "10002");
    expect(out.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-cache-uid-10002");
    // HOME is deliberately preserved — the CLI needs it to find ~/.claude; only the cache moves.
    expect(out.HOME).toBe("/home/claude");
  });

  it("respects an explicit BUN_INSTALL_CACHE_DIR (an ops-provisioned cache wins)", () => {
    const env = { BUN_INSTALL_CACHE_DIR: "/srv/agent-bun-cache" };
    expect(isolatedSubAgentEnv(env, "10002")).toBe(env); // untouched
  });

  it("keys the cache dir by the sub-agent uid, so distinct uids never share a cache", () => {
    expect(isolatedSubAgentEnv({}, "10002").BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-cache-uid-10002");
    expect(isolatedSubAgentEnv({}, "10003").BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-cache-uid-10003");
  });
});
