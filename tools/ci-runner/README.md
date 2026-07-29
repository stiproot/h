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

## Point the workflows at it / back

```sh
# to self-hosted:
curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/stiproot/h/actions/variables \
  -d '{"name":"RUNNER_LABEL","value":"h-dev"}'

# back to hosted (|| treats undefined/empty as falsy — no YAML change):
curl -s -X DELETE -H "Authorization: Bearer $GH_TOKEN" \
  https://api.github.com/repos/stiproot/h/actions/variables/RUNNER_LABEL
```

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

**Never attach a self-hosted runner to a public repository** — a fork PR can execute
arbitrary code on the host. `stiproot/h` is private and single-owner. **If this repo is
ever made public, delete the runner first.** The runner deliberately does not mount the
docker socket. Accepted risk: repo secrets materialise as plaintext env vars on this
machine while a job runs — inherent to self-hosting.
