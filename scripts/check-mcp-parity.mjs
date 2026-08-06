#!/usr/bin/env node
// MCP configuration parity guard — agent runtimes must expose the same server set locally and in
// Docker, and Kubernetes must expose that set minus explicitly documented unavailable deployments.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = join(root, "apps");
const agentApps = new Set(["claude-agent", "codex-agent", "openhands-agent"]);
const k8sConfigs = {
  "claude-agent": { file: "k8s/apps/claude-agent.yaml", key: "mcp.json" },
  "codex-agent": { file: "k8s/apps/codex-agent.yaml", key: ".mcp.json" },
  // OpenHands is checked for local/Docker parity only because it has no Kubernetes ConfigMap.
  "openhands-agent": null,
};
const K8S_ABSENT = {
  "claude-agent": new Set(["obs"]),
  "codex-agent": new Set(["obs"]),
};

function lineAt(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

function serverSet(path) {
  const content = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${relative(root, path)}:1: invalid JSON (${error.message})`);
  }
  if (
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== "object" ||
    Array.isArray(parsed.mcpServers)
  ) {
    throw new Error(`${relative(root, path)}:1: expected an object at "mcpServers"`);
  }
  return new Set(Object.keys(parsed.mcpServers));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configMapServerSet({ file, key }) {
  const path = join(root, file);
  const content = readFileSync(path, "utf8");
  const header = new RegExp(
    `^(\\s*)${escapeRegExp(key)}:\\s*([|>])(?:[+-])?\\s*(?:#.*)?$`,
    "m",
  ).exec(content);
  if (!header) throw new Error(`${file}:1: could not find block scalar data key \`${key}\``);

  const headerIndent = header[1].length;
  const afterHeader = header.index + header[0].length;
  const following = content.slice(afterHeader).replace(/^\r?\n/, "");
  const lines = following.split(/\r?\n/);
  const blockLines = [];
  for (const line of lines) {
    if (line.trim() && line.match(/^ */)[0].length <= headerIndent) break;
    blockLines.push(line);
  }
  const nonBlank = blockLines.filter((line) => line.trim());
  if (nonBlank.length === 0)
    throw new Error(`${file}:${lineAt(content, header.index)}: empty \`${key}\` block`);
  const blockIndent = Math.min(...nonBlank.map((line) => line.match(/^ */)[0].length));
  const json = blockLines.map((line) => line.slice(blockIndent)).join("\n");
  try {
    const parsed = JSON.parse(json);
    if (
      !parsed.mcpServers ||
      typeof parsed.mcpServers !== "object" ||
      Array.isArray(parsed.mcpServers)
    ) {
      throw new Error('expected an object at "mcpServers"');
    }
    return {
      servers: new Set(Object.keys(parsed.mcpServers)),
      line: lineAt(content, header.index),
    };
  } catch (error) {
    throw new Error(
      `${file}:${lineAt(content, afterHeader) + 1}: invalid embedded JSON (${error.message})`,
    );
  }
}

function difference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

function compare(actual, expected) {
  return { missing: difference(expected, actual), extra: difference(actual, expected) };
}

function reportMismatch(file, line, expectedFrom, { missing, extra }) {
  console.error(`✗ check-mcp-parity: ${file}:${line}: MCP server-set mismatch.`);
  if (missing.length) console.error(`  Missing: ${missing.join(", ")}`);
  if (extra.length) console.error(`  Extra: ${extra.join(", ")}`);
  console.error(`  Fix: update ${file} so its mcpServers keys match ${expectedFrom}.`);
}

export function checkMcpParity() {
  let failed = false;
  const apps = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && agentApps.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  try {
    for (const app of apps) {
      const dockerFile = `apps/${app}/.mcp.json`;
      const localFile = `apps/${app}/.mcp.host.json`;
      const dockerServers = serverSet(join(root, dockerFile));
      const localServers = serverSet(join(root, localFile));
      const localDiff = compare(localServers, dockerServers);
      if (localDiff.missing.length || localDiff.extra.length) {
        reportMismatch(localFile, 1, dockerFile, localDiff);
        failed = true;
      }

      const k8s = k8sConfigs[app];
      if (!k8s) continue;
      const expectedK8s = new Set(
        [...dockerServers].filter((server) => !K8S_ABSENT[app].has(server)),
      );
      const embedded = configMapServerSet(k8s);
      const k8sDiff = compare(embedded.servers, expectedK8s);
      if (k8sDiff.missing.length || k8sDiff.extra.length) {
        reportMismatch(
          k8s.file,
          embedded.line,
          `${dockerFile} minus K8S_ABSENT (${[...K8S_ABSENT[app]].join(", ")})`,
          k8sDiff,
        );
        failed = true;
      }
    }
  } catch (error) {
    console.error(`✗ check-mcp-parity: ${error.message}`);
    failed = true;
  }

  if (failed) return 1;
  console.log("✓ check-mcp-parity: app local/Docker and Kubernetes MCP server-set parity checked");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkMcpParity());
}
