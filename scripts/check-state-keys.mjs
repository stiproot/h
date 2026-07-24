#!/usr/bin/env node
// Dapr path-position state-key guard — fail LOUDLY when a state read/delete does not encode its
// key with pathStateKey(...).
//
// Dapr saves keys in a request body, but get/delete carry the key in the HTTP URL path. A raw key
// containing `/` can therefore save successfully and later 404 on read/delete. Every dotted
// `@dapr/dapr` `.state.get(...)` / `.state.delete(...)` call must wrap its final key argument with
// core-dapr's pathStateKey. Harden by encoding this invariant instead of relying on convention.
//
// Wired into `bun run lint` (package.json) beside the other content guards. No skip flag by design.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [
  ...readdirSync(resolve(root, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, "apps", entry.name, "src")),
  ...readdirSync(resolve(root, "packages/js"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, "packages/js", entry.name, "src")),
];

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function codePositions(text) {
  const positions = new Uint8Array(text.length);
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      i++;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else {
      positions[i] = 1;
    }
  }
  return positions;
}

function matchingParen(text, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = open; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      i++;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function finalArgument(args) {
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if ("([{".includes(char)) {
      depth++;
    } else if (")]}".includes(char)) {
      depth--;
    } else if (char === "," && depth === 0) {
      start = i + 1;
    }
  }
  return args.slice(start).trim();
}

const violations = [];
const callPattern = /\.state\.(?:get|delete)\s*\(/g;
for (const path of scanRoots.filter(existsSync).flatMap(sourceFiles)) {
  const text = readFileSync(path, "utf8");
  const positions = codePositions(text);
  for (const match of text.matchAll(callPattern)) {
    if (!positions[match.index]) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingParen(text, open);
    const argument = close < 0 ? "" : finalArgument(text.slice(open + 1, close));
    if (/^pathStateKey\s*\(/.test(argument)) continue;

    const line = text.slice(0, match.index).split("\n").length;
    const end = close < 0 ? text.indexOf("\n", match.index) : close + 1;
    const snippet = text
      .slice(match.index, end < 0 ? text.length : end)
      .replace(/\s+/g, " ")
      .trim();
    violations.push({ file: relative(root, path), line, snippet });
  }
}

if (violations.length > 0) {
  console.error("✗ check-state-keys: unencoded Dapr path-position state key found.\n");
  console.error("  Wrap every `.state.get` / `.state.delete` key with `pathStateKey(...)`; see");
  console.error("  packages/js/core-dapr/src/state-key.ts and the CLAUDE.md state-key gotcha.\n");
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.snippet}`);
  }
  process.exit(1);
}

console.log("✓ check-state-keys: all Dapr read/delete keys use pathStateKey");
