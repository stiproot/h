// All fetch calls live here. Same-origin paths — the Vite dev proxy (and the
// compose nginx sibling) route /svc/* → workflow-svc:8003, /obs/* → obs-mcp:8013.

const j = async (res) => {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`);
  return res.json();
};

export const fetchSaved = () => fetch("/svc/workflow/list").then(j); // { keys: [] }
export const fetchWatches = () => fetch("/svc/watch/list").then(j); // { heartbeat, watches: [] }
export const fetchChains = () => fetch("/svc/chain/list").then(j); // { heartbeat, chains: [] }
export const fetchCrons = () => fetch("/svc/cron/list").then(j); // { heartbeat, crons: [], discover: [] }
export const fetchRuns = (limit = 50) => fetch(`/obs/api/runs?limit=${limit}`).then(j); // [runSummary]
export const fetchStatus = (id) =>
  fetch(`/svc/workflow/status/${encodeURIComponent(id)}`).then(j); // { instanceId, runtimeStatus, output? }
export const fetchRunDetail = (runId) =>
  fetch(`/obs/api/run/${encodeURIComponent(runId)}`).then(j); // { summary, output, events }

// obs-mcp serializes Effect Options as {_id:"Option", _tag:"Some"|"None", value?}.
// Unwrap defensively — plain values pass through untouched.
export const unwrapOption = (v) => {
  if (v && typeof v === "object" && v._id === "Option") return v._tag === "Some" ? v.value : null;
  return v ?? null;
};

// One poll sweep of every list surface. allSettled so one dead service dims its
// slice instead of blanking the whole graph; `errors` reports what failed.
export async function sweepLists() {
  const [watches, chains, crons, runs] = await Promise.allSettled([
    fetchWatches(),
    fetchChains(),
    fetchCrons(),
    fetchRuns(50),
  ]);
  const val = (r, fallback) => (r.status === "fulfilled" ? r.value : fallback);
  const errors = [
    ["watch", watches],
    ["chain", chains],
    ["cron", crons],
    ["runs", runs],
  ]
    .filter(([, r]) => r.status === "rejected")
    .map(([name, r]) => `${name}: ${r.reason?.message || r.reason}`);
  const cronBody = val(crons, { crons: [], discover: [] });
  return {
    watches: val(watches, { watches: [] }).watches || [],
    chains: val(chains, { chains: [] }).chains || [],
    crons: cronBody.crons || [],
    discovers: cronBody.discover || [],
    runs: val(runs, []),
    errors,
  };
}

// Statuses for the tracked instances (capped upstream at the 30 most recent).
// A failed status read leaves that instance UNKNOWN rather than failing the sweep.
export async function sweepStatuses(ids) {
  const results = await Promise.allSettled(ids.map((id) => fetchStatus(id)));
  const statuses = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value?.runtimeStatus) statuses[ids[i]] = r.value.runtimeStatus;
  });
  return statuses;
}
