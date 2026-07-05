import type { GitAuth } from "git-core";

/**
 * Resolve the wire's auth *name* into a concrete git-core strategy. Definitions carry only the
 * kind ("pat" | "ssh"); the secrets stay in the agent service's env/mounts:
 *   - pat: GH_TOKEN (per-invocation https token injection — the original behaviour)
 *   - ssh: GIT_SSH_KEY_PATH (mounted key → GIT_SSH_COMMAND), or the ambient ssh config when unset
 * With no kind on the wire, GIT_AUTH selects the service-wide default (pat when unset).
 */
export function resolveGitAuth(
  kind: "pat" | "ssh" | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GitAuth {
  const resolved = kind ?? (env.GIT_AUTH === "ssh" ? "ssh" : "pat");
  return resolved === "ssh"
    ? { kind: "ssh", keyPath: env.GIT_SSH_KEY_PATH }
    : { kind: "pat", token: env.GH_TOKEN };
}
