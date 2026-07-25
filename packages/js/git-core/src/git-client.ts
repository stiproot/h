import { Command } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Stream } from "effect";

/**
 * How git authenticates to the remote. Strategies are *named* in workflow/step config; the
 * secrets stay in env/mounts on the agent service, never in a definition.
 *  - `pat`: inject a token into a github URL — in EITHER form (https or scp-style ssh) — per
 *    invocation (never persisted), so the transport resolves over https regardless of the origin
 *    the clone carries; `token` on Clone/Worktree options is shorthand for this strategy.
 *  - `ssh`: rewrite a github URL (either form) to its `git@github.com:` form and let SSH
 *    authenticate the transport — via `keyPath` (`GIT_SSH_COMMAND -i`) or the ambient agent/config
 *    when unset. SSH covers git transport only; API calls (PR creation) authenticate separately.
 * A `github-app` strategy (mint an installation token per op, then the pat path) can slot in
 * here without touching callers.
 */
export type GitAuth = { kind: "pat"; token?: string } | { kind: "ssh"; keyPath?: string };

export type CloneOptions = {
  url: string;
  dir: string;
  cwd: string;
  branch?: string;
  depth?: number;
  /** Shorthand for `auth: { kind: "pat", token }`; ignored when `auth` is set. */
  token?: string;
  auth?: GitAuth;
};

const GITHUB_HTTPS = "https://github.com/";
const GITHUB_SSH = "git@github.com:";

// The `owner/repo(.git)` path of a github remote in EITHER transport form — https
// (`https://github.com/owner/repo`) or scp-style ssh (`git@github.com:owner/repo`); undefined for a
// non-github URL. Extracting the path independently of the form is what lets a transport strategy be
// chosen per repo without depending on the form the clone's origin happens to carry.
function githubRepoPath(url: string): string | undefined {
  if (url.startsWith(GITHUB_HTTPS)) return url.slice(GITHUB_HTTPS.length);
  if (url.startsWith(GITHUB_SSH)) return url.slice(GITHUB_SSH.length);
  return undefined;
}

// Inject a GitHub token into a github URL — in either form — so a private repo resolves over https.
// Done in-process at invocation time; the token is passed to git as an argument (no shell), so it
// never lands in a shell command line, the workflow definition, or the task entry. Non-github URLs
// and the tokenless case pass through untouched.
function authenticatedUrl(url: string, token?: string): string {
  const path = token ? githubRepoPath(url) : undefined;
  return path === undefined ? url : `https://x-access-token:${token}@github.com/${path}`;
}

// Rewrite a github URL — in either form — to its scp-style SSH form so the transport authenticates
// via SSH keys. Non-github URLs pass through untouched; an already-SSH URL normalizes to itself.
function sshUrl(url: string): string {
  const path = githubRepoPath(url);
  return path === undefined ? url : `git@github.com:${path.replace(/\.git$/, "")}.git`;
}

const normalizeAuth = (auth: GitAuth | undefined, token: string | undefined): GitAuth =>
  auth ?? { kind: "pat", token };

// The strategy's two touch points on a git invocation: the remote URL form, and the process env.
// Exported pure for value tests (the mergeMcpConfig pattern).
export const resolveUrl = (url: string, auth: GitAuth): string =>
  auth.kind === "ssh" ? sshUrl(url) : authenticatedUrl(url, auth.token);

export const authEnv = (auth: GitAuth): Record<string, string> | undefined =>
  auth.kind === "ssh" && auth.keyPath
    ? {
        GIT_SSH_COMMAND: `ssh -i ${auth.keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      }
    : undefined;

const authToken = (auth: GitAuth): string | undefined =>
  auth.kind === "pat" ? auth.token : undefined;

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
  // in clone(); never persisted to the remote or a shell command line). Shorthand for
  // `auth: { kind: "pat", token }`; ignored when `auth` is set.
  token?: string;
  auth?: GitAuth;
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
     * Add a git worktree of `repoPath` at `worktreePath`, returning the EFFECTIVE path. An
     * existing branch is checked out as-is (not reset); a missing one is created — from the
     * freshly-fetched `origin/<remoteBase>` tip when `remoteBase` is set and no explicit
     * `baseRef` pins a start point. Reuse-by-branch (issue #76): a branch can only be checked
     * out in ONE worktree, so if some worktree (any workspace) already holds it, that
     * worktree's path is returned instead of failing — members that need a fresh base already
     * fetch + reset against origin themselves.
     */
    readonly addWorktree: (opts: WorktreeOptions) => Effect.Effect<string, GitWorktreeError>;
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
  env?: Record<string, string>,
): Effect.Effect<string, GitExitError | PlatformError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = Command.make("git", ...args);
      const withCwd = cwd ? Command.workingDirectory(base, cwd) : base;
      const command = env ? Command.env(withCwd, env) : withCwd;
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
  const { url, dir, cwd, branch, depth = 1 } = opts;
  const auth = normalizeAuth(opts.auth, opts.token);
  const token = authToken(auth);
  const args = ["clone", "--depth", String(depth)];
  if (branch) args.push("--branch", branch);
  args.push(resolveUrl(url, auth), dir);
  return runGit(args, cwd, authEnv(auth)).pipe(
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

/** Parse `git worktree list --porcelain`: the LINKED worktree path currently holding `branch`,
 *  if any. The first block is the MAIN working tree (the shared pre-clone) — deliberately
 *  skipped: an agent must never be redirected into it, so a branch held there falls through to
 *  git's own loud "already used" error. */
const worktreePathForBranch = (porcelain: string, branch: string): string | undefined => {
  let current: string | undefined;
  let block = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      block += 1;
      current = block > 1 ? line.slice("worktree ".length).trim() : undefined;
    } else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return undefined;
};

const addWorktreeEffect = (
  opts: WorktreeOptions,
): Effect.Effect<string, GitWorktreeError, CommandExecutor.CommandExecutor> => {
  const { repoPath, worktreePath, branch, remoteBase } = opts;
  const auth = normalizeAuth(opts.auth, opts.token);
  const token = authToken(auth);
  return Effect.gen(function* () {
    // Drop admin entries for worktree dirs removed out of band, so re-adding at the same path does
    // not fail with "already registered".
    yield* runGit(["-C", repoPath, "worktree", "prune"]);

    // Reuse-by-branch (issue #76): a branch is checked out in at most one worktree; if one holds
    // it already (a finished chain's leftover, another workspace's checkout), return ITS path
    // instead of failing with "already used by worktree".
    if (branch) {
      const porcelain = yield* runGit(["-C", repoPath, "worktree", "list", "--porcelain"]);
      const held = worktreePathForBranch(porcelain, branch);
      if (held !== undefined) return held;
    }

    const reuseExisting = branch ? yield* branchExistsEffect(repoPath, branch) : false;

    // Refresh from the remote before cutting a NEW branch so it starts from the latest
    // origin/<remoteBase> rather than the source clone's stale local checkout. Skipped when reusing
    // an existing branch (keep its work) or when the caller pinned an explicit baseRef.
    let baseRef = opts.baseRef;
    if (!reuseExisting && remoteBase && !baseRef) {
      const originUrl = (yield* runGit(["-C", repoPath, "remote", "get-url", "origin"])).trim();
      const trackingRef = `refs/remotes/origin/${remoteBase}`;
      yield* runGit(
        [
          "-C",
          repoPath,
          "fetch",
          "--quiet",
          resolveUrl(originUrl, auth),
          `${remoteBase}:${trackingRef}`,
        ],
        undefined,
        authEnv(auth),
      );
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
    return worktreePath;
  }).pipe(
    Effect.mapError(
      (failure) =>
        new GitWorktreeError({ cause: redactedCause(failure, token), repoPath, worktreePath }),
    ),
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
