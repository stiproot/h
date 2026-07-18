// `engines` layout — the engine-centric evolution of `orbits` (which is frozen):
// h's real control topology as nested orbital systems. Dead center is the
// workflow-cron-tick (the one 60s clock driving every engine scan) with dotted
// spokes to each engine hub on ring 1; each engine carries its own local orbit
// whose subjects sit at angles encoding their ORDER (clockwise from 12); and
// instances no engine owns drift to an outermost "unmanaged" belt.
// Pure: ownership resolution + slot geometry. No d3, no DOM — unit-testable.

export const DEFAULT_RING_R = 160;
export const TWELVE = -Math.PI / 2; // 12 o'clock in screen coords (y down)

export const polar = (r, a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });

const srcId = (l) => l.source?.id ?? l.source;
const tgtId = (l) => l.target?.id ?? l.target;

// Ownership priority: chains claim before crons, crons before discovers,
// alphabetical within a kind — an instance owned by two engines anchors to the
// first claimant; the other engine's edge still connects (the tug is honest).
const kindRank = (kind) => (kind === "chain" ? 0 : kind === "cron" ? 1 : 2);

// nodes/links: raw buildGraph output (links carry string endpoints + order).
// Returns { engines, ringR, unmanagedR, unmanaged }:
//   engines: [{ id, kind, angle, localR, members: [{ id, order, cursor, angle, owned }] }]
//     — member angles encode order, clockwise starting at 12 o'clock;
//   ringR: the engine ring radius, widened with engine count so neighbouring
//     local orbits stay readable (≈160 for few engines, growing with N);
//   unmanaged: [{ id, angle }] for the outer belt at unmanagedR.
export function resolveSystems(nodes, links) {
  const engineNodes = nodes
    .filter((n) => n.kind === "chain" || n.kind === "cron" || n.kind === "discover")
    .sort((a, b) => a.id.localeCompare(b.id)); // stable angle assignment across sweeps

  const membersOf = new Map(engineNodes.map((n) => [n.id, []]));
  for (const l of links) {
    const s = srcId(l);
    if (!membersOf.has(s)) continue;
    membersOf.get(s).push({ id: tgtId(l), order: l.order ?? 0, cursor: !!l.cursor });
  }
  for (const mems of membersOf.values()) mems.sort((a, b) => a.order - b.order);

  const claimOrder = [...engineNodes].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.id.localeCompare(b.id),
  );
  const owner = new Map(); // instanceId → engineId
  for (const e of claimOrder) {
    for (const m of membersOf.get(e.id)) if (!owner.has(m.id)) owner.set(m.id, e.id);
  }

  const N = engineNodes.length || 1;
  const engines = engineNodes.map((n, i) => {
    const mems = membersOf.get(n.id);
    const count = Math.max(mems.length, 1);
    const localR = 100 + Math.min(count, 6) * 5; // 100–130, scales with members
    return {
      id: n.id,
      kind: n.kind,
      angle: TWELVE + (2 * Math.PI * i) / N,
      localR,
      members: mems.map((m, j) => ({
        ...m,
        angle: TWELVE + (2 * Math.PI * j) / count, // order → clockwise from 12
        owned: owner.get(m.id) === n.id,
      })),
    };
  });

  // Ring 1 radius: keep neighbouring hubs ~1.4 local-orbit-widths apart so the
  // per-engine circles read individually (slight overlap is fine — they're faint).
  const avgLocal = engines.length
    ? engines.reduce((s, e) => s + e.localR, 0) / engines.length
    : 0;
  const ringR =
    N > 1
      ? Math.max(DEFAULT_RING_R, (1.4 * avgLocal) / (2 * Math.sin(Math.PI / N)))
      : DEFAULT_RING_R;
  const maxLocal = engines.reduce((s, e) => Math.max(s, e.localR), 0);
  const unmanagedR = ringR + maxLocal + 150;

  const unmanagedIds = nodes
    .filter((n) => n.kind === "instance" && !owner.has(n.id))
    .map((n) => n.id)
    .sort();
  const M = unmanagedIds.length || 1;
  const unmanaged = unmanagedIds.map((id, i) => ({ id, angle: TWELVE + (2 * Math.PI * i) / M }));

  return { engines, ringR, unmanagedR, unmanaged };
}

// Anchor targets for every placed node, given each engine's CURRENT center
// (member slots follow their hub as it moves): engineCenters is a Map
// engineId → {x, y}. Returns [{ id, x, y, k }] where k is the anchor strength.
export function computeSlots(systems, engineCenters) {
  const out = [];
  for (const e of systems.engines) {
    out.push({ id: e.id, ...polar(systems.ringR, e.angle), k: 0.5 });
    const c = engineCenters.get(e.id);
    if (!c) continue;
    for (const m of e.members) {
      if (!m.owned) continue;
      const p = polar(e.localR, m.angle);
      out.push({ id: m.id, x: c.x + p.x, y: c.y + p.y, k: 0.35 });
    }
  }
  for (const u of systems.unmanaged) {
    out.push({ id: u.id, ...polar(systems.unmanagedR, u.angle), k: 0.15 });
  }
  return out;
}

// The sequence arc: a thin arrow along an engine's local guide circle from its
// first member's slot to its last, tracing the clockwise order direction.
// null when there is no sequence to trace (fewer than 2 members).
export function seqArcPath(localR, memberCount) {
  if (memberCount < 2) return null;
  const a0 = TWELVE;
  const a1 = TWELVE + (2 * Math.PI * (memberCount - 1)) / memberCount;
  const p0 = polar(localR, a0);
  const p1 = polar(localR, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${localR} ${localR} 0 ${large} 1 ${p1.x} ${p1.y}`;
}
