#!/usr/bin/env node
// Environment documentation parity guard — fail LOUDLY when Compose or the Kubernetes
// secret generator reads a variable that .env.example does not declare.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const surfaces = [
  {
    path: resolve(root, "docker-compose.yml"),
    pattern: /\$\{([A-Za-z_][A-Za-z0-9_]*)/g,
  },
  {
    path: resolve(root, "cli/scripts/gen-k8s-secrets.sh"),
    pattern: /\$\{([A-Za-z_][A-Za-z0-9_]*):-/g,
  },
];

// These are intentionally supplied by compose.sh, the host, or a runtime wrapper.
// AGENT_* matches only names beginning with AGENT_; DAPR_AGENT_MODEL is therefore documented.
const allowed = (key) =>
  ["H_COMPOSE", "HOME", "PATH", "WORKFLOW_MCP_URL", "ZIPKIN_ENDPOINT", "TESSL_BIN"].includes(key) ||
  key.startsWith("DOCKER_") ||
  key.startsWith("AGENT_");

function lineNumber(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

const documented = new Set();
for (const line of readFileSync(resolve(root, ".env.example"), "utf8").split("\n")) {
  const match = line.match(/^\s*(?:#\s*)?([A-Za-z_][A-Za-z0-9_]*)=/);
  if (match) documented.add(match[1]);
}

const violations = [];
for (const surface of surfaces) {
  const content = readFileSync(surface.path, "utf8");
  for (const match of content.matchAll(surface.pattern)) {
    const key = match[1];
    if (!allowed(key) && !documented.has(key)) {
      violations.push({
        file: relative(root, surface.path),
        key,
        line: lineNumber(content, match.index),
      });
    }
  }
}

if (violations.length) {
  console.error("✗ check-env-parity: environment inputs are missing from .env.example.\n");
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line}  ${violation.key} is undocumented; add this copy-pasteable declaration to .env.example:\n    # ${violation.key}=`,
    );
  }
  process.exit(1);
}

console.log(
  "✓ check-env-parity: docker-compose.yml and cli/scripts/gen-k8s-secrets.sh inputs are documented in .env.example",
);
