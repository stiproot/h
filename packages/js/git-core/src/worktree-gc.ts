/**
 * Collecting the worktrees h leaves behind.
 *
 * h cuts a worktree per run and removes none of them, so the shared workspace grows without
 * bound (one merged PR's worktree was found holding 803MB). This is the collector, and its shape
 * follows from WHY the naive one does not work: cleaning up when a run finishes collects exactly
 * the runs that finished, and the ones that leak worst are the ones that DIED. So collection is
 * by REACHABILITY-BY-AGE, run from outside any individual run's lifecycle, and it must survive
 * finding a workspace in any state at all.
 *
 * The safety rules are the operator command's (`h worktrees`, cli/h), deliberately identical and
 * machine-checked against it — a divergence would mean the unattended collector destroys
 * something the attended one refuses to touch. `git status --porcelain` lumps two very different
 * losses into one bit and the split is one character: a `??` line is a file git neither tracks
 * nor IGNORES (so `node_modules` never appears here) and costs a file nobody committed, while
 * every other line is an edit to tracked work. Unpushed COMMITS are a third question and always
 * block.
 */

import { Command, FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import { Effect } from "effect";

import { runGit } from "./git-exec.ts";

/**
 * What the collector may take. Every field narrows what it is allowed to destroy; none widens it.
 */
export type GcOptions = {
  /** The clone whose worktree admin is being collected (`git -C repoPath worktree …`). */
  repoPath: string;
  /**
   * Directory roots under which a worktree is h-managed and therefore collectable. A worktree
   * anywhere else belongs to somebody — most sharply, an operator's own — and is never touched.
   */
  roots: readonly string[];
  /**
   * How old a worktree must be before it may be collected. This is the LIVENESS PROXY, and it is
   * the reason the collector can run without asking anything about who is working: a supervised
   * run is bounded by its watch policy (45 minutes by default), so a worktree older than that
   * cannot belong to one. Default 24h leaves an order of magnitude of headroom, deliberately —
   * the directory's mtime does not move when an agent edits a file deep inside it, so a tight
   * threshold would be reading a stale clock and yanking a workspace out from under a live agent.
   */
  minAgeMs?: number;
  /**
   * Discard untracked files (the scratch class) rather than treating them as a reason to keep.
   * The collector's whole purpose in practice: an agent routinely leaves one plan doc behind, and
   * under a single dirty/clean bit that one file holds the entire worktree open forever.
   */
  pruneUntracked?: boolean;
  /**
   * Workspace keys never to collect whatever their age — at minimum the CALLER'S OWN, since the
   * collector runs as a workflow step inside a worktree of the very root it is sweeping.
   */
  keep?: readonly string[];
  /** Classify and report, change nothing. */
  dryRun?: boolean;
  /** Wall clock, injectable so tests need no sleeping. */
  now?: number;
};

/** One worktree (or husk) the collector looked at, and what it decided. */
export type GcEntry = {
  path: string;
  /** Absent for a husk — a directory git no longer has any record of. */
  branch?: string;
  outcome: "removed" | "kept";
  /** Why it was kept; absent when removed. */
  reason?: string;
  /** Untracked files found — the ones discarded when removed, listed so a surprise is visible. */
  untracked: readonly string[];
  /** Bytes the directory held. Absent when it could not be measured — never reported as 0. */
  bytes?: number;
};

export type GcReport = {
  removed: readonly GcEntry[];
  kept: readonly GcEntry[];
  /** Total of the `bytes` the collector could measure; absent if it measured none. */
  bytesReclaimed?: number;
};

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** A worktree as `git worktree list --porcelain` reports it. */
type Listed = { path: string; branch?: string };

/**
 * Parse `git worktree list --porcelain`, SKIPPING the first block. That block is the main working
 * tree — the shared pre-clone every worktree hangs off — and collecting it would take the whole
 * workspace with it.
 */
export const parseWorktrees = (porcelain: string): Listed[] => {
  const listed: Listed[] = [];
  let block = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      block += 1;
      if (block > 1) listed.push({ path: line.slice("worktree ".length).trim() });
    } else if (line.startsWith("branch ") && block > 1) {
      const last = listed[listed.length - 1];
      if (last !== undefined) last.branch = line.slice("branch refs/heads/".length).trim();
    }
  }
  return listed;
};

/** Uncommitted state, split by how much losing it costs. The sibling of the CLI's `Dirt`. */
export type Dirt = { tracked: boolean; untracked: readonly string[] };

/** Parse `git status --porcelain`: `??` is scratch, every other non-blank line is tracked work. */
export const parseDirt = (porcelain: string): Dirt => {
  let tracked = false;
  const untracked: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    // Display only — git quotes unusual paths, so these are never fed back to a command.
    if (line.startsWith("?? ")) untracked.push(line.slice(3).trim());
    else tracked = true;
  }
  return { tracked, untracked };
};

/**
 * Why this worktree must be kept, or undefined when it may be collected.
 *
 * Pure, and the single place the rules live: everything above is gathering, everything below is
 * removal. `--force` has NO counterpart here on purpose — an unattended collector is never given
 * the flag that discards committed work.
 */
export const gcDecision = (input: {
  ageMs: number;
  minAgeMs: number;
  dirt: Dirt;
  unpushed: boolean;
  pruneUntracked: boolean;
  kept: boolean;
}): string | undefined => {
  if (input.kept) return "live workspace";
  if (input.ageMs < input.minAgeMs) return `younger than ${Math.round(input.minAgeMs / 60000)}m`;
  if (input.dirt.tracked) return "uncommitted changes";
  if (input.unpushed) return "unpushed commits";
  if (input.dirt.untracked.length > 0 && !input.pruneUntracked) {
    return `${input.dirt.untracked.length} untracked file(s)`;
  }
  return undefined;
};

const under = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));

/**
 * Best-effort recursive size, via `du -sb`. Absent rather than 0 on any failure — a missing `du`
 * or an unreadable tree must report "not measured", never "reclaimed nothing"; the number exists
 * to tell an operator whether the collection was worth anything.
 */
const duBytes = (
  path: string,
): Effect.Effect<number | undefined, never, CommandExecutor.CommandExecutor> =>
  Command.make("du", "-sb", path).pipe(
    Command.string,
    Effect.map((out) => {
      const bytes = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
      return Number.isFinite(bytes) ? bytes : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Collect the h-managed worktrees under `roots` that hold nothing worth keeping.
 *
 * Two passes, and the second is the one that is easy to forget: git's own list, then the
 * DIRECTORY listing reconciled against it. A directory git has no record of — left by a removal
 * that failed halfway, or by a `worktree prune` that dropped the admin entry while the files
 * stayed — is invisible to every git command, so nothing else will ever collect it. It keeps its
 * full size.
 */
export const gcWorktreesEffect = (
  opts: GcOptions,
): Effect.Effect<GcReport, never, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
    const pruneUntracked = opts.pruneUntracked ?? false;
    const keep = new Set(opts.keep ?? []);
    const now = opts.now ?? Date.now();
    const roots = opts.roots;
    const removed: GcEntry[] = [];
    const kept: GcEntry[] = [];

    // Any git read failing is a reason to KEEP: the collector never destroys what it could not
    // classify. This mirrors the CLI's "any error → unsafe" default.
    const readOr = <A>(
      effect: Effect.Effect<A, unknown, CommandExecutor.CommandExecutor>,
      fallback: A,
    ) => effect.pipe(Effect.orElseSucceed(() => fallback));

    const measure = duBytes;

    const ageOf = (path: string): Effect.Effect<number> =>
      fs.stat(path).pipe(
        Effect.map((info) => {
          const mtime = info.mtime._tag === "Some" ? info.mtime.value.getTime() : undefined;
          // An unreadable mtime reads as age 0 — too young to collect, which is the safe side.
          return mtime === undefined ? 0 : Math.max(0, now - mtime);
        }),
        Effect.orElseSucceed(() => 0),
      );

    // Drop admin entries for directories removed out of band before listing, so the git view and
    // the directory view are compared at the same instant.
    yield* readOr(runGit(["-C", opts.repoPath, "worktree", "prune"]), "");
    const porcelain = yield* readOr(
      runGit(["-C", opts.repoPath, "worktree", "list", "--porcelain"]),
      "",
    );
    const listed = parseWorktrees(porcelain).filter((w) => under(w.path, roots));

    for (const worktree of listed) {
      const name = worktree.path.split("/").filter(Boolean).pop() ?? worktree.path;
      const dirt = parseDirt(
        yield* readOr(runGit(["-C", worktree.path, "status", "--porcelain"]), "?? <unreadable>"),
      );
      // `git log HEAD --not --remotes` is why "clean" is a stronger guarantee than it sounds: a
      // branch with no remote at all reports every commit, so a never-pushed worktree is kept and
      // anything collected is recoverable from some remote.
      const unpushed =
        (yield* readOr(
          runGit(["-C", worktree.path, "log", "HEAD", "--not", "--remotes", "--oneline"]),
          "unreadable",
        )).trim() !== "";
      const ageMs = yield* ageOf(worktree.path);
      const reason = gcDecision({
        ageMs,
        minAgeMs,
        dirt,
        unpushed,
        pruneUntracked,
        kept: keep.has(name) || (worktree.branch !== undefined && keep.has(worktree.branch)),
      });

      const entry: GcEntry = {
        path: worktree.path,
        ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
        outcome: reason === undefined ? "removed" : "kept",
        ...(reason === undefined ? {} : { reason }),
        untracked: dirt.untracked,
      };
      if (reason !== undefined) {
        kept.push(entry);
        continue;
      }
      const bytes = yield* measure(worktree.path);
      if (opts.dryRun === true) {
        removed.push({ ...entry, ...(bytes === undefined ? {} : { bytes }) });
        continue;
      }
      // git refuses to remove a worktree holding untracked files without its own --force, so a
      // prune-untracked collection must still hand git the flag. Nothing here passes --force for
      // tracked work: gcDecision already kept every such worktree.
      const args = ["-C", opts.repoPath, "worktree", "remove"];
      if (dirt.untracked.length > 0) args.push("--force");
      args.push(worktree.path);
      const failure = yield* runGit(args).pipe(
        Effect.as(undefined),
        Effect.orElseSucceed(() => "removal failed"),
      );
      if (failure !== undefined) {
        kept.push({ ...entry, outcome: "kept", reason: failure });
        continue;
      }
      if (worktree.branch !== undefined) {
        // -D, not -d: the unpushed check above is the data-safety gate, and git's own merge check
        // rejects a pushed branch whose PR is still open.
        yield* readOr(runGit(["-C", opts.repoPath, "branch", "-D", worktree.branch]), "");
      }
      removed.push({ ...entry, ...(bytes === undefined ? {} : { bytes }) });
    }

    // Pass two: directories git has no record of.
    const known = new Set(listed.map((w) => w.path));
    for (const root of roots) {
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const name of names) {
        const path = `${root}/${name}`;
        if (known.has(path) || keep.has(name)) continue;
        const isDir = yield* fs.stat(path).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (!isDir) continue;
        const ageMs = yield* ageOf(path);
        // A husk holds only files git never tracked, so it is collected under the same permission
        // as scratch — never silently, and never before the age threshold.
        if (ageMs < minAgeMs) {
          kept.push({ path, outcome: "kept", reason: "younger than threshold", untracked: [] });
          continue;
        }
        if (!pruneUntracked) {
          kept.push({ path, outcome: "kept", reason: "husk (untracked by git)", untracked: [] });
          continue;
        }
        const bytes = yield* measure(path);
        if (opts.dryRun !== true) {
          const failed = yield* fs.remove(path, { recursive: true }).pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          );
          if (failed) {
            kept.push({ path, outcome: "kept", reason: "removal failed", untracked: [] });
            continue;
          }
        }
        removed.push({
          path,
          outcome: "removed",
          untracked: [],
          ...(bytes === undefined ? {} : { bytes }),
        });
      }
    }

    const measured = removed.filter((e) => e.bytes !== undefined);
    return {
      removed,
      kept,
      // Absent, never 0, when nothing could be measured — the same honesty the cost tally keeps.
      ...(measured.length === 0
        ? {}
        : { bytesReclaimed: measured.reduce((sum, e) => sum + (e.bytes ?? 0), 0) }),
    };
  });
