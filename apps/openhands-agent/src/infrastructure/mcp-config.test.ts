import { describe, expect, it } from "vitest";

import { resolveOpenhandsMcpConfig } from "./mcp-config.ts";

const SOURCE = JSON.stringify({
  mcpServers: {
    workflows: { url: "http://localhost:8005/sse", transport: "sse", enabled: true },
    github: {
      url: "https://api.githubcopilot.com/mcp/",
      transport: "http",
      headers: { Authorization: "Bearer ${GH_TOKEN}" },
      enabled: true,
    },
  },
});

describe("resolveOpenhandsMcpConfig", () => {
  it("substitutes ${GH_TOKEN} from the env into the github auth header", () => {
    const out = JSON.parse(resolveOpenhandsMcpConfig(SOURCE, { GH_TOKEN: "ghp_abc123" }));

    expect(out.mcpServers.github.headers.Authorization).toBe("Bearer ghp_abc123");
    expect(out.mcpServers.workflows.url).toBe("http://localhost:8005/sse");
  });

  it("collapses an unset ${VAR} to an empty string (server stays, unauthenticated)", () => {
    const out = JSON.parse(resolveOpenhandsMcpConfig(SOURCE, {}));

    expect(out.mcpServers.github.headers.Authorization).toBe("Bearer ");
    expect(out.mcpServers.workflows.enabled).toBe(true);
  });

  it("throws on a malformed source (fail fast rather than write bad config)", () => {
    expect(() => resolveOpenhandsMcpConfig("{ not json", {})).toThrow();
  });
});
