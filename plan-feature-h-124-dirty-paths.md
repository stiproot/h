I’ll first audit the branch history and any surviving plan, then cheaply verify those findings against the current tree. I’ll keep this read-only and finish with the requested implementation plan.
The branch is clean at `origin/main` (`b1c9345`) with no feature commits, and the root plan file is absent. No Dapr MCP is wired in this session, so the prescribed recovery audit ends there; I’m now tracing the exact template/test/snapshot touchpoints and repository conventions.
No prior implementation was found: the branch is clean at `b1c9345` (`origin/main`), there are no feature commits, and no surviving plan file or Dapr MCP state. The current tree still has only the `dirty` boolean, so the feature remains unimplemented. `cli/README.md` mentions “dirty” only for worktree status, not the verify contract, and should remain unchanged.

===IMPLEMENTATION PLAN===

Status: Planning — add verbatim `dirtyPaths` evidence to the verify contract while retaining `dirty`.

1. Establish and record the baseline before editing:

   - Record `git rev-parse HEAD` and every line from `git status --porcelain`.
   - Run the complete baseline command:
     `bun install --frozen-lockfile && bun run build && uv run --package h-cli pytest cli/h/tests && bun run lint`
   - Capture exit code and failure count for the verify evidence.

2. Add `test_verify_contract_reports_dirty_paths` beside `test_verify_golden` in `cli/h/tests/test_render.py`:

   - Reuse the exact `helm.render_workflow("verify", values={"publish": "true", "verify.cmd": "bun run lint"}, include_local=False)` path used by the golden test.
   - Convert the render through `helm.to_wire_json`, locate the lone `implement` step, and read its `input.outputContract`.
   - For both `baseline` and `final`, assert:
     - `dirtyPaths` is required.
     - `dirtyPaths.type == "array"`.
     - `dirtyPaths.items.type == "string"`.
     - `dirty` remains required.

3. Before changing the template, demonstrate the new test fails correctly:

   - Run `uv run --package h-cli pytest cli/h/tests/test_render.py -k dirty_paths`.
   - Confirm it fails on an assertion naming `dirtyPaths`, not setup, import, or Helm rendering.
   - Preserve the exact failing lines for the verify contract’s `demonstrations` field.

4. Update only `cli/charts/workflows/templates/verify.tmpl.yaml`:

   - Add `dirtyPaths` to `h.contract.verify-check` as an array of strings with the exact specified description.
   - Change `required` to `[command, exitCode, failures, commit, dirty, dirtyPaths]`.
   - Retain `dirty`, replacing its description with the specified derived-convenience wording.
   - Rewrite the baseline paragraph to require one verbatim `git status --porcelain` line per `dirtyPaths` entry.
   - Explain that the current run’s expected untracked `plan-<slug>.md` may appear, while a tracked baseline modification invalidates the baseline.
   - Leave commit semantics and all excluded templates, docs, and scripts untouched.

5. Run the focused test again and confirm it passes:
   `uv run --package h-cli pytest cli/h/tests/test_render.py -k dirty_paths`.

6. Regenerate snapshots with:
   `uv run --package h-cli pytest cli/h/tests --snapshot-update`.

   Then inspect rather than blindly accept the update:

   - `git diff --stat cli/h/tests/__snapshots__/` must show only `test_render.ambr`.
   - `git diff cli/h/tests/__snapshots__/test_render.ambr | grep -c "^[-+] "` must remain a small, tens-of-lines change.
   - `git diff cli/h/tests/__snapshots__/test_render.ambr | grep "^@@"` must show hunks confined to `# name: test_verify_golden`.
   - Read the full snapshot diff and reject any unrelated golden changes.

7. Prove template isolation and rendered behavior:

   - Run `grep -rn "verify-check" cli/charts/`; record the expected three hits, all in `verify.tmpl.yaml`.
   - Render with the specified `helm template verify ... --set verify.cmd="bun run lint"` command.
   - Confirm and record the two rendered `dirtyPaths` required entries for `baseline` and `final`.
   - Confirm `cli/README.md` has no verify-contract field documentation; leave its unrelated worktree-status “dirty” references unchanged.

8. Review the complete diff and confirm only these files changed:

   - `cli/charts/workflows/templates/verify.tmpl.yaml`
   - `cli/h/tests/test_render.py`
   - `cli/h/tests/__snapshots__/test_render.ambr`

9. Create the single requested commit:
   `charts: verify reports dirtyPaths beside the dirty boolean (#124)`

   Include the repository’s conventional co-author/session trailers, staging only the three intended files.

10. On the committed tree, run the complete final acceptance command:
    `bun install --frozen-lockfile && bun run build && uv run --package h-cli pytest cli/h/tests && bun run lint`

    Record `commit`, `dirtyPaths`, exit code, and `failures: 0`, and ensure final failures do not exceed baseline failures.

11. Prepare the PR against `main` with:

    - The baseline/final verify evidence block.
    - The verbatim failing demonstration.
    - Snapshot-isolation and Helm-render evidence under `extraChecks`.
    - `Closes #124`.
    - Read-back confirmation that `base == main`, `baseline.commit == main@fire`, `final.failures <= baseline.failures`, and every step’s `stopReason == completed`.
