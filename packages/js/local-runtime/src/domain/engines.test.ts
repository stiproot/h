import { Effect, Exit, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { claimLease, EngineHostConflict, type EngineLease, type LeasePort } from "./engines.ts";

/** A lease store whose held row and CAS outcome the test controls. */
const leaseStore = (
  held: { lease: EngineLease; revision: number } | null = null,
  casWins = true,
): { port: LeasePort; writes: Array<{ lease: EngineLease; revision: number }> } => {
  const writes: Array<{ lease: EngineLease; revision: number }> = [];
  return {
    writes,
    port: {
      read: () => Effect.succeed(held),
      write: (lease, revision) =>
        Effect.sync(() => {
          writes.push({ lease, revision });
          return casWins;
        }),
    },
  };
};

const attempt = (store: LeasePort, hostId = "host-a", atMs = 1_000_000) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.setTime(atMs);
      return yield* claimLease(store, { hostId });
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("claimLease", () => {
  it("claims an unheld lease, writing against revision 0 (must-not-exist)", async () => {
    const store = leaseStore(null);
    const exit = await attempt(store.port);

    expect(Exit.isSuccess(exit)).toBe(true);
    // Revision 0 is the CAS's "this key must not exist yet" — without it two hosts starting
    // together could both read `null` and both write.
    expect(store.writes[0]?.revision).toBe(0);
  });

  it("REFUSES a lease another host renewed recently, naming the holder", async () => {
    const store = leaseStore({ lease: { hostId: "host-b", renewedAt: 1_000_000 }, revision: 7 });
    const exit = await attempt(store.port, "host-a", 1_030_000); // 30s later — well inside the TTL

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("host-b");
    // And it must not have written: refusing and then writing anyway would BE the double-fire.
    expect(store.writes).toHaveLength(0);
  });

  it("RECLAIMS a lapsed lease, so a SIGKILLed host does not need a human", async () => {
    // A killed host cannot release its own lease. Requiring an operator to clear one by hand would
    // make every crash need attention; the TTL is what makes recovery automatic.
    const store = leaseStore({ lease: { hostId: "dead-host", renewedAt: 1_000_000 }, revision: 7 });
    const exit = await attempt(store.port, "host-a", 1_000_000 + 200_000); // past the 150s TTL

    expect(Exit.isSuccess(exit)).toBe(true);
    // Written against the HELD revision, not 0 — it is taking over a row that exists.
    expect(store.writes[0]?.revision).toBe(7);
  });

  it("renews its OWN lease however old it is", async () => {
    // The host is alive and ticking; its own lease's age says nothing about contention.
    const store = leaseStore({ lease: { hostId: "host-a", renewedAt: 1 }, revision: 3 });
    const exit = await attempt(store.port, "host-a", 9_999_999);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("refuses when the compare-and-set is LOST, rather than retrying into a race", async () => {
    // Another host claimed between our read and our write. Retrying would race again; stopping is
    // the only safe answer, because two hosts that both believe they won is the failure itself.
    const store = leaseStore(null, false);
    const exit = await attempt(store.port);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("lost the race");
  });
});

describe("EngineHostConflict", () => {
  it("says WHY only one host may tick, not merely that this one may not", () => {
    // An operator-facing refusal has to explain the consequence, or it reads as an arbitrary lock.
    expect(EngineHostConflict.of("host-b").message).toContain("double-fires");
  });
});
