import type { WorkflowError } from "core";
import { Context, type Effect } from "effect";

/**
 * The discovery cron's enumeration port (docs/plans/impl/workflow-watcher-registry.md §9) — the outbound
 * boundary through which the pure-engine fan-out reads its SOURCE on the tick. Today the sole adapter
 * lists open GitHub issues (backed by git-core's `GitHubClient`, so the GitHub I/O stays in the core
 * package); the port is the seam so the domain stays free of any GitHub type and a future source (a
 * project board, a Linear query) slots in without touching the scan.
 *
 * The read is deliberately narrow — the engine only needs to dedup (`number`), order (oldest-first,
 * `createdAt`), and label a run (`title`). The adapter bounds the API cost; the SCAN bounds WHEN it is
 * called (only past the in-flight + cadence + daily-cap gates), so a busy tick never hammers the API.
 */

/** One discovered work item, source-agnostic (a GitHub issue today). */
export type SourceItem = {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
};

export interface SourceReaderService {
  /** OPEN items on `repo` carrying `label`, OLDEST-first. */
  readonly listOpenIssues: (opts: {
    repo: string;
    label: string;
  }) => Effect.Effect<readonly SourceItem[], WorkflowError>;
}

export class SourceReader extends Context.Tag("SourceReader")<
  SourceReader,
  SourceReaderService
>() {}
