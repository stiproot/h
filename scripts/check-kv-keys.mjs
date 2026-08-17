#!/usr/bin/env node
// JetStream KV key guard — the NATS sibling of check-state-keys, enforcing a CHOKEPOINT.
//
// NATS validates KV keys as /^[-/=.\w]+$/ (nats 2.29, jetstream/kv.js), while every h registry id
// is built from `:` — `watch:sub:<id>`, `cron:sub:<repo>:<slug>:<workflow>`, `exec:config`. An
// unencoded key is rejected or stored where no read reconstructs it, and the symptom is an EMPTY
// registry rather than an error. That is exactly how the Dapr path-position bug hid on 2026-07-15,
// where no `cron:sub:*` row had ever landed for a slashed repo and nothing said so.
//
// The invariant is therefore stated as a chokepoint rather than as "encode everywhere":
//
//   1. Exactly ONE module may hold a raw JetStream KV handle — local-runtime's `nats-kv.ts`.
//      Anywhere else, `views.kv(...)` / `kvm.kv(...)` is a violation: a second holder is a second
//      place the encoding can be forgotten.
//   2. Inside that module, every KV operation passes its key through `kvKey(...)`.
//
// Rule 2 is exact only because the chokepoint holds RAW access alone: helpers built on the NatsKv
// port take a bucket where a raw call takes a key, so they live in kv-helpers.ts. When they shared
// a file the guard fired on the port itself, and the fix was to split the module rather than to
// teach the rule an exception.
//
// Stating it this way is what removes the guard's own false-positive class. An earlier version
// checked "any kv.<op>(" repo-wide and flagged `NatsKv` — h's own port over the raw client, whose
// first argument is a BUCKET, not a key. A guard that fires on the abstraction built to enforce it
// is measuring the wrong thing; the chokepoint is the thing worth defending.
//
// Wired into `bun run lint`. No skip flag by design.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one module allowed to hold a raw KV handle, and required to encode every key it passes. */
const CHOKEPOINT = "packages/js/local-runtime/src/infrastructure/nats-kv.ts";

/** KV operations that carry a key as their first argument. */
const KV_METHODS = ["get", "put", "create", "update", "delete", "purge", "history"];

/** Obtaining a raw bucket handle: `js.views.kv(...)`, `kvm.kv(...)`, `new Kvm(...).open(...)`. */
const ACQUIRE_HANDLE = /\b(?:views|kvm|Kvm)\s*\.\s*(?:kv|open|create)\s*\(/g;

/** A call on a local handle whose name marks it as a raw KV bucket. */
const KV_CALL = /\b([\w$]*(?:[Kk]v|[Bb]ucket))\s*\.\s*(\w+)\s*\(/g;

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

const scanRoots = ["apps", "packages/js"].flatMap((parent) => {
  const parentPath = resolve(root, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, parent, entry.name, "src"));
});

const violations = [];
let chokepointSeen = false;

for (const dir of scanRoots) {
  for (const file of sourceFiles(dir)) {
    const rel = relative(root, file);
    const text = readFileSync(file, "utf8");
    const lineOf = (index) => text.slice(0, index).split("\n").length;

    if (rel === CHOKEPOINT) {
      chokepointSeen = true;
      // Rule 2: inside the chokepoint, every KV operation encodes its key.
      for (const match of text.matchAll(KV_CALL)) {
        const [, , method] = match;
        if (!KV_METHODS.includes(method)) continue;
        const head = text.slice(match.index + match[0].length, match.index + match[0].length + 80);
        if (/^\s*kvKey\s*\(/.test(head)) continue;
        violations.push({
          file: rel,
          line: lineOf(match.index),
          detail: `${match[0]}…) does not encode its key — wrap it in kvKey(...)`,
        });
      }
      continue;
    }

    // Rule 1: nobody else acquires a raw handle.
    for (const match of text.matchAll(ACQUIRE_HANDLE)) {
      violations.push({
        file: rel,
        line: lineOf(match.index),
        detail:
          `${match[0]}…) acquires a raw JetStream KV handle outside ${CHOKEPOINT}. ` +
          "Go through the NatsKv port, which owns key encoding.",
      });
    }
  }
}

// The chokepoint's own absence must not read as success — a renamed or deleted file would other-
// wise silently disable rule 2 while rule 1 kept passing, which is the failure mode this guard is
// about in the first place.
if (!chokepointSeen) {
  console.error(`✗ check-kv-keys: the chokepoint ${CHOKEPOINT} was not found.`);
  console.error("  It was moved or renamed; update CHOKEPOINT here so the rule keeps applying.\n");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("✗ check-kv-keys: JetStream KV access outside its chokepoint.\n");
  for (const { file, line, detail } of violations) console.error(`  ${file}:${line}: ${detail}`);
  console.error(
    "\n  NATS accepts /^[-/=.\\w]+$/ and every h registry id contains `:`. An unencoded key is\n" +
      "  rejected or stored where no read finds it, and the symptom is an EMPTY registry rather\n" +
      "  than an error — the shape of the 2026-07-15 Dapr key bug.\n",
  );
  process.exit(1);
}

console.log("✓ check-kv-keys: raw KV access is confined to its chokepoint, and encodes every key");
