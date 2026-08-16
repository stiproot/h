import { describe, expect, it } from "vitest";

import { kvId, kvKey } from "./kv-key.ts";

/** What NATS itself accepts (nats 2.29, jetstream/kv.js). Every encoding must satisfy this. */
const VALID_KV_KEY = /^[-/=.\w]+$/;

/** The real ids from every registry, including the two shapes that broke the Dapr sibling. */
const REGISTRY_IDS = [
  "watch:sub:feature-x",
  "watch:index",
  "watch:__tick__",
  "watch:ledger:2026-08-16",
  "chain:sub:dark-mode",
  "cron:sub:acme/api:dark-mode:implement-pr",
  "cron:discover:acme/api:bug",
  "cron:discover-index",
  "cron:sched:sched-abc",
  "wf:acme/api:dark-mode:implement-pr",
  "wf:stiproot/h:pi-agent:revise-pr",
  "exec:config",
  "__workflow_index__",
];

describe("kvKey", () => {
  it("encodes every registry id to a key NATS accepts", () => {
    for (const id of REGISTRY_IDS) {
      expect(kvKey(id), `id: ${id}`).toMatch(VALID_KV_KEY);
    }
  });

  it("round-trips every registry id", () => {
    for (const id of REGISTRY_IDS) {
      expect(kvId(kvKey(id)), `id: ${id}`).toBe(id);
    }
  });

  it("maps h's segment separator onto NATS's, so a prefix watch is possible", () => {
    // The point of choosing `.` over an escape: `kv.watch("wf.acme/api.>")` selects every row for
    // one repo. The flat Redis keyspace had no equivalent.
    expect(kvKey("wf:acme/api:dark-mode:implement-pr")).toBe("wf.acme/api.dark-mode.implement-pr");
    expect(kvKey("cron:sub:o/r:x:review-pr")).toBe("cron.sub.o/r.x.review-pr");
  });

  it("keeps a slashed repo readable rather than escaping it", () => {
    // `/` is legal in a KV key. Escaping it would have been safe but unreadable, and readability is
    // what makes `nats kv ls` a usable debugging surface.
    expect(kvKey("wf:acme/api:x:y")).toContain("acme/api");
  });

  it("escapes a LITERAL dot, which is what keeps decoding unambiguous", () => {
    // A bare `.` in an encoded key can then only have come from a `:`.
    expect(kvKey("wf:o/r:v1.2.3:implement-pr")).toBe("wf.o/r.v1=2E2=2E3.implement-pr");
    expect(kvId(kvKey("wf:o/r:v1.2.3:implement-pr"))).toBe("wf:o/r:v1.2.3:implement-pr");
  });

  it("escapes its own escape character", () => {
    expect(kvKey("a=b")).toBe("a=3Db");
    expect(kvId(kvKey("a=b"))).toBe("a=b");
  });

  it("round-trips ids carrying characters no current registry uses", () => {
    // Ids are built from user-supplied slugs and repo names, so the codec must be TOTAL rather than
    // correct-for-today's-inputs — the Dapr scar was exactly an input nobody had tried.
    for (const id of ["a b", "sl%ug", "emoji-🙂", "a+b", "q?x", "back\\slash", "semi;colon"]) {
      expect(kvKey(id), `id: ${id}`).toMatch(VALID_KV_KEY);
      expect(kvId(kvKey(id)), `id: ${id}`).toBe(id);
    }
  });
});
