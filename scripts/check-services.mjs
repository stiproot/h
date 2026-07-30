#!/usr/bin/env node
// Host-mode service-list drift guard — fail LOUDLY when the canonical service list in
// cli/scripts/_services.sh diverges from the zellij layout it mirrors.
//
// Two surfaces enumerate the same per-mode service set: the headless launcher's source of truth
// (cli/scripts/_services.sh, read by up-local/wait-local/down-local) and the interactive zellij
// layouts (.zellij/dev.kdl, .zellij/h-builds-h.kdl). They MUST agree — a service present in one
// path but not the other means the driver an agent uses and the panes a human watches are running
// different stacks. This guard asserts set-equality per mode so the lists can't silently drift as
// services are added/removed. See the *Harden by encoding*
// principle in ARCHITECTURE.md.
//
// _services.sh stays the single source of truth: we EXECUTE its services_for_mode() (authoritative)
// rather than re-parse its heredocs, and diff against the run-*.sh names the .kdl enumerates.
// Wired into `bun run lint` (package.json) beside check-templates.mjs. No skip flag by design.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// mode → the zellij layout that must mirror it
const MODES = {
  dev: ".zellij/dev.kdl",
  "h-builds-h": ".zellij/h-builds-h.kdl",
};

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function canonicalList(mode) {
  // Authoritative: source _services.sh and run services_for_mode <mode>.
  const out = execFileSync(
    "bash",
    ["-c", `source "${root}/cli/scripts/_services.sh"; services_for_mode "${mode}"`],
    { encoding: "utf8" },
  );
  return out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
}

function kdlList(layoutPath) {
  const text = readFileSync(resolve(root, layoutPath), "utf8");
  // Every pane runs a cli/scripts/run-*.sh — collect the distinct basenames.
  const names = new Set();
  for (const m of text.matchAll(/cli\/scripts\/(run-[a-z0-9-]+\.sh)/g)) names.add(m[1]);
  return [...names].sort();
}

const violations = [];
for (const [mode, layout] of Object.entries(MODES)) {
  const canonical = canonicalList(mode);
  const kdl = kdlList(layout);
  if (!eq(canonical, kdl)) {
    const onlyServices = canonical.filter((s) => !kdl.includes(s));
    const onlyKdl = kdl.filter((s) => !canonical.includes(s));
    violations.push(
      `mode '${mode}': cli/scripts/_services.sh and ${layout} disagree.` +
        (onlyServices.length ? `\n    only in _services.sh: ${onlyServices.join(", ")}` : "") +
        (onlyKdl.length ? `\n    only in ${layout}: ${onlyKdl.join(", ")}` : ""),
    );
  }
}

if (violations.length) {
  console.error("check-services: host-mode service lists have drifted:\n");
  for (const v of violations) console.error("  - " + v + "\n");
  console.error(
    "Fix: reconcile services_for_mode() in cli/scripts/_services.sh with the pane set in the .zellij layout so both paths run the same stack.",
  );
  process.exit(1);
}

console.log("check-services: host-mode service lists match the zellij layouts ✓");
