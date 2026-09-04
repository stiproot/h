import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_DENY_MS,
  deniedMessage,
  endOfUtcDayIso,
  executorFromActivity,
  executorFromAgentId,
  isExecutorDenied,
  mergeAutoDeny,
  mergeBudgetDeny,
  normalizeDenied,
} from "./exec-policy.ts";
import type { ExecPolicy } from "./internal.ts";

const NOW = "2026-07-29T12:00:00.000Z";

describe("executorFromActivity", () => {
  it("strips the run- prefix to the executor shortname", () => {
    expect(executorFromActivity("run-codex")).toBe("codex");
    expect(executorFromActivity("run-claude")).toBe("claude");
    expect(executorFromActivity("run-kimi")).toBe("kimi");
    expect(executorFromActivity("run-dapr-agent")).toBe("dapr-agent");
    expect(executorFromActivity("run-claude-managed")).toBe("claude-managed");
  });

  it("returns undefined for non-run activities (provisioning is never gated)", () => {
    for (const name of ["setup", "clone-repo", "create-worktree", "write-wf-row", "register-cron"])
      expect(executorFromActivity(name)).toBeUndefined();
  });
});

describe("executorFromAgentId (the auto-deny's identity read)", () => {
  it("strips -agent to the gate's shortname", () => {
    expect(executorFromAgentId("codex-agent")).toBe("codex");
    expect(executorFromAgentId("kimi-agent")).toBe("kimi");
    expect(executorFromAgentId("langgraph-agent")).toBe("langgraph");
    expect(executorFromAgentId("claude-managed-agent")).toBe("claude-managed");
  });

  it("keeps dapr-agent whole — its shortname IS dapr-agent (run-dapr-agent)", () => {
    expect(executorFromAgentId("dapr-agent")).toBe("dapr-agent");
  });
});

describe("normalizeDenied (pre-provenance strings read as operator entries)", () => {
  it("maps a bare string to a never-expiring operator entry stamped with updatedAt", () => {
    const policy: ExecPolicy = { denied: ["codex"], updatedAt: NOW };
    expect(normalizeDenied(policy)).toEqual([{ name: "codex", reason: "operator", deniedAt: NOW }]);
  });

  it("passes entries through and handles an absent policy", () => {
    const entry = { name: "kimi", reason: "usage-limited" as const, deniedAt: NOW, until: NOW };
    expect(normalizeDenied({ denied: [entry], updatedAt: NOW })).toEqual([entry]);
    expect(normalizeDenied(undefined)).toEqual([]);
  });
});

describe("isExecutorDenied / activeDenial", () => {
  const policy: ExecPolicy = { denied: ["codex"], updatedAt: NOW };

  it("denies exactly the listed executors", () => {
    expect(isExecutorDenied(policy, "codex", NOW)).toBe(true);
    expect(isExecutorDenied(policy, "claude", NOW)).toBe(false);
  });

  it("allows everything when the row is absent or the list is empty (deny is explicit)", () => {
    expect(isExecutorDenied(undefined, "codex", NOW)).toBe(false);
    expect(isExecutorDenied({ denied: [], updatedAt: "" }, "codex", NOW)).toBe(false);
  });

  it("honours expiry: an auto entry denies until `until`, then lapses", () => {
    const auto: ExecPolicy = {
      denied: [
        {
          name: "kimi",
          reason: "usage-limited",
          deniedAt: NOW,
          until: "2026-07-29T18:00:00.000Z",
        },
      ],
      updatedAt: NOW,
    };
    expect(isExecutorDenied(auto, "kimi", "2026-07-29T17:59:59.000Z")).toBe(true);
    expect(isExecutorDenied(auto, "kimi", "2026-07-29T18:00:00.001Z")).toBe(false);
  });
});

describe("mergeAutoDeny (the watcher's fence — never downgrades, always idempotent)", () => {
  it("fences a previously-allowed executor with an expiring usage-limited entry", () => {
    const next = mergeAutoDeny(undefined, "kimi", NOW);
    expect(next).not.toBeNull();
    const entry = normalizeDenied(next!)[0]!;
    expect(entry).toMatchObject({ name: "kimi", reason: "usage-limited", deniedAt: NOW });
    expect(new Date(entry.until!).getTime()).toBe(new Date(NOW).getTime() + DEFAULT_AUTO_DENY_MS);
  });

  it("returns null on an operator entry — an auto action never overrides the operator", () => {
    expect(mergeAutoDeny({ denied: ["kimi"], updatedAt: NOW }, "kimi", NOW)).toBeNull();
  });

  it("returns null while an auto entry is still active (idempotent across scan ticks)", () => {
    const first = mergeAutoDeny(undefined, "kimi", NOW)!;
    expect(mergeAutoDeny(first, "kimi", "2026-07-29T13:00:00.000Z")).toBeNull();
  });

  it("replaces an EXPIRED auto entry and leaves other executors' entries untouched", () => {
    const first = mergeAutoDeny({ denied: ["codex"], updatedAt: NOW }, "kimi", NOW)!;
    const later = "2026-07-30T12:00:00.000Z"; // past the 6h expiry
    const next = mergeAutoDeny(first, "kimi", later);
    expect(next).not.toBeNull();
    const entries = normalizeDenied(next!);
    expect(entries.find((e) => e.name === "codex")).toMatchObject({ reason: "operator" });
    expect(entries.find((e) => e.name === "kimi")).toMatchObject({ deniedAt: later });
  });
});

describe("mergeBudgetDeny", () => {
  it("fences with a cost-budget entry expiring at the next UTC midnight (the day-ledger reset)", () => {
    const next = mergeBudgetDeny({ denied: [], updatedAt: NOW, budgets: { kimi: 5 } }, "kimi", NOW);
    expect(next).not.toBeNull();
    const entry = normalizeDenied(next!)[0]!;
    expect(entry).toMatchObject({ name: "kimi", reason: "cost-budget", deniedAt: NOW });
    expect(entry.until).toBe(endOfUtcDayIso(NOW));
    // The budget table rides along — a deny merge never drops it.
    expect(next!.budgets).toEqual({ kimi: 5 });
  });

  it("returns null on an operator entry — a budget fence never overrides the operator", () => {
    expect(mergeBudgetDeny({ denied: ["kimi"], updatedAt: NOW }, "kimi", NOW)).toBeNull();
  });

  it("returns null while ANY active entry covers the executor (already fenced; idempotent)", () => {
    const usage = mergeAutoDeny(undefined, "kimi", NOW)!;
    expect(mergeBudgetDeny(usage, "kimi", NOW)).toBeNull();
    const budget = mergeBudgetDeny(undefined, "kimi", NOW)!;
    expect(mergeBudgetDeny(budget, "kimi", "2026-07-29T13:00:00.000Z")).toBeNull();
  });

  it("mergeAutoDeny also preserves the budget table", () => {
    const next = mergeAutoDeny(
      { denied: [], updatedAt: NOW, budgets: { claude: 20 } },
      "kimi",
      NOW,
    );
    expect(next!.budgets).toEqual({ claude: 20 });
  });
});

describe("endOfUtcDayIso", () => {
  it("is the next UTC midnight", () => {
    expect(endOfUtcDayIso("2026-07-30T18:45:00.000Z")).toBe("2026-07-31T00:00:00.000Z");
    expect(endOfUtcDayIso("2026-07-31T00:00:00.000Z")).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("deniedMessage", () => {
  it("names the executor and the way back out", () => {
    expect(deniedMessage("codex")).toContain("'codex'");
    expect(deniedMessage("codex")).toContain("h agents allow codex");
  });

  it("names the LOCAL registry's lift when the local substrate refused", () => {
    expect(deniedMessage("codex", undefined, "local")).toMatch(/h agents allow codex --local$/);
    expect(deniedMessage("codex")).not.toContain("--local");
  });

  it("carries the auto provenance and expiry when the denial is usage-limited", () => {
    const msg = deniedMessage("kimi", {
      name: "kimi",
      reason: "usage-limited",
      deniedAt: NOW,
      until: "2026-07-29T18:00:00.000Z",
    });
    expect(msg).toContain("usage-limited");
    expect(msg).toContain("expires 2026-07-29T18:00:00.000Z");
  });
});
