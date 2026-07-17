<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import * as d3 from "d3";
import {
  statusColor, isRunning, agentColor, edgeStyle, LEGEND,
  CHAIN_COLOR, CHAIN_ACTIVE_COLOR, CRON_COLOR, CRON_ACTIVE_COLOR,
  RING_WATCHING, RING_TRIPPED,
} from "../lib/constants.js";

const props = defineProps({
  graph: { type: Object, default: null }, // { nodes, links, rings } from buildGraph
  selectedId: { type: String, default: null },
});
const emit = defineEmits(["node-select"]);

const container = ref(null);

// The svg skeleton is built once; every sweep DIFFS into it. The simulation is
// reheated only when the topology (node/link id sets) changes — a pure state
// change (color, size, ring) mutates attributes in place, no relayout.
let svg, view, linkLayer, nodeLayer;
let simulation, linkForce;
let nodes = [], links = [];
let topoKey = null;
let nodeSel = d3.select(null), linkSel = d3.select(null);

function drag(sim) {
  return d3
    .drag()
    .on("start", (event, d) => {
      if (!event.active) sim.alphaTarget(0.15).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

const linkKey = (l) => `${l.type}:${l.source.id ?? l.source}>${l.target.id ?? l.target}`;
const shortId = (id) => (id.length > 26 ? `${id.slice(0, 25)}…` : id);
const fmtCost = (c) => (c ? `$${c.toFixed(c < 0.1 ? 3 : 2)}` : "");

function nodeTitle(d) {
  if (d.kind === "instance") {
    const lines = [`${d.id} — ${d.status}`];
    if (d.costUsd) lines.push(`cost ${fmtCost(d.costUsd)} across ${d.runs.length} run(s)`);
    if (d.watch) lines.push(`watched (${d.watch.status}${d.watch.outcome ? `: ${d.watch.outcome}` : ""})`);
    for (const c of d.chains) lines.push(`chain ${c.chainId} [${c.position}]${c.current ? " ← cursor" : ""}`);
    return lines.join("\n");
  }
  if (d.kind === "chain") return `chain ${d.chainId} — ${d.status}${d.outcome ? ` (${d.outcome})` : ""}`;
  return `cron ${d.label} — ${d.active ? "active" : "inactive"}${d.maxFires != null ? ` · fires ${d.fires}/${d.maxFires}` : ""}`;
}

function subLabel(d) {
  if (d.kind === "instance") return fmtCost(d.costUsd);
  if (d.kind === "chain") return d.strategy || "";
  return d.maxFires != null ? `${d.fires}/${d.maxFires}` : "";
}

function ensureSvg() {
  const el = container.value;
  const width = el.clientWidth || 928;
  const height = el.clientHeight || 600;

  svg = d3
    .create("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [-width / 2, -height / 2, width, height]);

  view = svg.append("g");
  linkLayer = view.append("g");
  nodeLayer = view.append("g");

  svg.call(
    d3
      .zoom()
      .scaleExtent([0.05, 8])
      .filter((event) => event.type === "wheel" || event.target === svg.node())
      .on("zoom", (event) => view.attr("transform", event.transform)),
  );
  // Clicking empty canvas clears the selection.
  svg.on("click", () => emit("node-select", null));

  linkForce = d3
    .forceLink([])
    .id((d) => d.id)
    .distance((l) => (l.type === "chain" ? 110 : 130))
    .strength(0.2);
  simulation = d3
    .forceSimulation([])
    .velocityDecay(0.6)
    .force("link", linkForce)
    .force("charge", d3.forceManyBody().strength(-380).distanceMax(900))
    .force("collide", d3.forceCollide().radius((d) => d.r + 26).strength(0.9))
    .force("x", d3.forceX().strength(0.03))
    .force("y", d3.forceY().strength(0.03));

  simulation.on("tick", () => {
    linkSel
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  el.replaceChildren(svg.node());
}

// Merge the fresh buildGraph output into the live sim arrays, preserving object
// identity (and so x/y/velocity) for nodes that survive the diff.
function update() {
  const g = props.graph;
  if (!g || !svg) return;

  const prev = new Map(nodes.map((n) => [n.id, n]));
  nodes = g.nodes.map((n) => {
    const old = prev.get(n.id);
    if (old) return Object.assign(old, n); // buildGraph nodes carry no x/y — sim state survives
    return { ...n };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  links = g.links
    .filter((l) => byId.has(l.source) && byId.has(l.target))
    .map((l) => ({ ...l, source: byId.get(l.source), target: byId.get(l.target) }));

  // Rings index for quick lookup during the visual refresh.
  const ringByInstance = new Map((g.rings || []).map((r) => [r.instanceId, r]));
  for (const n of nodes) n.ring = n.kind === "instance" ? ringByInstance.get(n.id) || null : null;

  // Seed new nodes near a linked, already-placed neighbour so they don't streak
  // in from the origin.
  for (const n of nodes) {
    if (n.x !== undefined) continue;
    const l = links.find(
      (e) => (e.source === n && e.target.x !== undefined) || (e.target === n && e.source.x !== undefined),
    );
    if (l) {
      const o = l.source === n ? l.target : l.source;
      n.x = o.x + (Math.random() - 0.5) * 60;
      n.y = o.y + (Math.random() - 0.5) * 60;
    }
  }

  const key =
    nodes.map((n) => n.id).sort().join("|") + "||" + links.map(linkKey).sort().join("|");
  const topoChanged = key !== topoKey;
  topoKey = key;

  // --- links ---------------------------------------------------------------
  linkSel = linkLayer
    .selectAll("line")
    .data(links, linkKey)
    .join("line")
    .attr("stroke", (d) => edgeStyle(d).color)
    .attr("stroke-width", (d) => edgeStyle(d).width)
    .attr("stroke-dasharray", (d) => edgeStyle(d).dash)
    .attr("stroke-opacity", (d) => (d.type === "discover" ? 0.5 : 0.75));

  // --- nodes ---------------------------------------------------------------
  nodeSel = nodeLayer
    .selectAll("g.node")
    .data(nodes, (d) => d.id)
    .join(
      (enter) => {
        const gs = enter
          .append("g")
          .attr("class", "node")
          .style("cursor", "pointer")
          .on("click", (event, d) => {
            event.stopPropagation();
            emit("node-select", d.id);
          })
          .call(drag(simulation));
        gs.each(function (d) {
          const s = d3.select(this);
          if (d.kind === "instance") {
            s.append("circle").attr("class", "ring");
            s.append("circle").attr("class", "halo");
            s.append("circle").attr("class", "shape");
            s.append("g").attr("class", "sats");
          } else if (d.kind === "chain") {
            s.append("rect").attr("class", "shape").attr("transform", "rotate(45)");
          } else {
            s.append("rect").attr("class", "shape").attr("rx", 2);
            s.append("text")
              .attr("class", "glyph")
              .attr("text-anchor", "middle")
              .attr("dy", "0.36em")
              .text("⏱");
          }
        });
        gs.append("title");
        gs.append("text").attr("class", "label").attr("text-anchor", "middle");
        gs.append("text").attr("class", "sub").attr("text-anchor", "middle");
        return gs;
      },
      (u) => u,
      (exit) => exit.remove(),
    );

  refreshVisuals();

  if (topoChanged) {
    simulation.nodes(nodes);
    linkForce.links(links);
    simulation.alpha(0.5).restart();
  }
}

// State-only refresh: fills, radii, rings, satellites, labels — no relayout.
function refreshVisuals() {
  nodeSel.select("title").text(nodeTitle);
  nodeSel
    .select("text.label")
    .attr("y", (d) => d.r + 13)
    .text((d) => shortId(d.kind === "instance" ? d.id : d.label || d.chainId || d.id));
  nodeSel
    .select("text.sub")
    .attr("y", (d) => d.r + 25)
    .text(subLabel);

  const selected = props.selectedId;

  // Instances: status fill, cost radius, running halo, watch ring, satellites.
  const inst = nodeSel.filter((d) => d.kind === "instance");
  inst
    .select("circle.shape")
    .attr("r", (d) => d.r)
    .attr("fill", (d) => statusColor(d.status))
    .attr("stroke", (d) => (d.id === selected ? "#fff" : "#0e1116"))
    .attr("stroke-width", (d) => (d.id === selected ? 2.5 : 1.5));
  inst
    .select("circle.halo")
    .attr("r", (d) => d.r)
    .attr("fill", "none")
    .attr("stroke", (d) => statusColor(d.status))
    .attr("stroke-width", 2)
    .attr("display", (d) => (isRunning(d.status) ? null : "none"));
  inst
    .select("circle.ring")
    .attr("r", (d) => d.r + 5)
    .attr("fill", "none")
    .attr("stroke", (d) => (d.ring?.tripped ? RING_TRIPPED : RING_WATCHING))
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", "5 4")
    .attr("opacity", (d) => (d.ring?.active ? 1 : 0.55))
    .attr("display", (d) => (d.ring ? null : "none"));
  inst.each(function (d) {
    const n = Math.max(d.runs.length, 1);
    d3.select(this)
      .select("g.sats")
      .selectAll("circle")
      .data(d.runs, (r) => r.runId)
      .join((enter) => enter.append("circle").call((c) => c.append("title")))
      .attr("r", 3.5)
      .attr("fill", (r) => agentColor(r.agentId))
      .attr("stroke", "#0e1116")
      .attr("stroke-width", 1)
      .attr("cx", (r, i) => (d.r + 9) * Math.cos((i / Math.max(n, 6)) * 2 * Math.PI - Math.PI / 2))
      .attr("cy", (r, i) => (d.r + 9) * Math.sin((i / Math.max(n, 6)) * 2 * Math.PI - Math.PI / 2))
      .select("title")
      .text(
        (r) =>
          `${r.agentId} · ${r.model || "?"}\n${fmtCost(r.costUsd) || "no cost"} · ${r.turns ?? "?"} turns · ${r.status}`,
      );
  });

  // Chain hubs: diamond, brighter while sequencing.
  nodeSel
    .filter((d) => d.kind === "chain")
    .select("rect.shape")
    .attr("x", (d) => -d.r * 0.78)
    .attr("y", (d) => -d.r * 0.78)
    .attr("width", (d) => d.r * 1.56)
    .attr("height", (d) => d.r * 1.56)
    .attr("fill", (d) => (d.active ? CHAIN_ACTIVE_COLOR : CHAIN_COLOR))
    .attr("stroke", (d) => (d.id === selected ? "#fff" : "#0e1116"))
    .attr("stroke-width", (d) => (d.id === selected ? 2.5 : 1.5));

  // Cron squares (recur + discover): clock glyph, amber while armed.
  const cron = nodeSel.filter((d) => d.kind === "cron" || d.kind === "discover");
  cron
    .select("rect.shape")
    .attr("x", (d) => -d.r)
    .attr("y", (d) => -d.r)
    .attr("width", (d) => d.r * 2)
    .attr("height", (d) => d.r * 2)
    .attr("fill", (d) => (d.active ? CRON_ACTIVE_COLOR : CRON_COLOR))
    .attr("stroke", (d) => (d.id === selected ? "#fff" : "#0e1116"))
    .attr("stroke-width", (d) => (d.id === selected ? 2.5 : 1.5));
  cron.select("text.glyph").attr("fill", (d) => (d.active ? "#1c1917" : "#cbd5e1"));
}

onMounted(() => {
  ensureSvg();
  update();
});
watch(() => props.graph, update);
watch(() => props.selectedId, refreshVisuals);
onBeforeUnmount(() => simulation && simulation.stop());
</script>

<template>
  <div class="wrap">
    <div ref="container" class="force-graph"></div>
    <div class="legend">
      <div v-for="row in LEGEND" :key="row.label" class="legend-row">
        <span class="swatch">
          <span v-if="row.kind === 'circle'" class="sw-circle" :class="{ pulse: row.pulse }" :style="{ background: row.color }" />
          <span v-else-if="row.kind === 'ring'" class="sw-ring" :style="{ borderColor: row.color }" />
          <span v-else-if="row.kind === 'diamond'" class="sw-diamond" :style="{ background: row.color }" />
          <span v-else-if="row.kind === 'square'" class="sw-square" :style="{ background: row.color }">⏱</span>
          <span v-else-if="row.kind === 'dot'" class="sw-dot" :style="{ background: row.color }" />
          <span v-else-if="row.kind === 'size'" class="sw-size"><i /><i /></span>
          <svg v-else-if="row.kind === 'edge'" width="26" height="6">
            <line x1="0" y1="3" x2="26" y2="3" :stroke="row.style.color" :stroke-width="row.style.width" :stroke-dasharray="row.style.dash || null" />
          </svg>
        </span>
        <span class="legend-label">{{ row.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; }
.force-graph { width: 100%; height: 100%; }
.force-graph :deep(svg) { width: 100%; height: 100%; display: block; }

.force-graph :deep(text.label) {
  font: 10px system-ui, sans-serif;
  fill: #aeb6c6;
  pointer-events: none;
  user-select: none;
  paint-order: stroke;
  stroke: #0e1116;
  stroke-width: 3px;
  stroke-linejoin: round;
}
.force-graph :deep(text.sub) {
  font: 9px system-ui, sans-serif;
  fill: #6f7889;
  pointer-events: none;
  user-select: none;
  paint-order: stroke;
  stroke: #0e1116;
  stroke-width: 3px;
  stroke-linejoin: round;
}
.force-graph :deep(text.glyph) {
  font: 11px system-ui, sans-serif;
  pointer-events: none;
  user-select: none;
}

/* Running instances pulse: an expanding, fading halo around the circle. */
.force-graph :deep(circle.halo) {
  transform-box: fill-box;
  transform-origin: center;
  animation: h-pulse 1.6s ease-out infinite;
  pointer-events: none;
}
@keyframes h-pulse {
  0% { opacity: 0.7; transform: scale(1); }
  100% { opacity: 0; transform: scale(2); }
}

/* Legend — fixed to the top-left, never pans or zooms. */
.legend {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(22, 27, 34, 0.92);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
}
.legend-row { display: flex; align-items: center; gap: 8px; }
.legend-label { font-size: 10.5px; color: var(--muted); }
.swatch { width: 28px; display: inline-flex; justify-content: center; align-items: center; }
.sw-circle { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.sw-circle.pulse { animation: h-pulse-legend 1.6s ease-out infinite; }
@keyframes h-pulse-legend {
  0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.6); }
  50% { box-shadow: 0 0 0 5px rgba(59, 130, 246, 0); }
}
.sw-ring { width: 12px; height: 12px; border-radius: 50%; border: 2px dashed; display: inline-block; }
.sw-diamond { width: 10px; height: 10px; transform: rotate(45deg); display: inline-block; }
.sw-square {
  width: 14px; height: 14px; border-radius: 2px; display: inline-flex;
  align-items: center; justify-content: center; font-size: 9px; color: #1c1917;
}
.sw-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.sw-size { display: inline-flex; align-items: center; gap: 3px; }
.sw-size i { background: #6b7280; border-radius: 50%; display: inline-block; }
.sw-size i:first-child { width: 6px; height: 6px; }
.sw-size i:last-child { width: 13px; height: 13px; }
</style>
