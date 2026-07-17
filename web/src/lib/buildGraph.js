// Pure graph assembly: registry rows + ledger runs + polled statuses in,
// { nodes, links, rings } out. No fetches, no DOM, no d3 — unit-testable.
import { radiusForCost } from "./constants.js";

const ts = (t) => (t ? Date.parse(t) || 0 : 0);

// Discover-fired feature instances follow workflow-svc's issueInstanceId
// convention (`feature-issue-<n>`) — the only key-prefix link we can draw.
const DISCOVER_PREFIX = "feature-issue-";

// Every workflow instance the runtime knows about, with a last-activity stamp
// so the poller can cap status calls to the most recent N. Exported separately
// from buildGraph because the App needs the id set BEFORE it fetches statuses.
export function collectInstances({ watches = [], chains = [], crons = [], discovers = [], runs = [] }) {
  const acc = new Map(); // id → newest activity timestamp (ms)
  const touch = (id, t) => {
    if (!id) return;
    acc.set(id, Math.max(acc.get(id) || 0, ts(t)));
  };
  for (const r of runs) touch(r.workflowInstanceId, r.endedAt || r.startedAt);
  for (const w of watches) touch(w.instanceId, w.updatedAt || w.startedAt);
  for (const c of chains) {
    for (const m of c.workflows || []) touch(m.instanceId, c.updatedAt || c.startedAt);
    touch(c.currentInstanceId, c.updatedAt || c.startedAt);
  }
  for (const c of crons) touch(c.currentInstanceId || c.instanceId, c.updatedAt || c.lastRunAt || c.createdAt);
  // discover rows carry no member list; their fired instances arrive via runs.
  void discovers;
  return [...acc.entries()]
    .map(([id, lastActivity]) => ({ id, lastActivity }))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

export const chainNodeId = (c) => `chain:${c.chainId}`;
export const cronNodeId = (c) => `cron:${c.repo}:${c.slug}:${c.workflow}`;
export const discoverNodeId = (d) => `discover:${d.repo}:${d.label}`;

// rows: { watches, chains, crons, discovers, runs, statuses }
//   statuses: { [instanceId]: runtimeStatus }
export function buildGraph(rows) {
  const { watches = [], chains = [], crons = [], discovers = [], runs = [], statuses = {} } = rows;

  const instances = collectInstances(rows);
  const nodes = [];
  const links = [];
  const seenLink = new Set();
  const addLink = (l) => {
    const key = `${l.type}:${l.source}>${l.target}`;
    if (seenLink.has(key)) {
      // A chain can list one instanceId twice (e.g. feature + revise share a
      // worktree instance) — keep the cursor highlight if any occurrence has it.
      if (l.cursor) {
        const prev = links.find((p) => `${p.type}:${p.source}>${p.target}` === key);
        if (prev) prev.cursor = true;
      }
      return;
    }
    seenLink.add(key);
    links.push(l);
  };

  // --- instance nodes -------------------------------------------------------
  const runsByInstance = new Map();
  for (const r of runs) {
    if (!r.workflowInstanceId) continue;
    if (!runsByInstance.has(r.workflowInstanceId)) runsByInstance.set(r.workflowInstanceId, []);
    runsByInstance.get(r.workflowInstanceId).push(r);
  }
  const watchByInstance = new Map(watches.map((w) => [w.instanceId, w]));

  const instanceNode = new Map();
  for (const { id, lastActivity } of instances) {
    const myRuns = (runsByInstance.get(id) || [])
      .slice()
      .sort((a, b) => ts(b.startedAt) - ts(a.startedAt));
    const costUsd = myRuns.reduce((s, r) => s + (r.costUsd || 0), 0);
    const node = {
      id,
      kind: "instance",
      status: statuses[id] || "UNKNOWN",
      costUsd,
      r: radiusForCost(costUsd),
      runs: myRuns,
      lastActivity,
      watch: watchByInstance.get(id) || null,
      chains: [], // filled below: [{ chainId, positions, current, status }]
      crons: [], // cron recur rows pointed at this instance
    };
    instanceNode.set(id, node);
    nodes.push(node);
  }

  // --- watch rings (NOT nodes) ---------------------------------------------
  const TRIPPED = new Set(["terminated", "failed", "timeout", "retried", "escalated", "budget-exceeded"]);
  const rings = watches
    .filter((w) => instanceNode.has(w.instanceId))
    .map((w) => ({
      instanceId: w.instanceId,
      active: w.status !== "finalized",
      tripped: TRIPPED.has(w.outcome) || (w.attempts || 0) > 1,
      outcome: w.outcome || null,
      policy: w.policy || null,
    }));

  // --- chain hubs + ordered member edges -----------------------------------
  for (const c of chains) {
    const hubId = chainNodeId(c);
    nodes.push({
      id: hubId,
      kind: "chain",
      chainId: c.chainId,
      status: c.status,
      outcome: c.outcome || null,
      active: c.status !== "finalized",
      cursor: c.cursor,
      strategy: c.strategy,
      row: c,
      r: 12,
    });
    (c.workflows || []).forEach((m, i) => {
      const inst = instanceNode.get(m.instanceId);
      if (!inst) return;
      addLink({ source: hubId, target: m.instanceId, type: "chain", order: i, cursor: i === c.cursor });
      inst.chains.push({ chainId: c.chainId, position: i, kind: m.kind, current: i === c.cursor, status: c.status });
    });
  }

  // --- cron recur squares + dotted re-fire edge ----------------------------
  for (const c of crons) {
    const id = cronNodeId(c);
    nodes.push({
      id,
      kind: "cron",
      mode: "recur",
      active: c.status === "active",
      label: c.slug,
      fires: c.fires ?? 0,
      maxFires: c.budget?.maxFires ?? null,
      row: c,
      r: 11,
    });
    const target = c.currentInstanceId || c.instanceId;
    const inst = instanceNode.get(target);
    if (inst) {
      addLink({ source: id, target, type: "cron" });
      inst.crons.push(c);
    }
  }

  // --- cron discover squares + thin fired edges ----------------------------
  for (const d of discovers) {
    const id = discoverNodeId(d);
    nodes.push({
      id,
      kind: "discover",
      mode: "discover",
      active: d.status ? d.status === "active" : true,
      label: `${d.repo}#${d.label}`,
      fires: d.fires ?? null,
      maxFires: d.gates?.maxPerDay ?? null,
      row: d,
      r: 11,
    });
    for (const [iid, inst] of instanceNode) {
      if (iid.startsWith(DISCOVER_PREFIX)) {
        addLink({ source: id, target: iid, type: "discover" });
        void inst;
      }
    }
  }

  return { nodes, links, rings };
}
