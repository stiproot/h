import { describe, expect, it } from "vitest";

import { resolveAgent, UnknownAgentError } from "./agents.ts";

describe("resolveAgent", () => {
  it("resolves every direct agent under both its bare and -agent name", () => {
    for (const [name, expected] of [
      ["claude", "claude"],
      ["claude-agent", "claude"],
      ["codex", "codex"],
      ["codex-agent", "codex"],
      ["openhands", "openhands"],
      ["openhands-agent", "openhands"],
      ["pi", "pi"],
      ["pi-agent", "pi"],
    ] as const) {
      expect(resolveAgent(name)).toBe(expected);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveAgent("  Codex ")).toBe("codex");
  });

  // Fail loud: a name this substrate cannot run must never fall back to a default agent, which
  // would silently bill the wrong provider and answer as the wrong executor.
  it("refuses an unknown agent, naming what is available", () => {
    expect(() => resolveAgent("gpt")).toThrow(UnknownAgentError);
    expect(() => resolveAgent("gpt")).toThrow(/claude, codex, openhands, pi/);
  });

  // Service-only agents are a distinct case worth its own hint: they exist in h, just not here.
  it("points a service-only agent at the other substrate", () => {
    expect(() => resolveAgent("kimi")).toThrow(/drop --direct/);
  });
});
