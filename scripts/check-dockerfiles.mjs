#!/usr/bin/env node
// Dockerfile workspace-manifest parity guard — fail LOUDLY when a JavaScript workspace
// manifest is missing from, or a deleted workspace is still referenced by, an app image
// that runs Bun's frozen install.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workspaceManifests(parent) {
  const parentPath = resolve(root, parent);
  return readdirSync(parentPath)
    .filter((name) => existsSync(join(parentPath, name, "package.json")))
    .sort()
    .map((name) => `${parent}/${name}/package.json`);
}

const packageManifests = workspaceManifests("packages/js");
const appManifests = workspaceManifests("apps");
const requiredManifests = [...packageManifests, ...appManifests];

const dockerfiles = readdirSync(resolve(root, "apps"))
  .map((name) => resolve(root, "apps", name, "Dockerfile"))
  .filter((path) => existsSync(path))
  .filter((path) => readFileSync(path, "utf8").match(/bun install --frozen-lockfile/))
  .sort();

const violations = [];
const manifestCopyPattern =
  /^\s*COPY\s+((?:packages\/js|apps)\/[^/\s]+\/package\.json)\s+\S+\s*$/;
const workspaceCopyPattern =
  /^\s*COPY\s+(packages\/js\/([^/\s]+)\/(?:package\.json)?|apps\/([^/\s]+)\/package\.json)(?:\s|$)/;

for (const path of dockerfiles) {
  const file = relative(root, path);
  const lines = readFileSync(path, "utf8").split("\n");
  const frozenInstallLine =
    lines.findIndex((line) => /bun install --frozen-lockfile/.test(line)) + 1;
  const copied = new Set();

  lines.forEach((line, index) => {
    const manifestMatch = line.match(manifestCopyPattern);
    if (manifestMatch) copied.add(manifestMatch[1]);

    const workspaceMatch = line.match(workspaceCopyPattern);
    if (!workspaceMatch) return;
    const parent = workspaceMatch[2] ? "packages/js" : "apps";
    const name = workspaceMatch[2] ?? workspaceMatch[3];
    if (!existsSync(resolve(root, parent, name, "package.json"))) {
      violations.push({
        file,
        line: index + 1,
        message: `stale workspace manifest COPY; remove this line:\n    ${line.trim()}`,
      });
    }
  });

  for (const manifest of requiredManifests) {
    if (copied.has(manifest)) continue;
    const destination = `./${dirname(manifest)}/`;
    violations.push({
      file,
      line: frozenInstallLine,
      message: `missing workspace manifest COPY; add this line:\n    COPY ${manifest} ${destination}`,
    });
  }
}

if (violations.length > 0) {
  console.error("✗ check-dockerfiles: workspace-manifest COPY parity violations found.\n");
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}: ${violation.message}`);
  }
  process.exit(1);
}

console.log(
  `✓ check-dockerfiles: workspace-manifest COPY parity holds across ${dockerfiles.length} frozen-install Dockerfiles`,
);
