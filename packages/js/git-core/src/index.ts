export {
  ExecGitClient,
  GitClient,
  GitCloneError,
  GitWorktreeError,
  authEnv,
  resolveUrl,
} from "./git-client.ts";
export type { CloneOptions, GitAuth, GitCheckout, WorktreeOptions } from "./git-client.ts";
export { gcDecision, parseDirt, parseWorktrees } from "./worktree-gc.ts";
export type { Dirt, GcEntry, GcOptions, GcReport } from "./worktree-gc.ts";
export { GitHubApiError, GitHubClient, HttpGitHubClient } from "./github-client.ts";
export type { IssueRef, ListOpenIssuesOptions } from "./github-client.ts";

export { GitHubSourceReaderLive } from "./github-source-reader.ts";
