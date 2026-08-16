/**
 * Registry id ⇄ JetStream KV key. The NATS sibling of core-dapr's `pathStateKey`, and it exists for
 * the same reason that one does.
 *
 * NATS validates KV keys as `/^[-/=.\w]+$/` (nats 2.29, jetstream/kv.js). h's registry ids are
 * built from `:` — `watch:sub:<instanceId>`, `cron:sub:<repo>:<slug>:<workflow>`,
 * `wf:<repo>:<slug>:<workflow>`, `exec:config` — and `:` is NOT in that set. Worse, `%` is not
 * either, so percent-encoding (the Dapr fix) is unavailable here.
 *
 * This is the SAME failure shape that bit the Dapr path-position keys on 2026-07-15: a key the
 * store accepts on write and silently fails on read, so no `cron:sub:*` row had ever landed for a
 * slashed repo and nothing said so. An encoding that is merely conventional gets bypassed once and
 * the symptom is absence, which nobody reads as an error. Hence: one codec, and
 * `scripts/check-kv-keys.mjs` fails the build on a KV call whose key did not come through it.
 *
 * The mapping:
 *
 *  - `:` → `.`   — h's segment separator becomes NATS's subject separator, so `kv.watch("wf.acme/api.>")`
 *                  works: every row for one repo, natively, which the flat Redis keyspace could not do.
 *  - `A-Za-z0-9_-/` pass through — `/` is legal in a KV key and is what keeps `owner/name` readable.
 *  - everything else → `=` + two hex digits, `=` itself included (`=3D`).
 *
 * Decoding is unambiguous because a LITERAL `.` in an id is escaped to `=2E`, so any bare `.` in an
 * encoded key can only have come from a `:`.
 *
 *   wf:acme/api:dark-mode:implement-pr   ⇄   wf.acme/api.dark-mode.implement-pr
 *   cron:sub:o/r:x:review-pr             ⇄   cron.sub.o/r.x.review-pr
 *   exec:config                          ⇄   exec.config
 */

/**
 * Encoding works on UTF-8 BYTES, not characters, so `=XX` is always exactly two hex digits.
 * A character-wise version looks correct and breaks on the first non-BMP codepoint (an emoji in a
 * slug encodes as `=1F642`, five digits, and the decoder reads two) — caught by the totality test,
 * which is the reason that test enumerates inputs no registry uses today.
 */
const COLON = 0x3a;
const isPassThrough = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || // A-Z
  (byte >= 0x61 && byte <= 0x7a) || // a-z
  (byte >= 0x30 && byte <= 0x39) || // 0-9
  byte === 0x5f || // _
  byte === 0x2d || // -
  byte === 0x2f; // /   (legal in a KV key, and what keeps `owner/name` readable)

/** A registry id → a legal JetStream KV key. Total: every id has an encoding. */
export const kvKey = (id: string): string => {
  let out = "";
  for (const byte of new TextEncoder().encode(id)) {
    if (byte === COLON) out += ".";
    else if (isPassThrough(byte)) out += String.fromCharCode(byte);
    else out += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

/**
 * A KV key → the registry id it encodes. The inverse of {@link kvKey} for every id it produced;
 * needed because `listRows` reads the bucket's KEYS and the engines expect ids.
 */
export const kvId = (key: string): string => {
  const bytes: number[] = [];
  for (let i = 0; i < key.length; i += 1) {
    const char = key[i]!;
    if (char === ".") bytes.push(COLON);
    else if (char === "=") {
      bytes.push(Number.parseInt(key.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(char.charCodeAt(0));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
};
