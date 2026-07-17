<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import * as d3 from "d3";
import { statusColor, agentColor, AGENT_COLORS } from "../lib/constants.js";
import { buildTimeline } from "../lib/layouts/timeline.js";

// Gantt view — no simulation: x = scaleTime over run start→end, one scaleBand
// lane per instance (newest first). Overlapping bars in a lane ARE the
// parallelism story. Updates flow through Vue reactivity, so a sweep just moves
// bars in place.
const props = defineProps({
  graph: { type: Object, default: null },
  selectedId: { type: String, default: null },
});
const emit = defineEmits(["node-select"]);

const wrap = ref(null);
const axisEl = ref(null);
const width = ref(1200);

const MARGIN = { top: 8, right: 24, bottom: 34, left: 240 };
const LANE_MIN_H = 30;
const SLOT_H = 13; // one sub-row per concurrent run

const tl = computed(() => buildTimeline(props.graph?.nodes || []));
const innerW = computed(() => Math.max(width.value - MARGIN.left - MARGIN.right, 100));

// Lanes grow with their concurrency: a lane with 3 parallel runs gets 3 sub-rows.
const laneMeta = computed(() => {
  const m = new Map();
  let y = 0;
  for (const lane of tl.value.lanes) {
    const h = Math.max(LANE_MIN_H, lane.slotCount * SLOT_H + 14);
    m.set(lane.id, { y, h, slotCount: lane.slotCount });
    y += h;
  }
  return { m, total: y };
});
const chartH = computed(() => laneMeta.value.total);
const svgH = computed(() => chartH.value + MARGIN.top + MARGIN.bottom);

const xScale = computed(() => {
  const [a, b] = tl.value.domain;
  const pad = Math.max((b - a) * 0.02, 1000);
  return d3.scaleTime().domain([new Date(a - pad), new Date(b + pad)]).range([0, innerW.value]);
});

const barX = (b) => xScale.value(b.start);
const barW = (b) => Math.max(xScale.value(b.end) - xScale.value(b.start), 3); // min 3px
const barY = (b, meta) => (meta.h - meta.slotCount * SLOT_H) / 2 + b.slot * SLOT_H + 1;
const shortId = (id) => (id.length > 30 ? `${id.slice(0, 29)}…` : id);
const fmtCost = (c) => (c == null ? "no cost" : `$${c.toFixed(4)}`);
const barTitle = (b) =>
  `${b.agentId} · ${b.model || "?"}\n${fmtCost(b.costUsd)} · ${b.turns ?? "?"} turns · ${b.status}${b.running ? " (running)" : ""}`;

// Light time axis at the bottom, re-rendered whenever the scale moves.
function renderAxis() {
  if (!axisEl.value) return;
  d3.select(axisEl.value)
    .call(d3.axisBottom(xScale.value).ticks(8).tickSizeOuter(0))
    .call((g) => g.selectAll("text").attr("fill", "#6f7889").style("font", "10px system-ui, sans-serif"))
    .call((g) => g.selectAll("line").attr("stroke", "#2c3444"))
    .call((g) => g.select(".domain").attr("stroke", "#2c3444"));
}
watch([xScale, chartH], () => renderAxis(), { flush: "post" });

let ro = null;
onMounted(() => {
  width.value = wrap.value?.clientWidth || 1200;
  ro = new ResizeObserver(() => {
    width.value = wrap.value?.clientWidth || width.value;
  });
  ro.observe(wrap.value);
  renderAxis();
});
onBeforeUnmount(() => ro && ro.disconnect());

const LEGEND_AGENTS = Object.entries(AGENT_COLORS).map(([id, color]) => ({
  id,
  color,
  label: id.replace("-agent", ""),
}));
</script>

<template>
  <div ref="wrap" class="timeline-wrap">
    <svg :width="width" :height="svgH">
      <g :transform="`translate(${MARGIN.left},${MARGIN.top})`">
        <!-- lane backgrounds + labels; g.node keeps snap.js's click selector working -->
        <g
          v-for="(lane, i) in tl.lanes"
          :key="lane.id"
          class="node lane"
          :transform="`translate(0,${laneMeta.m.get(lane.id).y})`"
          @click.stop="emit('node-select', lane.id)"
        >
          <rect
            class="lane-bg"
            :class="{ selected: lane.id === selectedId, alt: i % 2 === 1 }"
            :x="-MARGIN.left"
            :width="width - MARGIN.right"
            :height="laneMeta.m.get(lane.id).h"
          />
          <circle
            :cx="-MARGIN.left + 14"
            :cy="laneMeta.m.get(lane.id).h / 2"
            r="4.5"
            :fill="statusColor(lane.status)"
          />
          <text class="lane-label" :x="-MARGIN.left + 26" :y="laneMeta.m.get(lane.id).h / 2" dy="0.32em">
            {{ shortId(lane.id) }}
            <title>{{ lane.id }} — {{ lane.status }} · {{ lane.runCount }} run(s)</title>
          </text>
          <!-- one bar per agent run; concurrent runs stack into sub-rows, so
               overlapping time ranges are visible instead of occluding -->
          <rect
            v-for="b in tl.bars.filter((b) => b.laneId === lane.id)"
            :key="b.runId"
            class="bar"
            :class="{ running: b.running }"
            :x="barX(b)"
            :y="barY(b, laneMeta.m.get(lane.id))"
            :width="barW(b)"
            :height="SLOT_H - 3"
            rx="2"
            :fill="agentColor(b.agentId)"
          >
            <title>{{ barTitle(b) }}</title>
          </rect>
        </g>
        <g ref="axisEl" class="axis" :transform="`translate(0,${chartH + 6})`" />
      </g>
    </svg>

    <!-- timeline-specific legend -->
    <div class="legend">
      <div class="legend-row"><span class="lane-glyph" /><span class="legend-label">lane = workflow instance (dot = its status; newest on top)</span></div>
      <div v-for="a in LEGEND_AGENTS" :key="a.id" class="legend-row">
        <span class="bar-glyph" :style="{ background: a.color }" />
        <span class="legend-label">run bar — {{ a.label }} (x = start → end)</span>
      </div>
      <div class="legend-row"><span class="bar-glyph overlap" /><span class="legend-label">overlapping bars = parallel runs</span></div>
    </div>
  </div>
</template>

<style scoped>
.timeline-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-top: 46px; /* clears the legend */
}
.lane { cursor: pointer; }
.lane-bg { fill: transparent; }
.lane-bg.alt { fill: rgba(139, 147, 167, 0.04); }
.lane:hover .lane-bg { fill: rgba(139, 147, 167, 0.09); }
.lane-bg.selected { fill: rgba(96, 165, 250, 0.1); }
.lane-label {
  font: 11px system-ui, sans-serif;
  fill: #aeb6c6;
  user-select: none;
}
.bar { stroke: #0e1116; stroke-width: 1; opacity: 0.92; }
.bar.running { animation: t-pulse 1.4s ease-in-out infinite; }
@keyframes t-pulse {
  0%, 100% { opacity: 0.95; }
  50% { opacity: 0.45; }
}

.legend {
  position: absolute;
  top: 8px;
  left: 12px;
  display: flex;
  gap: 18px;
  align-items: center;
  background: rgba(22, 27, 34, 0.92);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 6px 10px;
  pointer-events: none;
}
.legend-row { display: flex; align-items: center; gap: 6px; }
.legend-label { font-size: 10.5px; color: var(--muted); }
.bar-glyph { width: 18px; height: 9px; border-radius: 2px; display: inline-block; }
.bar-glyph.overlap {
  background: linear-gradient(90deg, #f97316 0 60%, transparent 60%),
    linear-gradient(90deg, transparent 0 40%, #14b8a6 40%);
  height: 12px;
}
.lane-glyph {
  width: 18px; height: 9px; display: inline-block;
  border: 1px solid var(--muted); border-radius: 2px;
}
</style>
