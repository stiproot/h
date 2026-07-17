// `clusters` layout — same simulation, but forceX/forceY anchors pull nodes into
// status buckets: a triage view (everything alive sits in one visual bucket).
// Pure: node → cluster name, and viewport → anchor positions. No d3, no DOM.
import { isRunning, isDone, isFailed } from "../constants.js";

export const CLUSTER_ORDER = ["running", "done", "failed", "pending", "engines"];

// Engines (chain hubs + cron/discover squares) form their own cluster; instances
// bucket by status, with unpolled/pending instances in their own corner rather
// than polluting "done".
export function clusterOf(node) {
  if (node.kind !== "instance") return "engines";
  if (isRunning(node.status)) return "running";
  if (isDone(node.status)) return "done";
  if (isFailed(node.status)) return "failed";
  return "pending";
}

// Anchor positions in the svg's centered coordinate space ((0,0) = viewport
// middle). Four status corners, engines in the center where their edges reach
// every bucket without crossing the whole canvas.
export function clusterAnchors(width, height) {
  const dx = width * 0.3;
  const dy = height * 0.28;
  return {
    running: { x: -dx, y: -dy },
    done: { x: dx, y: -dy },
    failed: { x: dx, y: dy },
    pending: { x: -dx, y: dy },
    engines: { x: 0, y: 0 },
  };
}
