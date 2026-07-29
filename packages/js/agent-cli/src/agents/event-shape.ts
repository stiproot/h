/**
 * Per-agent event-stream shape — OBSERVED, not assumed.
 *
 * Each CLI streams a different event vocabulary: the claude CLI emits
 * `{type:"assistant", message:{content:[{type:"tool_use"},…]}}`, while openhands emits JSONL
 * whose `kind` is `ActionEvent` / `ObservationEvent` / `ConversationErrorEvent`. A single tally
 * written against one CLI's shape silently reports 0 for every other agent — and a 0 reads as a
 * MEASURED zero, not as "this agent's stream was never understood".
 *
 * That is not hypothetical: on 2026-07-27 an openhands run that made real tool calls was read as
 * `toolCalls: 0` and nearly recorded as a "hollow panelist" (the very signal docs/DRIVER.md
 * recommends for spotting one). The lesson encoded here:
 *
 *   1. ALWAYS log what an agent's stream actually looked like (`EventShape`) — raw data, so a
 *      real reader can be written from evidence instead of guesswork.
 *   2. The reader itself lives on the STRATEGY (`AgentStrategy.tallyToolCalls`, beside
 *      `streamParser`), because only the strategy knows its CLI's vocabulary. This module just
 *      resolves it — it holds no per-agent knowledge of its own.
 */

import { claudeStrategy } from "./claude.ts";
import { codexStrategy } from "./codex.ts";
import { openhandsStrategy } from "./openhands.ts";
import { piStrategy } from "./pi.ts";
import type { AgentStrategy, AgentType } from "./types.ts";

/** A run's observed event vocabulary — cardinality-bounded so a long run cannot bloat it. */
export interface EventShape {
  /** Total events seen. */
  total: number;
  /** Histogram of the `type` field's observed values (`"(absent)"` when an event has none). */
  byType: Record<string, number>;
  /** Histogram of top-level key signatures, e.g. `"text,type"`. */
  byKeys: Record<string, number>;
}

/** Distinct values tracked per histogram before further ones collapse into `"(other)"`. */
const MAX_KEYS = 24;

export const emptyEventShape = (): EventShape => ({ total: 0, byType: {}, byKeys: {} });

function bump(hist: Record<string, number>, key: string): void {
  if (hist[key] === undefined && Object.keys(hist).length >= MAX_KEYS) {
    hist["(other)"] = (hist["(other)"] ?? 0) + 1;
    return;
  }
  hist[key] = (hist[key] ?? 0) + 1;
}

/**
 * Fold one event into the shape. Agent-agnostic BY DESIGN — it records what arrived without
 * interpreting it, which is exactly what makes it trustworthy for an agent whose vocabulary
 * nothing here reads yet. Mutates and returns `shape` (hot path, one run).
 */
export function observeEvent(shape: EventShape, event: Record<string, unknown>): EventShape {
  shape.total += 1;
  const type = (event as { type?: unknown }).type;
  bump(shape.byType, typeof type === "string" ? type : "(absent)");
  bump(shape.byKeys, Object.keys(event).toSorted().join(",") || "(empty)");
  return shape;
}

/** Folds one event into a running tool-call count. */
export type ToolCallTally = (current: number, event: Record<string, unknown>) => number;

const STRATEGIES: Record<AgentType, AgentStrategy> = {
  claude: claudeStrategy,
  codex: codexStrategy,
  openhands: openhandsStrategy,
  pi: piStrategy,
};

/**
 * The tool-call tally an agent implements for its OWN stream, or `undefined` when that strategy
 * has not verified its shape yet — the caller then records `null` (unknown), never 0.
 *
 * All four strategies now implement one, each read off the stream the LEDGER actually receives:
 * claude's nested `tool_use` content blocks; openhands' `ActionEvent`; pi's `tool_execution_*`
 * lines; codex's `item.completed` + `function_call`/`mcp_tool_call`. Note the three non-claude
 * CLIs hand the ledger a raw `{type:"output", text:<json>}` line and push their normalised
 * `tool_use` only into the INTERNAL events array — so a tally reading `type === "tool_use"`
 * sees nothing. That mismatch is exactly what made one shared claude-shaped tally report a
 * confident 0 for openhands and a fictional count for pi.
 *
 * Adding one for a NEW agent belongs on its strategy (beside its `streamParser`), written from
 * that strategy's own parser and the `eventShape` captured on real runs. Never from assumption.
 */
export function toolCallTallyFor(agent: AgentType): ToolCallTally | undefined {
  const strategy = STRATEGIES[agent];
  return strategy.tallyToolCalls ? strategy.tallyToolCalls.bind(strategy) : undefined;
}
