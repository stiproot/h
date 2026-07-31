# Self-hosted CI runner

Runs h's **real** `guards.yml` on our own hardware instead of GitHub-hosted runners,
switched with a single repo variable. Pattern lifted from trxy-v2's `tools/ci-runner`
(validated there through a real billing lapse).

**This is a permanent, supported mode — not a temporary workaround.** It earns its place
three ways: hosted-runner minutes are the only thing GitHub bills (self-hosted execution is
free); CI survives a billing lapse or quota reset with no scramble; and it runs the *real*
workflow — same `guards.yml`, same actions — so what passes here is what passes hosted.

Keep the toolchain args in `Dockerfile` in sync when the repo's versions move (node, bun —
pinned to `guards.yml`'s `BUN_VERSION` — uv, helm); the image build fails loudly on a
missing tool.

**The switch:** every job in `.github/workflows/` uses
`runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`. Set the repo variable to move the
fleet here; delete it to go back to hosted. Neither direction needs a YAML change.

## Start the runner

`GH_TOKEN` must be exported with **Administration: read+write** on `stiproot/h`
(verify: POST `/repos/stiproot/h/actions/runners/registration-token` returns 201).

```sh
docker compose -f tools/ci-runner/compose.yml build        # first time
docker compose -f tools/ci-runner/compose.yml up -d runner
docker logs h-runner-1 | tail -5                           # expect: Listening for Jobs
```

Confirm registered and online:

```sh
curl -s -H "Authorization: Bearer $GH_TOKEN" \
  https://api.github.com/repos/stiproot/h/actions/runners \
  | jq -r '.runners[] | "\(.name) \(.status) \([.labels[].name]|join(","))"'
```

## The toggle (one command each way)

`toggle.sh` bundles the whole switch — container lifecycle, runner registration, and the
`RUNNER_LABEL` variable — in the safe order (register before pointing the fleet here; point
back at hosted before draining), and verifies the end state:

```sh
tools/ci-runner/toggle.sh on       # start + register the runner, then RUNNER_LABEL=h-dev
tools/ci-runner/toggle.sh off      # delete RUNNER_LABEL, stop + de-register, verify 0 registered
tools/ci-runner/toggle.sh status   # visibility, RUNNER_LABEL, registered runners, container
```

**`on` REFUSES while the repo is public** (fork PRs would run untrusted code on this box —
see Security below); `--force-public` overrides with a loud warning, for the case where you
have consciously locked down fork-PR approval and accept the risk. `off` also force-removes
any stale runner registration — the registration list, not the container, is what GitHub's
public-repo runner warning keys on.

The raw switch, for reference (`|| treats undefined/empty as falsy — no YAML change`):
POST/DELETE `repos/stiproot/h/actions/variables` for `RUNNER_LABEL=h-dev`.

## Day-to-day

| Task                        | Command                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| Start                       | `docker compose -f tools/ci-runner/compose.yml up -d runner`         |
| Stop (de-registers cleanly) | `docker compose -f tools/ci-runner/compose.yml stop runner`          |
| Logs                        | `docker logs -f h-runner-1`                                          |
| Rebuild after version bump  | `docker compose -f tools/ci-runner/compose.yml build --no-cache`     |
| Reset the workspace         | `docker compose down && docker volume rm h-ci-runner_runner-work`    |

`restart: unless-stopped` means the runner survives a reboot. When the dev box is off,
jobs targeting `h-dev` queue and GitHub cancels them after ~24h — if the box will be down
for a while, delete `RUNNER_LABEL`.

## Zero-GitHub fallback

No dedicated script: h's CI *is* the local gate — `guards.yml` delegates to the same
entrypoints you run locally (`bun run lint && bun run build && bun run test && make lint-py
&& make test-py`), and the pre-push hook (`scripts/hooks/pre-push`) runs the lint half on
every push. If GitHub is unreachable entirely, run those directly.

## Security

**Never attach a self-hosted runner to a public repository** — `guards.yml` runs on
`pull_request` and executes repo-controlled code (`bun install`, the package scripts), so a
fork of a public repo can run arbitrary code on this host by opening a PR. This rule is
ENCODED: `toggle.sh on` reads the repo's visibility and refuses when it is not private
(`--force-public` overrides, loudly). Detach before any private→public flip is simply
`toggle.sh off` — hosted runners are free for public repos, so the runner's raison d'être
(billed minutes) disappears while public anyway. The runner deliberately does not mount
the docker socket. Accepted risk while attached (private): repo secrets materialise as
plaintext env vars on this machine while a job runs — inherent to self-hosting.

### Going public — the checklist (executed 2026-07-31; keep for the next flip)

1. `tools/ci-runner/toggle.sh off` — fleet back to hosted, ZERO registered runners
   (verified via `GET /actions/runners`; this silences GitHub's runner warning).
2. Secret-scan the full history: `docker run --rm -v "$PWD":/repo
   zricethezav/gitleaks:latest git /repo --no-banner --redact` (461 commits clean).
3. Actions policy is `selected`: github-owned + `oven-sh/setup-bun@*`,
   `astral-sh/setup-uv@*`, `azure/setup-helm@*` (exactly what guards.yml uses); workflow
   token permissions are read-only, no PR-approval rights.
4. AFTER the flip (these APIs only exist for public repos):

   ```sh
   # require approval for fork-PR workflows from ALL outside collaborators
   curl -s -X PUT -H "Authorization: Bearer $GH_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/stiproot/h/actions/permissions/fork-pr-contributor-approval \
     -d '{"approval_policy":"all_external_contributors"}'
   # secret scanning + push protection
   curl -s -X PATCH -H "Authorization: Bearer $GH_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/stiproot/h \
     -d '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'
   ```
