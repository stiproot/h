#!/usr/bin/env node
// JetStream KV key guard — fail LOUDLY when a KV operation does not encode its key with kvKey(...).
//
// The NATS sibling of check-state-keys, and it exists because the same bug is available here.
// NATS validates KV keys as /^[-/=.\w]+$/ (nats 2.29, jetstream/kv.js), while every h registry id
// is built from `:` — `watch:sub:<id>`, `cron:sub:<repo>:<slug>:<workflow>`, `exec:config`. A raw
// id is therefore REJECTED or, once wrapped in a bucket that tolerates it, saved under a key no
// read will reconstruct.
//
// That is precisely how the Dapr path-position bug hid (2026-07-15): writes looked fine, reads
// returned nothing, and no `cron:sub:*` row had ever landed for a slashed repo. The symptom of a
// key-encoding bug is ABSENCE, which nobody reads as an error — so the encoding cannot be left to
// convention. Every `kv.get/put/create/update/delete/purge/history` call in scanned production
// TypeScript must pass a key that came through local-runtime's `kvKey`.
//
// Like its sibling, the match is deliberately broad: any `.get(...)`-shaped call on an identifier
// whose name marks it as a KV handle counts. An unrelated API must avoid that shape or live
// outside the scanned trees, so the guard cannot silently miss a real KV call.
//
// Wired into `bun run lint`. No skip flag by design.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const scanRoots = [
  ...["apps", "packages/js"].flatMap((parent) => {
    const parentPath = resolve(root, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(root, parent, entry.name, "src"));
  }),
];

/** KV operations that carry a key as their first argument. */
const KV_METHODS = ["get", "put", "create", "update", "delete", "purge", "history"];

/**
 * An identifier is treated as a KV handle when its name says so — `kv`, `bucket`, `rowsKv`, …
 *
 * The optional prefix is load-bearing and was wrong once: written as `[A-Za-z_$][\w$]*(?:[Kk]v)`
 * it cannot match the bare name `kv` at all (the leading class eats the `k`, leaving one char for a
 * two-char suffix), so the guard reported success against a planted `kv.get("watch:sub:x")`. A
 * guard that matches nothing and a guard that finds nothing print the same line.
 */
const KV_HANDLE = /\b([\w$]*(?:[Kk]v|[Bb]ucket))\s*\.\s*(\w+)\s*\(/g;

function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** The codec itself, and its tests, are where raw keys legitimately appear. */
const isCodec = (file) => /local-runtime\/src\/infrastructure\/kv-key\.ts$/.test(file);

const violations = [];

for (const dir of scanRoots) {
  for (const file of sourceFiles(dir)) {
    if (isCodec(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(KV_HANDLE)) {
      const [, handle, method] = match;
      if (!KV_METHODS.includes(method)) continue;
      // The argument list starts after the `(`; only its head matters — the key is first.
      const argsStart = match.index + match[0].length;
      const head = text.slice(argsStart, argsStart + 120);
      if (/^\s*kvKey\s*\(/.test(head)) continue;
      // A key already held in a variable the codec produced is fine when it says so by name.
      if (/^\s*\w*[Kk]ey\b/.test(head) && !/^\s*['"`]/.test(head)) continue;
      violations.push({
        file: relative(root, file),
        line: text.slice(0, match.index).split("\n").length,
        call: `${handle}.${method}(`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("✗ check-kv-keys: JetStream KV operation with an unencoded key.\n");
  for (const { file, line, call } of violations) {
    console.error(`  ${file}:${line}: ${call}…) — wrap the key in kvKey(...)`);
  }
  console.error(
    "\n  NATS accepts /^[-/=.\\w]+$/ and every h registry id contains `:`. An unencoded key is\n" +
      "  rejected or stored where no read finds it, and the symptom is an EMPTY registry rather\n" +
      "  than an error — the exact shape of the 2026-07-15 Dapr key bug.\n",
  );
  process.exit(1);
}

console.log("✓ check-kv-keys: every JetStream KV key is encoded with kvKey");
