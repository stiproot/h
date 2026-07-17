// Visual vocabulary for the runtime graph. Every encoding here appears in the
// legend — if you add a shape/color/dash, add its legend row too.

// Dapr runtime statuses → node fill. Anything unrecognized reads as pending.
export const STATUS_COLORS = {
  RUNNING: "#3b82f6",
  COMPLETED: "#22c55e",
  FAILED: "#ef4444",
  TERMINATED: "#ef4444",
  PENDING: "#6b7280",
  SCHEDULED: "#6b7280",
  SUSPENDED: "#6b7280",
  UNKNOWN: "#6b7280",
};
export const statusColor = (s) => STATUS_COLORS[s] || STATUS_COLORS.UNKNOWN;
export const isRunning = (s) => s === "RUNNING";
export const isFailed = (s) => s === "FAILED" || s === "TERMINATED";
export const isDone = (s) => s === "COMPLETED";

// Agent satellites, one dot per ledger run around its instance node.
export const AGENT_COLORS = {
  "claude-agent": "#f97316", // orange
  "openhands-agent": "#14b8a6", // teal
  "pi-agent": "#a855f7", // purple
};
export const agentColor = (agentId) => AGENT_COLORS[agentId] || "#8b93a7";

// Engine-node fills (chain hub / cron squares) — muted so instance state pops.
export const CHAIN_COLOR = "#64748b";
export const CHAIN_ACTIVE_COLOR = "#93c5fd";
export const CRON_COLOR = "#475569";
export const CRON_ACTIVE_COLOR = "#eab308";

// Watch ring: amber while watching, red once the engine terminated/retried.
export const RING_WATCHING = "#f59e0b";
export const RING_TRIPPED = "#ef4444";

// Edge styles per link type.
export const EDGE_STYLES = {
  chain: { color: "#8b93a7", dash: null, width: 1.5 },
  "chain-cursor": { color: "#60a5fa", dash: null, width: 2.5 },
  cron: { color: "#a1a1aa", dash: "2 4", width: 1.5 },
  discover: { color: "#52525b", dash: null, width: 0.75 },
};
export const edgeStyle = (l) =>
  l.type === "chain" && l.cursor ? EDGE_STYLES["chain-cursor"] : EDGE_STYLES[l.type] || EDGE_STYLES.chain;

// Node radius ∝ sqrt(total run cost): expensive runs are literally bigger.
export const R_MIN = 6;
export const R_MAX = 22;
export const radiusForCost = (costUsd) =>
  Math.max(R_MIN, Math.min(R_MAX, R_MIN + Math.sqrt(Math.max(costUsd || 0, 0)) * 16));

// Legend rows (linear-graph style): one row per encoding.
export const LEGEND = [
  { kind: "circle", color: STATUS_COLORS.PENDING, label: "instance — pending / unknown" },
  { kind: "circle", color: STATUS_COLORS.RUNNING, pulse: true, label: "instance — running (pulses)" },
  { kind: "circle", color: STATUS_COLORS.COMPLETED, label: "instance — completed" },
  { kind: "circle", color: STATUS_COLORS.FAILED, label: "instance — failed / terminated" },
  { kind: "size", label: "circle size ∝ total run cost" },
  { kind: "ring", color: RING_WATCHING, label: "watch ring — supervised" },
  { kind: "ring", color: RING_TRIPPED, label: "watch ring — terminated / retried" },
  { kind: "diamond", color: CHAIN_COLOR, label: "chain hub (sequences members)" },
  { kind: "square", color: CRON_ACTIVE_COLOR, label: "cron ⏱ — recur / discover" },
  { kind: "edge", style: EDGE_STYLES.chain, label: "chain member (order)" },
  { kind: "edge", style: EDGE_STYLES["chain-cursor"], label: "chain cursor (current member)" },
  { kind: "edge", style: EDGE_STYLES.cron, label: "cron re-fires (dotted)" },
  { kind: "edge", style: EDGE_STYLES.discover, label: "discover fired (thin)" },
  { kind: "dot", color: AGENT_COLORS["claude-agent"], label: "run — claude" },
  { kind: "dot", color: AGENT_COLORS["openhands-agent"], label: "run — openhands" },
  { kind: "dot", color: AGENT_COLORS["pi-agent"], label: "run — pi" },
];
