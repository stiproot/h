import { cp, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import { Data, Effect } from "effect";

/**
 * Seeding a fresh worktree with the files git does not carry.
 *
 * A worktree checks out exactly what is committed, so the gitignored files a repo needs to
 * RUN — `.env` beside a service, a local config — are absent in every one, and an agent handed
 * such a worktree either fails its acceptance gate on a missing secret or, worse, goes looking
 * for the file elsewhere on the operator's disk. Night 1 of the trxy campaign (2026-09-01) had
 * the driver copy `apps/mcp-trxy/.env` into nine worktrees by hand, and the runbook line saying
 * to do so was the only thing holding it; this makes it a declared, repo-owned fact
 * (`worktree.seed` in the consumer chart's values) applied by the same create-worktree step on
 * both substrates.
 *
 * The rules are what keep it safe to run unattended:
 * - a path is RELATIVE and stays inside both trees — `..`, an absolute path, or a normalized
 *   escape is refused outright (a config error, never a partial copy);
 * - an existing destination is KEPT, never overwritten — which is also what makes the step
 *   idempotent and confines it to gitignored files (a tracked file is always already there);
 * - a missing source is REPORTED, not fatal — a seed list describes what the repo can need,
 *   and a clone that lacks one optional file should still run.
 */
export type SeedOptions = {
  /** The clone the files are copied FROM (the same `repoPath` the worktree was cut from). */
  repoPath: string;
  /** The worktree the files are copied INTO. */
  worktreePath: string;
  /** Repo-relative paths — files or directories — to copy when absent in the worktree. */
  paths: ReadonlyArray<string>;
};

export type SeedReport = {
  /** Copied from the clone into the worktree. */
  copied: string[];
  /** Already present in the worktree; left as-is. */
  kept: string[];
  /** Absent in the clone; nothing to copy. */
  missing: string[];
};

/** A seed path that could reach outside the clone or the worktree. Refused before any copy. */
export class SeedPathError extends Data.TaggedError("SeedPathError")<{
  readonly path: string;
}> {
  override get message(): string {
    return `seed path '${this.path}' must be relative and stay inside the repository`;
  }
}

/** The relative path, normalized, or undefined when it escapes. Pure, so it is testable alone. */
export const safeSeedPath = (path: string): string | undefined => {
  if (path === "" || isAbsolute(path)) return undefined;
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized === ".")
    return undefined;
  return normalized;
};

const exists = (path: string) =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  );

export const seedWorktree = (opts: SeedOptions): Effect.Effect<SeedReport, SeedPathError> =>
  Effect.gen(function* () {
    // Every path is validated BEFORE the first copy: a list with one bad entry copies nothing,
    // so a refusal never leaves a half-seeded worktree that looks provisioned.
    const safe: Array<[string, string]> = [];
    for (const path of opts.paths) {
      const rel = safeSeedPath(path);
      if (rel === undefined) return yield* Effect.fail(new SeedPathError({ path }));
      const src = resolve(opts.repoPath, rel);
      const dest = resolve(opts.worktreePath, rel);
      const inside = (p: string, root: string) => p === root || p.startsWith(join(root, sep));
      if (!inside(src, resolve(opts.repoPath)) || !inside(dest, resolve(opts.worktreePath)))
        return yield* Effect.fail(new SeedPathError({ path }));
      safe.push([rel, path]);
    }
    const report: SeedReport = { copied: [], kept: [], missing: [] };
    for (const [rel, path] of safe) {
      const src = resolve(opts.repoPath, rel);
      const dest = resolve(opts.worktreePath, rel);
      if (yield* exists(dest)) {
        report.kept.push(path);
        continue;
      }
      if (!(yield* exists(src))) {
        report.missing.push(path);
        continue;
      }
      // force:false + errorOnExist:false keeps the never-overwrite rule even in the race where
      // the destination appears between the check and the copy.
      yield* Effect.promise(() =>
        cp(src, dest, { recursive: true, force: false, errorOnExist: false }),
      );
      report.copied.push(path);
    }
    return report;
  });
