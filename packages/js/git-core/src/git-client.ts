import { Command } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Stream } from "effect";

export type CloneOptions = {
  url: string;
  dir: string;
  cwd: string;
  branch?: string;
  depth?: number;
  token?: string;
};

const GITHUB_HTTPS = "https://github.com/";

// Inject a GitHub token into an https github URL so private repos resolve. Done in-process at
// clone time; the token is passed to git as an argument (no shell), so it never lands in a shell
// command line, the workflow definition, or the task entry.
function authenticatedUrl(url: string, token?: string): string {
  if (!token || !url.startsWith(GITHUB_HTTPS)) return url;
  return `https://x-access-token:${token}@github.com/${url.slice(GITHUB_HTTPS.length)}`;
}

export type WorktreeOptions = {
  // Path to an existing clone (holds the .git the worktree shares its object store with).
  repoPath: string;
  // Destination path for the new worktree checkout.
  worktreePath: string;
  // Branch to put the worktree on. If it already exists, the worktree checks it out (preserving its
  // commits); if not, it is created. Omit to let git name a branch after the worktree path.
  branch?: string;
  // Start point for a newly created branch; ignored when checking out an existing branch.
  baseRef?: string;
  // When set (e.g. "main"), fetch this branch from origin before cutting a NEW branch and start it
  // from the freshly-fetched remote tip, so the worktree is up to date with the remote rather than
  // the source clone's possibly-stale local checkout. Ignored when checking out an existing branch
  // (its commits are preserved) or when an explicit baseRef is given (the caller pinned a start point).
  remoteBase?: string;
  // GitHub token to authenticate the origin fetch for a private https repo (injected in-process, as
  // in clone(); never persisted to the remote or a shell command line).
  token?: string;
};

// ---------------------------------------------------------------------------
// Effect port + adapter (the GitClient hexagon unit — see plans/effect-refactor-map.md §2)
// ---------------------------------------------------------------------------

/**
 * A `git clone` failed. `url` is always the caller's UNauthenticated URL and `cause`
 * carries only token-scrubbed text, so an injected GH_TOKEN can never surface here.
 */
export class GitCloneError extends Data.TaggedError("GitCloneError")<{
  readonly cause: unknown;
  readonly url: string;
  readonly dir: string;
}> {
  override get message(): string {
    return `git clone of ${this.url} into ${this.dir} failed: ${causeText(this.cause)}`;
  }
}

/**
 * A `git worktree` provisioning step (prune, origin fetch, or worktree add) failed.
 * `cause` carries only token-scrubbed text, as in {@link GitCloneError}.
 */
export class GitWorktreeError extends Data.TaggedError("GitWorktreeError")<{
  readonly cause: unknown;
  readonly repoPath: string;
  readonly worktreePath: string;
}> {
  override get message(): string {
    return `git worktree of ${this.repoPath} at ${this.worktreePath} failed: ${causeText(this.cause)}`;
  }
}

const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The git port: today's `clone()`/`addWorktree()` contract made explicit as a tag.
 * Methods are `R = never`; the adapter layer captures `CommandExecutor` at build time.
 */
export class GitClient extends Context.Tag("GitClient")<
  GitClient,
  {
    /** Shallow-clone `url` into `dir` (relative to `cwd`), depth 1 unless overridden. */
    readonly clone: (opts: CloneOptions) => Effect.Effect<void, GitCloneError>;
    /**
     * Add a git worktree of `repoPath` at `worktreePath`. An existing branch is checked out
     * as-is (not reset); a missing one is created — from the freshly-fetched `origin/<remoteBase>`
     * tip when `remoteBase` is set and no explicit `baseRef` pins a start point.
     */
    readonly addWorktree: (opts: WorktreeOptions) => Effect.Effect<void, GitWorktreeError>;
  }
>() {}

/** Internal: a git subprocess exited non-zero. Raw stderr — scrubbed before leaving the port. */
class GitExitError extends Data.TaggedError("GitExitError")<{
  readonly exitCode: number;
  readonly stderr: string;
}> {}

const collectText = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> =>
  stream.pipe(
    Stream.decodeText("utf-8"),
    Stream.runFold("", (acc, chunk) => acc + chunk),
  );

// Run git with the given args, capturing stdout as the result and stderr for diagnostics
// (the Effect sibling of execFileSync's `stdio: "pipe"` throw). stdout/stderr/exit are read
// concurrently so a chatty stream can never deadlock the pipe buffer.
const runGit = (
  args: ReadonlyArray<string>,
  cwd?: string,
): Effect.Effect<string, GitExitError | PlatformError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = Command.make("git", ...args);
      const command = cwd ? Command.workingDirectory(base, cwd) : base;
      const process = yield* Command.start(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectText(process.stdout), collectText(process.stderr), process.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return yield* new GitExitError({ exitCode, stderr });
      return stdout;
    }),
  );

const REDACTED = "<redacted>";

const scrub = (text: string, token: string | undefined): string =>
  token ? text.split(token).join(REDACTED) : text;

// The only path from a raw git failure into a port error: every piece of text that could echo
// the authenticated URL (stderr, platform error messages) passes through scrub() first.
const redactedCause = (failure: GitExitError | PlatformError, token: string | undefined): Error =>
  failure._tag === "GitExitError"
    ? new Error(scrub(`git exited with code ${failure.exitCode}: ${failure.stderr.trim()}`, token))
    : new Error(scrub(failure.message, token));

const cloneEffect = (
  opts: CloneOptions,
): Effect.Effect<void, GitCloneError, CommandExecutor.CommandExecutor> => {
  const { url, dir, cwd, branch, depth = 1, token } = opts;
  const args = ["clone", "--depth", String(depth)];
  if (branch) args.push("--branch", branch);
  args.push(authenticatedUrl(url, token), dir);
  return runGit(args, cwd).pipe(
    Effect.mapError(
      (failure) => new GitCloneError({ cause: redactedCause(failure, token), url, dir }),
    ),
    Effect.asVoid,
  );
};

const branchExistsEffect = (
  repoPath: string,
  branch: string,
): Effect.Effect<boolean, PlatformError, CommandExecutor.CommandExecutor> =>
  Command.make(
    "git",
    "-C",
    repoPath,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ).pipe(
    Command.exitCode,
    Effect.map((code) => code === 0),
  );

const addWorktreeEffect = (
  opts: WorktreeOptions,
): Effect.Effect<void, GitWorktreeError, CommandExecutor.CommandExecutor> => {
  const { repoPath, worktreePath, branch, remoteBase, token } = opts;
  return Effect.gen(function* () {
    // Drop admin entries for worktree dirs removed out of band, so re-adding at the same path does
    // not fail with "already registered".
    yield* runGit(["-C", repoPath, "worktree", "prune"]);

    const reuseExisting = branch ? yield* branchExistsEffect(repoPath, branch) : false;

    // Refresh from the remote before cutting a NEW branch so it starts from the latest
    // origin/<remoteBase> rather than the source clone's stale local checkout. Skipped when reusing
    // an existing branch (keep its work) or when the caller pinned an explicit baseRef.
    let baseRef = opts.baseRef;
    if (!reuseExisting && remoteBase && !baseRef) {
      const originUrl = (yield* runGit(["-C", repoPath, "remote", "get-url", "origin"])).trim();
      const trackingRef = `refs/remotes/origin/${remoteBase}`;
      yield* runGit([
        "-C",
        repoPath,
        "fetch",
        "--quiet",
        authenticatedUrl(originUrl, token),
        `${remoteBase}:${trackingRef}`,
      ]);
      baseRef = trackingRef;
    }

    const args = ["-C", repoPath, "worktree", "add"];
    if (reuseExisting) {
      // Check out the existing branch into the worktree (no -b/-B: don't recreate or reset it).
      args.push(worktreePath, branch as string);
    } else if (branch) {
      // Create a new branch for the worktree, optionally from baseRef (the refreshed remote tip above).
      args.push("-b", branch, worktreePath);
      if (baseRef) args.push(baseRef);
    } else {
      args.push(worktreePath);
      if (baseRef) args.push(baseRef);
    }
    yield* runGit(args);
  }).pipe(
    Effect.mapError(
      (failure) =>
        new GitWorktreeError({ cause: redactedCause(failure, token), repoPath, worktreePath }),
    ),
    Effect.asVoid,
  );
};

/**
 * Adapter: git over `@effect/platform` `Command` (non-blocking subprocesses). The layer captures
 * `CommandExecutor` at build time so the port methods stay `R = never`; the consuming composition
 * root provides `NodeContext.layer` (or `NodeCommandExecutor.layer`).
 */
export const ExecGitClient: Layer.Layer<GitClient, never, CommandExecutor.CommandExecutor> =
  Layer.effect(
    GitClient,
    Effect.gen(function* () {
      const executor = yield* Effect.context<CommandExecutor.CommandExecutor>();
      return {
        clone: (opts: CloneOptions) => cloneEffect(opts).pipe(Effect.provide(executor)),
        addWorktree: (opts: WorktreeOptions) =>
          addWorktreeEffect(opts).pipe(Effect.provide(executor)),
      };
    }),
  );
