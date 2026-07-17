<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import ForceGraph from "./components/ForceGraph.vue";
import DetailsPanel from "./components/DetailsPanel.vue";
import { sweepLists, sweepStatuses } from "./lib/api.js";
import { buildGraph, collectInstances } from "./lib/buildGraph.js";
import { isRunning, isDone, isFailed } from "./lib/constants.js";

// Poll a live instance's status only for the N most recently active instances —
// old terminal e2e artifacts stay grey rather than costing a request each sweep.
const STATUS_CAP = 30;
const SWEEP_MS = 5000;

const graph = ref(null);
const selectedId = ref(null);
const loaded = ref(false);
const errors = ref([]);
let timer = null;
let sweeping = false;

async function sweep() {
  if (sweeping) return; // never overlap sweeps on a slow backend
  sweeping = true;
  try {
    // Phase 1: every list surface + the run ledger.
    const rows = await sweepLists();
    // Phase 2: statuses of the most recently active instances (capped).
    const tracked = collectInstances(rows).slice(0, STATUS_CAP).map((i) => i.id);
    const statuses = await sweepStatuses(tracked);
    graph.value = buildGraph({ ...rows, statuses });
    errors.value = rows.errors;
    loaded.value = true;
  } catch (e) {
    errors.value = [String(e.message || e)];
  } finally {
    sweeping = false;
  }
}

onMounted(() => {
  sweep();
  timer = setInterval(sweep, SWEEP_MS);
});
onBeforeUnmount(() => clearInterval(timer));

const counts = computed(() => {
  const c = { running: 0, done: 0, failed: 0 };
  for (const n of graph.value?.nodes || []) {
    if (n.kind !== "instance") continue;
    if (isRunning(n.status)) c.running++;
    else if (isDone(n.status)) c.done++;
    else if (isFailed(n.status)) c.failed++;
  }
  return c;
});

const selectedNode = computed(
  () => graph.value?.nodes.find((n) => n.id === selectedId.value) || null,
);
</script>

<template>
  <div class="titlebar">
    <span class="title">h — runtime graph</span>
    <span class="counter">
      <i class="c running" />{{ counts.running }} running
      <i class="c done" />{{ counts.done }} done
      <i class="c failed" />{{ counts.failed }} failed
    </span>
    <span v-if="errors.length" class="err" :title="errors.join('\n')">
      {{ errors.length }} source{{ errors.length > 1 ? "s" : "" }} unreachable
    </span>
    <span v-else-if="!loaded" class="muted">loading…</span>
  </div>
  <div class="canvas">
    <ForceGraph
      v-if="graph"
      class="chart"
      :graph="graph"
      :selected-id="selectedId"
      @node-select="selectedId = $event"
    />
    <DetailsPanel v-if="selectedNode" :node="selectedNode" @close="selectedId = null" />
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--panel-border);
  background: var(--panel);
}
.title { font-weight: 600; letter-spacing: 0.02em; }
.counter { color: var(--muted); display: flex; align-items: center; gap: 6px; }
.c { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 8px; }
.c.running { background: var(--running); }
.c.done { background: var(--done); }
.c.failed { background: var(--failed); }
.err { color: var(--failed); }
.muted { color: var(--muted); }
/* Positioning context for the absolutely-placed DetailsPanel overlay. */
.canvas { position: relative; flex: 1; min-height: 0; display: flex; }
.chart { flex: 1; min-height: 0; }
</style>
