import { Context, Data, Effect, Layer } from "effect";

/**
 * A read-only GitHub REST capability, sibling of {@link GitClient} — the git *transport* client does
 * subprocess `git` (clone/worktree); this does GitHub *API* reads over HTTP. It lives in git-core so
 * the GitHub I/O machinery has ONE home: workflow-svc's discovery cron (docs/plans/
 * workflow-watcher-registry.md §9) consumes it through a domain `ISourceReader` port rather than
 * growing its own GitHub client. If more non-agent GitHub ops accrue, a dedicated service can capture
 * this port without touching callers.
 *
 * The token is passed per-call (never persisted); the caller reads it from the environment. It is sent
 * only as an `Authorization` header — it never enters a URL, so it cannot surface in an error message,
 * but error text is scrubbed of it regardless (the {@link GitClient} discipline).
 */

/** One open issue, minimal fields — enough to dedup (`number`), order (`createdAt`), and label a run. */
export type IssueRef = {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
};

export type ListOpenIssuesOptions = {
  /** `owner/name`. */
  readonly repo: string;
  /** Only issues carrying this label. */
  readonly label: string;
  /** PAT/installation token; sent as a Bearer header. Omit for public repos. */
  readonly token?: string;
};

/** A GitHub REST call failed (non-2xx or transport). `cause` is token-scrubbed. */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly cause: unknown;
  readonly repo: string;
}> {
  override get message(): string {
    const c = this.cause;
    return `GitHub API read for ${this.repo} failed: ${c instanceof Error ? c.message : String(c)}`;
  }
}

export class GitHubClient extends Context.Tag("GitHubClient")<
  GitHubClient,
  {
    /**
     * List OPEN issues on `repo` carrying `label`, OLDEST-first (created ascending). Pull requests are
     * excluded (the REST `/issues` endpoint returns PRs too; entries with a `pull_request` field are
     * dropped). Capped at one page of 100 — the discovery cron fires one per tick, so a deeper backlog
     * is drained across ticks, not in a single read.
     */
    readonly listOpenIssues: (
      opts: ListOpenIssuesOptions,
    ) => Effect.Effect<readonly IssueRef[], GitHubApiError>;
  }
>() {}

const API_BASE = "https://api.github.com";
const PER_PAGE = 100;

const scrub = (text: string, token: string | undefined): string =>
  token ? text.split(token).join("<redacted>") : text;

const listOpenIssuesEffect = (
  opts: ListOpenIssuesOptions,
): Effect.Effect<readonly IssueRef[], GitHubApiError> => {
  const { repo, label, token } = opts;
  const url =
    `${API_BASE}/repos/${repo}/issues` +
    `?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=${PER_PAGE}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "h-workflow-svc",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return Effect.tryPromise({
    try: async (): Promise<readonly IssueRef[]> => {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
      }
      const raw = (await res.json()) as ReadonlyArray<{
        number: number;
        title: string;
        created_at: string;
        pull_request?: unknown;
      }>;
      return raw
        .filter((i) => i.pull_request === undefined) // /issues returns PRs too — drop them
        .map((i) => ({ number: i.number, title: i.title, createdAt: i.created_at }));
    },
    catch: (cause) =>
      new GitHubApiError({
        cause: cause instanceof Error ? new Error(scrub(cause.message, token)) : cause,
        repo,
      }),
  });
};

/** Adapter: GitHub REST over the global `fetch`. No dependencies to capture, so a plain `succeed`. */
export const HttpGitHubClient: Layer.Layer<GitHubClient> = Layer.succeed(GitHubClient, {
  listOpenIssues: listOpenIssuesEffect,
});
