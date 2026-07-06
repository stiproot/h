import { describe, expect, it } from "vitest";

import { mergeMcpConfig } from "./mcp-config.ts";

const servers = (json: string) => JSON.parse(json).mcpServers as Record<string, unknown>;

const H = JSON.stringify({
  mcpServers: {
    dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" },
    obs: { type: "sse", url: "http://obs-mcp:8000/sse" },
  },
});

describe("mergeMcpConfig", () => {
  it("returns the incoming config verbatim when there is no existing file", () => {
    expect(servers(mergeMcpConfig(null, H))).toEqual({
      dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" },
      obs: { type: "sse", url: "http://obs-mcp:8000/sse" },
    });
  });

  it("unions h's servers with the project's own", () => {
    const existing = JSON.stringify({
      mcpServers: { tessl: { type: "stdio", command: "tessl", args: ["mcp", "start"] } },
    });
    expect(servers(mergeMcpConfig(existing, H))).toEqual({
      tessl: { type: "stdio", command: "tessl", args: ["mcp", "start"] },
      dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" },
      obs: { type: "sse", url: "http://obs-mcp:8000/sse" },
    });
  });

  it("lets h's server win on a name conflict", () => {
    const existing = JSON.stringify({ mcpServers: { dapr: { type: "stdio", command: "old" } } });
    expect(servers(mergeMcpConfig(existing, H)).dapr).toEqual({
      type: "sse",
      url: "http://dapr-mcp:8000/sse",
    });
  });

  it("preserves other top-level keys in the existing file", () => {
    const existing = JSON.stringify({ mcpServers: {}, someProjectSetting: true });
    expect(JSON.parse(mergeMcpConfig(existing, H)).someProjectSetting).toBe(true);
  });

  it("falls back to the incoming config when the existing file is unparseable", () => {
    expect(servers(mergeMcpConfig("{ not json", H))).toEqual({
      dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" },
      obs: { type: "sse", url: "http://obs-mcp:8000/sse" },
    });
  });

  it("replace mode yields only the incoming servers regardless of cwd content", () => {
    const existing = JSON.stringify({
      mcpServers: {
        dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" },
        tessl: { type: "stdio", command: "tessl", args: ["mcp", "start"] },
      },
      someProjectSetting: true,
    });
    const result = mergeMcpConfig(existing, H, "replace");
    expect(servers(result)).toEqual({
      dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" },
      obs: { type: "sse", url: "http://obs-mcp:8000/sse" },
    });
    expect(JSON.parse(result).someProjectSetting).toBeUndefined();
  });
});
