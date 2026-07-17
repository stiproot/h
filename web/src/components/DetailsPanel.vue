<script setup>
import { ref, watch } from "vue";
import { fetchRunDetail, unwrapOption } from "../lib/api.js";
import { statusColor, agentColor } from "../lib/constants.js";

const props = defineProps({
  node: { type: Object, required: true }, // a buildGraph node
});
defineEmits(["close"]);

// Run details are fetched lazily, only when a run row is expanded, and cached
// per runId for the panel's lifetime.
const expanded = ref(new Set());
const details = ref({}); // runId → { loading, error, outputTail }

async function toggleRun(runId) {
  const next = new Set(expanded.value);
  if (next.has(runId)) {
    next.delete(runId);
    expanded.value = next;
    return;
  }
  next.add(runId);
  expanded.value = next;
  if (details.value[runId]) return;
  details.value = { ...details.value, [runId]: { loading: true } };
  try {
    const d = await fetchRunDetail(runId);
    const output = unwrapOption(d.output);
    const text = typeof output === "string" ? output : output == null ? "" : JSON.stringify(output, null, 2);
    details.value = {
      ...details.value,
      [runId]: { loading: false, outputTail: text.slice(-2000) || "(no output captured)" },
    };
  } catch (e) {
    details.value = { ...details.value, [runId]: { loading: false, error: String(e.message || e) } };
  }
}

// Selecting a different node resets the expansion state (cache kept).
watch(
  () => props.node?.id,
  () => {
    expanded.value = new Set();
  },
);

const fmtCost = (c) => (c == null ? "—" : `$${c.toFixed(4)}`);
const fmtDur = (ms) => (ms == null ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`);
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : "—");
const fmtMins = (ms) => (ms == null ? "—" : `${Math.round(ms / 60000)}m`);
</script>

<template>
  <aside class="panel">
    <header>
      <span class="kind">{{ node.kind }}</span>
      <code class="id">{{ node.id }}</code>
      <button class="close" title="close" @click="$emit('close')">×</button>
    </header>

    <!-- instance -->
    <template v-if="node.kind === 'instance'">
      <div class="row">
        <span class="dot" :style="{ background: statusColor(node.status) }" />
        <b>{{ node.status }}</b>
        <span v-if="node.costUsd" class="muted">· total {{ fmtCost(node.costUsd) }}</span>
      </div>

      <section v-if="node.watch">
        <h3>watch</h3>
        <div class="kv"><span>status</span><span>{{ node.watch.status }}<template v-if="node.watch.outcome"> ({{ node.watch.outcome }})</template></span></div>
        <div class="kv"><span>attempts</span><span>{{ node.watch.attempts }}</span></div>
        <div v-if="node.watch.policy?.maxDurationMs" class="kv"><span>budget</span><span>{{ fmtMins(node.watch.policy.maxDurationMs) }}</span></div>
        <div v-if="node.watch.policy?.retry" class="kv"><span>retry</span><span>max {{ node.watch.policy.retry.maxAttempts }}<template v-if="node.watch.policy.retry.fresh"> (fresh)</template></span></div>
        <div v-if="node.watch.costUsd != null" class="kv"><span>tallied cost</span><span>{{ fmtCost(node.watch.costUsd) }}</span></div>
      </section>

      <section v-if="node.chains.length">
        <h3>chains</h3>
        <div v-for="c in node.chains" :key="`${c.chainId}:${c.position}`" class="kv">
          <span>{{ c.chainId }}</span>
          <span>#{{ c.position }} {{ c.kind }}<b v-if="c.current"> ← cursor</b> <span class="muted">({{ c.status }})</span></span>
        </div>
      </section>

      <section v-if="node.crons.length">
        <h3>crons</h3>
        <div v-for="c in node.crons" :key="`${c.repo}:${c.slug}:${c.workflow}`" class="kv">
          <span>{{ c.slug }}/{{ c.workflow }}</span>
          <span>{{ c.status }} · {{ c.cadence }} · fires {{ c.fires }}<template v-if="c.budget?.maxFires">/{{ c.budget.maxFires }}</template></span>
        </div>
      </section>

      <section>
        <h3>runs ({{ node.runs.length }})</h3>
        <p v-if="!node.runs.length" class="muted">no ledger runs for this instance</p>
        <div v-for="r in node.runs" :key="r.runId" class="run">
          <button class="run-head" @click="toggleRun(r.runId)">
            <span class="dot" :style="{ background: agentColor(r.agentId) }" />
            <span class="agent">{{ r.agentId }}</span>
            <span class="muted">{{ r.model || "?" }}</span>
            <span class="muted right">{{ r.turns ?? "?" }}t · {{ fmtCost(r.costUsd) }} · {{ fmtDur(r.durationMs) }}</span>
            <span class="chev">{{ expanded.has(r.runId) ? "▾" : "▸" }}</span>
          </button>
          <div v-if="expanded.has(r.runId)" class="run-body">
            <div class="kv"><span>status</span><span>{{ r.status }}</span></div>
            <div class="kv"><span>started</span><span>{{ fmtTime(r.startedAt) }}</span></div>
            <div v-if="r.error" class="kv err"><span>error</span><span>{{ r.error }}</span></div>
            <p v-if="details[r.runId]?.loading" class="muted">loading output…</p>
            <p v-else-if="details[r.runId]?.error" class="err">{{ details[r.runId].error }}</p>
            <pre v-else-if="details[r.runId]" class="output">{{ details[r.runId].outputTail }}</pre>
          </div>
        </div>
      </section>
    </template>

    <!-- chain hub -->
    <template v-else-if="node.kind === 'chain'">
      <div class="row"><b>{{ node.status }}</b><span v-if="node.outcome" class="muted">· {{ node.outcome }}</span></div>
      <div class="kv"><span>strategy</span><span>{{ node.strategy }}</span></div>
      <div class="kv"><span>cursor</span><span>{{ node.cursor }}</span></div>
      <div v-if="node.row?.note" class="kv"><span>note</span><span>{{ node.row.note }}</span></div>
      <section>
        <h3>members</h3>
        <div v-for="(m, i) in node.row?.workflows || []" :key="i" class="kv">
          <span>#{{ i }}<b v-if="i === node.cursor"> ←</b></span>
          <span>{{ m.kind }} → <code>{{ m.instanceId }}</code></span>
        </div>
      </section>
    </template>

    <!-- cron / discover -->
    <template v-else>
      <div class="row"><b>{{ node.active ? "active" : "inactive" }}</b><span class="muted">· {{ node.mode }}</span></div>
      <div v-if="node.row?.cadence" class="kv"><span>cadence</span><span>{{ node.row.cadence }}</span></div>
      <div class="kv"><span>fires</span><span>{{ node.fires }}<template v-if="node.maxFires != null">/{{ node.maxFires }}</template></span></div>
      <div v-if="node.row?.lastRunAt" class="kv"><span>last fired</span><span>{{ fmtTime(node.row.lastRunAt) }}</span></div>
      <div v-if="node.row?.note" class="kv"><span>note</span><span>{{ node.row.note }}</span></div>
    </template>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 10px;
  right: 10px;
  bottom: 10px;
  width: 380px;
  overflow-y: auto;
  background: rgba(22, 27, 34, 0.97);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 12px 14px;
}
header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.kind {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted); border: 1px solid var(--panel-border);
  border-radius: 4px; padding: 1px 5px;
}
.id { font-size: 12px; word-break: break-all; flex: 1; color: var(--text); }
.close {
  background: none; border: none; color: var(--muted); font-size: 18px;
  cursor: pointer; line-height: 1; padding: 0 2px;
}
.close:hover { color: var(--text); }
.row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
.muted { color: var(--muted); }
.err { color: var(--failed); }
section { margin-top: 12px; }
h3 {
  margin: 0 0 6px; font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted); font-weight: 600;
}
.kv { display: flex; gap: 10px; padding: 2px 0; font-size: 12px; }
.kv > span:first-child { color: var(--muted); min-width: 84px; flex: none; }
.kv > span:last-child { word-break: break-word; }
.run { border-top: 1px solid var(--panel-border); }
.run-head {
  display: flex; align-items: center; gap: 7px; width: 100%;
  background: none; border: none; color: var(--text); font: inherit;
  font-size: 12px; padding: 6px 0; cursor: pointer; text-align: left;
}
.run-head:hover { color: #fff; }
.right { margin-left: auto; }
.chev { color: var(--muted); }
.agent { font-weight: 600; }
.run-body { padding: 2px 0 8px 16px; }
.output {
  background: #0b0e13; border: 1px solid var(--panel-border); border-radius: 6px;
  padding: 8px; font-size: 11px; white-space: pre-wrap; word-break: break-word;
  max-height: 320px; overflow-y: auto; color: #b9c2d0; margin: 6px 0 0;
}
</style>
