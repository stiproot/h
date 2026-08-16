"""Wheel build hook — the FAT WHEEL: bundle the local substrate into the package.

A packaged `h` must be self-contained (the h-packaged plan's Phase 2, operator call
2026-08-15): the wheel ships the stock charts and a single-file bundle of the JS runner under
`h_cli/_bundled/`, so `uv tool install` from the GitHub source yields a working local substrate
with no h checkout at runtime. The costs, stated plainly:

- Building the wheel requires the FULL h repo around this directory (uv's git installs clone it)
  plus `bun` — consistent with bun's existing build-time-only role. An sdist of cli/h alone
  cannot build the bundle and refuses loud.
- Editable installs (the uv workspace dev mode) skip all of this: checkout mode resolves charts
  and runner from the repo directly, and `IS_CHECKOUT` keeps `_bundled/` out of the picture.
"""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class BundleSubstrate(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        # Editable installs run from the checkout; only real wheels carry the bundle.
        if self.target_name != "wheel" or version == "editable":
            return
        cli_dir = Path(self.root)
        repo = cli_dir.parents[1]
        charts_src = repo / "cli" / "charts"
        runner_src = repo / "packages" / "js" / "local-runtime"
        if not charts_src.is_dir() or not runner_src.is_dir():
            raise RuntimeError(
                "the h-cli wheel bundles the stock charts and the JS runner, so it must be "
                "built from the FULL h repo (e.g. `uv tool install 'h-cli @ "
                "git+https://github.com/stiproot/h#subdirectory=cli/h'`) — an sdist of cli/h "
                "alone cannot provide them."
            )

        # PROVENANCE, CAPTURED FIRST. `version` is a release number, not a build identity: every
        # wheel cut from main carries the same 0.1.0, so a consumer cannot tell one from another
        # — and a consumer that pins h by commit needs exactly that. This is read BEFORE the
        # build touches anything, because the steps below (bun install, turbo build, the bundle
        # itself) write into the tree, and a dirty flag sampled afterwards reports the build's
        # own artifacts and is therefore always true. Best-effort by design: a build from an
        # exported tree has no git and still ships.
        def _git(*args: str) -> str:
            try:
                return subprocess.run(
                    ["git", "-C", str(repo), *args],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip()
            except (subprocess.CalledProcessError, FileNotFoundError):
                return ""

        commit = _git("rev-parse", "HEAD")
        provenance = {
            "commit": commit,
            "shortCommit": commit[:7],
            "committedAt": _git("show", "-s", "--format=%cI", "HEAD"),
            # A wheel built from a dirty tree is not reproducible from its commit; say so rather
            # than let a consumer's lock imply a fidelity it does not have.
            #
            # TRACKED changes only, which is also git's own definition (`git describe --dirty`
            # ignores untracked files). Counting untracked ones made every uv-installed wheel
            # report dirty: uv drops a `.ok` sentinel into its git checkout before building, so
            # the tree is never pristine by that stricter measure. Verified live 2026-08-16 in
            # ~/.cache/uv/git-v0/checkouts — one untracked file, `.ok`.
            "dirty": bool(_git("status", "--porcelain", "--untracked-files=no")),
        }

        bundled = cli_dir / "src" / "h_cli" / "_bundled"
        shutil.rmtree(bundled, ignore_errors=True)
        bundled.mkdir(parents=True)

        # Stock charts: copied verbatim minus the operator's gitignored local overrides — a
        # wheel must render hermetically from defaults, exactly like the golden tests.
        shutil.copytree(
            charts_src,
            bundled / "charts",
            ignore=shutil.ignore_patterns("values.local.yaml"),
        )

        # The runner: build the workspace graph, then bundle the built entrypoint into one
        # self-contained .mjs (nats.js and the Effect stack are pure JS — bundleable).
        bun = shutil.which("bun")
        if bun is None:
            raise RuntimeError(
                "building the h-cli wheel needs `bun` on PATH (it bundles the JS runner; "
                "bun stays build-time-only, exactly as in the h repo itself)."
            )
        run = lambda *cmd: subprocess.run(  # noqa: E731
            cmd, cwd=repo, check=True, capture_output=True, text=True
        )
        try:
            run(bun, "install", "--frozen-lockfile")
            run("bunx", "turbo", "build", "--filter=local-runtime...")
            run(
                bun,
                "build",
                str(runner_src / "dist" / "bin.js"),
                "--target=node",
                "--outfile",
                str(bundled / "h-local.mjs"),
            )
        except subprocess.CalledProcessError as err:
            raise RuntimeError(
                f"bundling the runner failed: {' '.join(err.cmd)}\n{err.stderr[-2000:]}"
            ) from err

        # Belt-and-braces: a wheel whose bundle is hollow must never ship.
        runner_out = bundled / "h-local.mjs"
        if not runner_out.is_file() or runner_out.stat().st_size == 0:
            raise RuntimeError("bundled runner is missing or empty — refusing to build the wheel")

        (bundled / "build.json").write_text(json.dumps(provenance, indent=2) + "\n")
        build_data.setdefault("artifacts", []).append("src/h_cli/_bundled/**")
