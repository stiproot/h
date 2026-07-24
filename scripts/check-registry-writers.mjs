#!/usr/bin/env node
// Dapr registry single-writer guard — fail LOUDLY when code outside a prefix's owner writes it.
//
// The statestore uses a flat shared keyspace, so two components writing the same registry prefix
// can silently corrupt each other's state. Each claimed prefix therefore has exactly one owning
// component (or one mirrored implementation boundary). This guard checks file-level co-occurrence
// because real stores declare their key constants far away from the state-write call.
//
// Harden by encoding: ownership is enforced by `bun run lint`, not left as documentation.
// No skip flag by design.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["apps", "packages", "cli"];
const excludedDirs = new Set(["dist", "node_modules", ".venv", "test", "tests"]);

const ownership = new Map([
  ["watch:", ["apps/workflow-svc/src"]],
  ["chain:", ["apps/workflow-svc/src"]],
  ["cron:", ["apps/workflow-svc/src"]],
  ["wf:", ["apps/workflow-svc/src"]],
  ["__workflow_index__", ["apps/workflow-svc/src"]],
  ["run:", ["packages/js/agent-server/src", "packages/py/agent-server/src/agent_server"]],
  ["runs:index", ["packages/js/agent-server/src", "packages/py/agent-server/src/agent_server"]],
  ["task:", ["cli/h/src", "apps/workflow-agent/src"]],
  ["tasks:index", ["cli/h/src", "apps/workflow-agent/src"]],
]);

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) files.push(...sourceFiles(join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|py)$/.test(entry.name) || /test/i.test(entry.name)) {
      continue;
    }
    files.push(join(dir, entry.name));
  }
  return files;
}

// Remove comments without removing ordinary quoted strings. Python triple-quoted blocks are
// treated as docstrings; registry key literals should be normal single-line strings.
function codeWithoutComments(text, python) {
  if (python) text = text.replace(/(?:'''[\s\S]*?'''|"""[\s\S]*?""")/g, "");
  let out = "";
  let quote = null;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || (!python && ch === "`")) {
      quote = ch;
      out += ch;
    } else if (python && ch === "#") {
      lineComment = true;
    } else if (!python && ch === "/" && next === "/") {
      lineComment = true;
      i++;
    } else if (!python && ch === "/" && next === "*") {
      blockComment = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function hasWriteCall(code) {
  return (
    /\.\s*state\s*\.\s*(?:save|delete)\s*\(/.test(code) ||
    /\bstate_(?:save|delete)\s*\(/.test(code) ||
    /\.\s*(?:save|delete|post)\s*\(/.test(code) ||
    (/\/v1\.0\/state/.test(code) && /\b(?:POST|DELETE)\b/.test(code))
  );
}

function hasPrefixLiteral(code, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:["'\`]|[furbFURB]+["'])${escaped}`, "g");
  for (const match of code.matchAll(pattern)) {
    const lineStart = code.lastIndexOf("\n", match.index) + 1;
    const lineEnd = code.indexOf("\n", match.index);
    const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);
    // An inline literal passed only to a state read is not evidence that this file writes it.
    if (!/\.\s*state\s*\.\s*get\s*\(|\b_get(?:_json)?\s*\(/.test(line)) return true;
  }
  return false;
}

function isWithin(file, owner) {
  return file === owner || file.startsWith(owner + "/");
}

const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const path of sourceFiles(resolve(root, sourceRoot))) {
    const file = relative(root, path).split(sep).join("/");
    const code = codeWithoutComments(readFileSync(path, "utf8"), path.endsWith(".py"));
    if (!hasWriteCall(code)) continue;
    for (const [prefix, owners] of ownership) {
      if (hasPrefixLiteral(code, prefix) && !owners.some((owner) => isWithin(file, owner))) {
        violations.push({ file, prefix, owners });
      }
    }
  }
}

if (violations.length) {
  console.error("check-registry-writers: state-key prefix written outside its owner:\n");
  for (const { file, prefix, owners } of violations) {
    console.error(`  ${file}: '${prefix}' must be written only in ${owners.join(" or ")}`);
  }
  process.exit(1);
}

console.log("check-registry-writers: all state-key prefix writers are in their owning directories ✓");
