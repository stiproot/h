import { describe, expect, it } from "vitest";

import { DEFAULT_STEP_SPEND, type QuotaReport, type QuotaRow } from "./internal.ts";
import {
  decide,
  DEFAULT_MAX_WAIT_MS,
  estimateStepSpend,
  fenceUntilFrom,
  foldQuotaRow,
  quotaRefusalMessage,
  RESET_SLACK_MS,
} from "./quota.ts";

const NOW = "2026-09-02T10:00:00.000Z";
const RESET_5H = "2026-09-02T12:00:00.000Z";
const RESET_7D = "2026-09-08T12:00:00.000Z";

const row = (five: number, overrides: Partial<QuotaRow> = {}): QuotaRow => ({
  executor: "claude",
  status: "allowed",
  windows: {
    five_hour: { utilization: five, resetsAt: RESET_5H },
    seven_day: { utilization: 0.2, resetsAt: RESET_7D },
  },
  observedAt: "2026-09-02T09:50:00.000Z",
  runId: "g:claude:1",
  history: [],
  updatedAt: "2026-09-02T09:50:00.000Z",
  ...overrides,
});

const history = (...spent: number[]) =>
  spent.map((s, i) => ({ runId: `g:claude:${i}`, observedAt: NOW, spent: { five_hour: s } }));

describe("estimateStepSpend", () => {
  it("is the default with no history, the mean of the history otherwise", () => {
    expect(estimateStepSpend(undefined, "five_hour")).toBe(DEFAULT_STEP_SPEND);
    expect(estimateStepSpend(row(0.1, { history: history(0.04, 0.08) }), "five_hour")).toBeCloseTo(
      0.06,
    );
    expect(estimateStepSpend(row(0.1), "seven_day")).toBeCloseTo(DEFAULT_STEP_SPEND / 34);
  });
});

describe("decide (the pre-fire quota gate)", () => {
  it("proceeds with no row, and with headroom", () => {
    expect(decide(undefined, { nowIso: NOW })).toEqual({ action: "proceed" });
    expect(decide(row(0.5), { nowIso: NOW })).toEqual({ action: "proceed" });
  });

  it("refuses by name when utilization + the estimate would cross the window", () => {
    const decision = decide(row(0.95), { nowIso: NOW });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.window).toBe("five_hour");
    expect(decision.resetsAt).toBe(RESET_5H);
    expect(decision.reason).toContain("95%");
    expect(decision.reason).toContain("~10%");
    expect(quotaRefusalMessage(decision)).toContain("--on-quota wait");
    expect(quotaRefusalMessage(decision)).toContain(`--at ${RESET_5H}`);
  });

  it("refuses a rejected observation whatever the estimate says", () => {
    const limited = row(1, { status: "rejected", history: history(0) });
    expect(decide(limited, { nowIso: NOW }).action).toBe("refuse");
  });

  it("uses the history's mean as the estimate", () => {
    // 0.88 + mean(0.02, 0.04) = 0.91 → fits under the fail ceiling, not under the wait ceiling.
    const warm = row(0.88, { history: history(0.02, 0.04) });
    expect(decide(warm, { nowIso: NOW }).action).toBe("proceed");
    expect(decide(warm, { nowIso: NOW, onQuota: "wait" }).action).toBe("wait");
  });

  it("waits until the reset plus slack under --on-quota wait, when the wait is bounded", () => {
    const decision = decide(row(0.95), { nowIso: NOW, onQuota: "wait" });
    expect(decision).toMatchObject({
      action: "wait",
      window: "five_hour",
      untilIso: new Date(new Date(RESET_5H).getTime() + RESET_SLACK_MS).toISOString(),
    });
  });

  it("refuses rather than waits past the wait bound (a seven-day reset)", () => {
    const weekly = row(0.1, {
      windows: { seven_day: { utilization: 0.999, resetsAt: RESET_7D } },
    });
    const decision = decide(weekly, { nowIso: NOW, onQuota: "wait" });
    expect(decision.action).toBe("refuse");
    expect(new Date(RESET_7D).getTime() - new Date(NOW).getTime()).toBeGreaterThan(
      DEFAULT_MAX_WAIT_MS,
    );
  });

  it("treats an observation whose window has since reset as no information", () => {
    const stale = row(1, {
      status: "rejected",
      windows: { five_hour: { utilization: 1, resetsAt: "2026-09-02T09:59:00.000Z" } },
    });
    expect(decide(stale, { nowIso: NOW })).toEqual({ action: "proceed" });
  });
});

describe("foldQuotaRow", () => {
  const report: QuotaReport = {
    status: "allowed_warning",
    windows: { five_hour: { utilization: 0.91, resetsAt: RESET_5H } },
    observedAt: NOW,
    spent: { five_hour: 0.06 },
  };

  it("replaces the window state, keeps windows the report did not mention, upserts history by run", () => {
    const first = foldQuotaRow(
      row(0.5, { history: history(0.03) }),
      "claude",
      report,
      "g:claude:9",
      NOW,
    );
    expect(first.windows.five_hour?.utilization).toBe(0.91);
    expect(first.windows.seven_day?.utilization).toBe(0.2);
    expect(first.history.map((e) => e.runId)).toEqual(["g:claude:0", "g:claude:9"]);
    const again = foldQuotaRow(
      first,
      "claude",
      { ...report, spent: { five_hour: 0.08 } },
      "g:claude:9",
      NOW,
    );
    expect(again.history).toHaveLength(2);
    expect(again.history.at(-1)?.spent.five_hour).toBe(0.08);
  });

  it("caps the history at the newest entries", () => {
    let acc: QuotaRow | undefined;
    for (let i = 0; i < 25; i++) acc = foldQuotaRow(acc, "claude", report, `g:claude:${i}`, NOW);
    expect(acc?.history).toHaveLength(20);
    expect(acc?.history[0]?.runId).toBe("g:claude:5");
  });
});

describe("fenceUntilFrom", () => {
  it("uses a Codex rejected observation's synthetic exhausted slot plus reset slack", () => {
    const codex: QuotaReport = {
      status: "rejected",
      windows: { five_hour: { utilization: 1, resetsAt: "2026-09-04T10:13:00.000Z" } },
      observedAt: "2026-09-04T09:50:00.000Z",
      spent: {},
    };
    expect(fenceUntilFrom(codex, "2026-09-04T09:50:00.000Z")).toBe("2026-09-04T10:14:00.000Z");
  });

  it("is the exhausted window's reset plus slack, else undefined", () => {
    const limited: QuotaReport = {
      status: "rejected",
      windows: {
        five_hour: { utilization: 1, resetsAt: RESET_5H },
        seven_day: { utilization: 0.3, resetsAt: RESET_7D },
      },
      observedAt: NOW,
      spent: {},
    };
    expect(fenceUntilFrom(limited, NOW)).toBe(
      new Date(new Date(RESET_5H).getTime() + RESET_SLACK_MS).toISOString(),
    );
    expect(
      fenceUntilFrom(
        { ...limited, windows: { five_hour: { utilization: 0.4, resetsAt: RESET_5H } } },
        NOW,
      ),
    ).toBeUndefined();
    expect(fenceUntilFrom(undefined, NOW)).toBeUndefined();
  });
});
