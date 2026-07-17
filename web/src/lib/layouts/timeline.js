// `timeline` layout — no simulation at all: a Gantt of per-instance lanes with
// one bar per agent run (x = startedAt→endedAt). The only view that shows
// concurrency honestly — parallel runs literally overlap in a lane.
// Pure geometry: buildGraph nodes in, { lanes, bars, domain } out. Scales and
// pixels belong to the component; this module stays unit-testable.

const ts = (t) => (t ? Date.parse(t) || 0 : 0);

export function buildTimeline(nodes, { now = Date.now() } = {}) {
  const lanes = [];
  const bars = [];

  for (const n of nodes) {
    if (n.kind !== "instance" || !n.runs?.length) continue;
    let first = Infinity;
    let last = -Infinity;
    for (const r of n.runs) {
      const start = ts(r.startedAt);
      if (!start) continue;
      // A still-running run has no endedAt — extend its bar to "now".
      const end = Math.max(ts(r.endedAt) || now, start + 1);
      first = Math.min(first, start);
      last = Math.max(last, end);
      bars.push({
        laneId: n.id,
        runId: r.runId,
        agentId: r.agentId,
        model: r.model || null,
        status: r.status,
        turns: r.turns ?? null,
        costUsd: r.costUsd ?? null,
        start,
        end,
        running: !r.endedAt,
      });
    }
    if (first === Infinity) continue;
    lanes.push({ id: n.id, status: n.status, first, last, runCount: n.runs.length, costUsd: n.costUsd });
  }

  // Newest activity at the top.
  lanes.sort((a, b) => b.first - a.first);

  // Concurrency slots (interval partitioning): bars in one lane whose time
  // ranges overlap get distinct sub-rows, so parallel runs render as visibly
  // co-occurring stacked bars instead of occluding each other — load-bearing
  // when short parallel runs collapse to min-width slivers on a long axis.
  const byLane = new Map();
  for (const b of bars) {
    if (!byLane.has(b.laneId)) byLane.set(b.laneId, []);
    byLane.get(b.laneId).push(b);
  }
  const slotCounts = new Map();
  for (const [laneId, laneBars] of byLane) {
    laneBars.sort((a, b) => a.start - b.start);
    const slotEnds = [];
    for (const b of laneBars) {
      let slot = slotEnds.findIndex((end) => end <= b.start);
      if (slot === -1) {
        slot = slotEnds.length;
        slotEnds.push(b.end);
      } else {
        slotEnds[slot] = b.end;
      }
      b.slot = slot;
    }
    slotCounts.set(laneId, slotEnds.length);
  }
  for (const lane of lanes) lane.slotCount = slotCounts.get(lane.id) || 1;

  const min = Math.min(...bars.map((b) => b.start));
  const max = Math.max(...bars.map((b) => b.end));
  const domain = bars.length ? [min, max] : [now - 3600_000, now];

  return { lanes, bars, domain };
}
